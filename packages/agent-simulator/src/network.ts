// Where the simulator runs. The simulator only ever holds keys for accounts it created itself
// (or the funding account the operator hands it); it never decides anything the contract decides.

import { readFile } from "node:fs/promises";

import { Account, JsonRpcProvider, KeyPair, actions } from "near-api-js";
import type { KeyPairString } from "near-api-js";

/** The subset of the `near-sandbox` package API the simulator uses. */
interface SandboxModule {
  Sandbox: { start(params: Record<string, unknown>): Promise<{ rpcUrl: string; tearDown(): Promise<void> }> };
  DEFAULT_ACCOUNT_ID: string;
  DEFAULT_PRIVATE_KEY: string;
}
const SANDBOX_MODULE = "near-sandbox";

export interface Network {
  kind: "sandbox" | "external";
  rpcUrl: string;
  provider: JsonRpcProvider;
  /** Funding account: creates every other account and pays for them. */
  funder: Account;
  stop(): Promise<void>;
}

/**
 * `sandbox`: starts a throwaway local node (Linux/macOS only).
 * `external`: uses CIRCUIT_RPC_URL + CIRCUIT_FUNDER_ID + CIRCUIT_FUNDER_KEY (e.g. testnet).
 */
export async function connect(kind: "sandbox" | "external"): Promise<Network> {
  if (kind === "sandbox") {
    // Optional dependency (Linux/macOS, Node >= 22.22.2), loaded only in sandbox mode.
    const mod = (await import(SANDBOX_MODULE)) as SandboxModule;
    const { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } = mod;
    const sandbox = await Sandbox.start({});
    const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
    return {
      kind,
      rpcUrl: sandbox.rpcUrl,
      provider,
      funder: new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY as KeyPairString),
      stop: () => sandbox.tearDown(),
    };
  }
  const rpcUrl = required("CIRCUIT_RPC_URL");
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const funderId = clean(required("CIRCUIT_FUNDER_ID"));
  let key = clean(required("CIRCUIT_FUNDER_KEY"));
  // Accept the bare base58 secret too (the "ed25519:" prefix is often left off when copying).
  if (/^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(key)) key = `ed25519:${key}`;
  // Diagnostics never print any part of the key.
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(key)) {
    // Characters outside the base58 alphabet are by definition not key material, so naming them is safe.
    const body = key.startsWith("ed25519:") ? key.slice(8) : key;
    const bad = [...body].map((c, i) => ({ c, i })).filter(({ c }) => !/[1-9A-HJ-NP-Za-km-z]/.test(c));
    const where = bad.map(({ c, i }) => `${JSON.stringify(c)}@${i}`).join(", ");
    throw new Error(`CIRCUIT_FUNDER_KEY is not an ed25519 private key (length ${key.length}; non-base58 characters: ${where || "none"})`);
  }
  const pair = KeyPair.fromString(key as KeyPairString);
  const funder = new Account(funderId, provider, key as KeyPairString);
  try {
    await funder.getAccessKey(pair.getPublicKey());
  } catch (err) {
    throw new Error(`key ${pair.getPublicKey().toString()} is not an access key of ${funderId}: ${(err as Error).message}`);
  }
  console.log(`funder ${funderId} via ${rpcUrl}, key ${pair.getPublicKey().toString()}`);
  return { kind, rpcUrl, provider, funder, stop: async () => {} };
}

/** Strips whitespace and wrapping quotes that often come along when secrets are pasted. */
function clean(v: string): string {
  return v.trim().replace(/^["']|["']$/g, "").trim();
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
}

/**
 * One on-chain account driven by `lanes` independent access keys, so that up to `lanes`
 * transactions can be in flight at once without nonce collisions (like independent workers).
 */
export class Actor {
  private next = 0;
  constructor(readonly id: string, readonly lanes: Account[]) {}

  /** The signer for the next transaction (round-robin over keys). */
  signer(): Account {
    const a = this.lanes[this.next % this.lanes.length]!;
    this.next += 1;
    return a;
  }
}

let counter = 0;

/** Creates a fresh sub-account of the funder with `lanes` full-access keys. */
export async function createActor(net: Network, prefix: string, balance: bigint, lanes = 1): Promise<Actor> {
  counter += 1;
  const id = `${prefix}${Date.now().toString(36)}${counter}.${net.funder.accountId}`;
  const keys = Array.from({ length: Math.max(1, lanes) }, () => KeyPair.fromRandom("ed25519"));
  await net.funder.signAndSendTransaction({
    receiverId: id,
    waitUntil: "FINAL",
    actions: [
      actions.createAccount(),
      actions.transfer(balance),
      ...keys.map((k) => actions.addFullAccessKey(k.getPublicKey())),
    ],
  });
  return new Actor(id, keys.map((k) => new Account(id, net.provider, k.toString() as KeyPairString)));
}

/** Creates the contract account, deploys the wasm and returns its actor. */
export async function deployContract(net: Network, wasmPath: string, balance: bigint): Promise<Actor> {
  const code = new Uint8Array(await readFile(wasmPath));
  const actor = await createActor(net, "circuit", balance);
  await actor.signer().signAndSendTransaction({ receiverId: actor.id, actions: [actions.deployContract(code)], waitUntil: "FINAL" });
  return actor;
}

export async function balanceOf(net: Network, accountId: string): Promise<bigint> {
  // Liquid balance, the same quantity the contract sees as env::account_balance().
  return (await net.provider.viewAccount({ accountId })).amount;
}
