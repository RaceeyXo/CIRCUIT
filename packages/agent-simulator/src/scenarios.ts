// Agent-network scenarios. Agents are real NEAR accounts that sign their own transactions;
// several in-flight transactions per agent use separate access keys, like separate workers.
// The simulator generates load and records outcomes. Every decision is the contract's.

import { CircuitClient, parseNear, type PolicyJson, type TxOutcome } from "@circuit/shared";

import { Evidence, near } from "./evidence.js";
import { checkInvariants } from "./invariants.js";
import { Actor, balanceOf, createActor, deployContract, type Network } from "./network.js";

const SEC = 1_000_000_000n;
const HOUR = 3_600n * SEC;

export interface Ctx {
  net: Network;
  client: CircuitClient;
  owner: Actor;
  contract: Actor;
  ev: Evidence;
}

export function policy(p: Partial<Record<keyof PolicyJson, bigint | number>> = {}): PolicyJson {
  const big = parseNear("1000");
  return {
    max_tx_amount: String(p.max_tx_amount ?? big),
    max_pending_amount: String(p.max_pending_amount ?? big),
    max_pending_count: Number(p.max_pending_count ?? 100),
    max_counterparty_exposure: String(p.max_counterparty_exposure ?? big),
    max_delegated: String(p.max_delegated ?? big),
    max_reservation_ttl_ns: String(p.max_reservation_ttl_ns ?? 24n * HOUR),
  };
}

/** Deploys a fresh contract, initialises it and funds the treasury with `budget`. */
export async function setup(net: Network, wasm: string, scenario: string, budget: bigint): Promise<Ctx> {
  const owner = await createActor(net, "owner", budget + parseNear("5"));
  const contract = await deployContract(net, wasm, parseNear("5"));
  const client = new CircuitClient(net.rpcUrl, contract.id);
  const ev = new Evidence(scenario, net.kind, contract.id);
  must(ev.record("setup", contract.id, "new", await client.init(contract.signer(), owner.id)));
  must(ev.record("setup", owner.id, "fund_treasury", await client.fundTreasury(owner.signer(), budget)));
  return { net, client, owner, contract, ev };
}

function must<T>(out: TxOutcome<T>): TxOutcome<T> {
  if (!out.ok) throw new Error(`setup transaction failed: ${out.rejection?.code ?? out.error}`);
  return out;
}

async function register(ctx: Ctx, by: Actor, agent: Actor, parent: Actor | null, p: PolicyJson, alloc: bigint) {
  return ctx.ev.record("setup", by.id, "register_agent", await ctx.client.registerAgent(by.signer(), agent.id, parent?.id ?? null, p, alloc));
}

interface Req {
  agent: Actor;
  requestId: string;
  counterparty: string;
  amount: bigint;
}

interface Timed<T> {
  req: Req;
  out: TxOutcome<T>;
  ms: number;
}

/** Submits every request at once; nothing waits for another request's result. */
async function reserveAll(ctx: Ctx, step: string, reqs: Req[], ttl = HOUR): Promise<Timed<import("@circuit/shared").ReserveResult>[]> {
  return Promise.all(
    reqs.map(async (req) => {
      const t0 = Date.now();
      const out = await ctx.client.reserve(req.agent.signer(), req.requestId, req.counterparty, req.amount, ttl);
      const ms = Date.now() - t0;
      ctx.ev.record(step, req.agent.id, "reserve", out);
      return { req, out, ms };
    }),
  );
}

async function executeAll(ctx: Ctx, step: string, accepted: Timed<import("@circuit/shared").ReserveResult>[]) {
  return Promise.all(
    accepted.map(async ({ req, out }) => {
      const id = out.value!.reservation.id;
      const t0 = Date.now();
      const ex = await ctx.client.execute(req.agent.signer(), id);
      ctx.ev.record(step, req.agent.id, "execute", ex);
      return { req, id, ex, ms: Date.now() - t0 };
    }),
  );
}

function stats(xs: number[]) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pct = (p: number) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
  return { count: s.length, min: s[0], p50: pct(50), p95: pct(95), max: s[s.length - 1] };
}

function gasStats(outs: TxOutcome<unknown>[]) {
  const tg = outs.map((o) => Number(o.gasBurnt / 1_000_000_000n) / 1_000); // Tgas, 3 decimals
  return stats(tg);
}

function codes(outs: TxOutcome<unknown>[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const o of outs) if (!o.ok) c[o.rejection?.code ?? "OTHER"] = (c[o.rejection?.code ?? "OTHER"] ?? 0) + 1;
  return c;
}

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

// ── Scenario 1: the specification example ────────────────────────────────────

/** Three workers share one 1 NEAR allocation and concurrently ask for 0.6, 0.5 and 0.3. */
export async function specScenario(net: Network, wasm: string): Promise<Evidence> {
  const budget = parseNear("1");
  const ctx = await setup(net, wasm, "spec", budget);
  const { client, ev } = ctx;
  const pool = await createActor(net, "pool", parseNear("3"), 3);
  const vendors = await Promise.all(["va", "vb", "vc"].map((p) => createActor(net, p, parseNear("1"))));
  must(await register(ctx, ctx.owner, pool, null, policy(), budget));

  const amounts = [parseNear("0.6"), parseNear("0.5"), parseNear("0.3")];
  const reqs = amounts.map((amount, i) => ({ agent: pool, requestId: `worker-${i}`, counterparty: vendors[i]!.id, amount }));
  const results = await reserveAll(ctx, "reserve", reqs);
  const accepted = results.filter((r) => r.out.ok);
  const acceptedSum = sum(accepted.map((r) => r.req.amount));
  const rejected = results.filter((r) => !r.out.ok);

  ev.check("requests over-subscribe the allocation", sum(amounts) > budget, `${near(sum(amounts))} requested vs ${near(budget)}`);
  ev.check("accepted total ≤ allocation", acceptedSum <= budget, `${near(acceptedSum)} accepted`);
  ev.check(
    "every rejection is INSUFFICIENT_BUDGET",
    rejected.every((r) => r.out.rejection?.code === "INSUFFICIENT_BUDGET"),
    rejected.map((r) => `${near(r.req.amount)}: ${r.out.rejection?.code}`).join(", ") || "none",
  );
  // No accepted set can be extended by a rejected request without exceeding the budget.
  ev.check(
    "no request was rejected that would have fit",
    rejected.every((r) => acceptedSum + r.req.amount > budget),
    "each rejected request exceeds the remaining budget at decision time",
  );

  const before = await Promise.all(accepted.map((r) => balanceOf(net, r.req.counterparty)));
  const executed = await executeAll(ctx, "execute", accepted);
  const after = await Promise.all(accepted.map((r) => balanceOf(net, r.req.counterparty)));
  ev.check("all accepted payouts settle", executed.every((e) => e.ex.ok && e.ex.value === true), executed.map((e) => `#${e.id}: ${e.ex.value}`).join(", "));
  ev.check(
    "each vendor received exactly its reserved amount",
    accepted.every((r, i) => after[i]! - before[i]! === r.req.amount),
    accepted.map((r, i) => `${near(after[i]! - before[i]!)}`).join(", "),
  );
  const t = await client.getTreasury();
  ev.check("treasury spent equals accepted total", BigInt(t.total_spent) === acceptedSum, `spent ${near(BigInt(t.total_spent))}`);
  await checkInvariants(ev, net, client, "after spec");
  ev.metrics.accepted = accepted.map((r) => near(r.req.amount));
  ev.metrics.rejected = rejected.map((r) => near(r.req.amount));
  return ev;
}

// ── Scenario 2: concurrency experiment ──────────────────────────────────────

/** Deterministic PRNG so a run's amounts and submission order are reproducible from its seed. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

export async function concurrencyScenario(net: Network, wasm: string, seed = 0x5eed): Promise<Evidence> {
  const AGENTS = 10;
  const REQUESTS = 24;
  const budget = parseNear("10");
  const childAlloc = parseNear("1");
  const vendorCap = parseNear("6");
  const ctx = await setup(net, wasm, "concurrency", budget);
  const { client, ev } = ctx;
  const next = rng(seed);

  const root = await createActor(net, "root", parseNear("5"));
  const vendor = await createActor(net, "vendor", parseNear("1"));
  must(await register(ctx, ctx.owner, root, null, policy({ max_counterparty_exposure: vendorCap }), budget));
  const lanes = Math.ceil(REQUESTS / AGENTS);
  const agents = await Promise.all(Array.from({ length: AGENTS }, () => createActor(net, "agent", parseNear("2"), lanes)));
  for (const a of agents) {
    must(await register(ctx, root, a, root, policy({ max_tx_amount: childAlloc, max_counterparty_exposure: vendorCap, max_delegated: 0 }), childAlloc));
  }

  const reqs: Req[] = Array.from({ length: REQUESTS }, (_, k) => ({
    agent: agents[k % AGENTS]!,
    requestId: `job-${seed}-${k}`,
    counterparty: vendor.id,
    amount: BigInt(300 + (next() % 551)) * parseNear("0.001"),
  }));
  for (let i = reqs.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [reqs[i], reqs[j]] = [reqs[j]!, reqs[i]!];
  }
  const requested = sum(reqs.map((r) => r.amount));

  const t0 = Date.now();
  const results = await reserveAll(ctx, "reserve", reqs);
  const wallMs = Date.now() - t0;
  const accepted = results.filter((r) => r.out.ok);
  const acceptedSum = sum(accepted.map((r) => r.req.amount));
  const t = await client.getTreasury();
  const exposure = BigInt(await client.getExposure(root.id, vendor.id));

  ev.check("requests over-subscribe the treasury", requested > budget, `${near(requested)} requested vs ${near(budget)} budget`);
  ev.check("accepted ≤ treasury budget", acceptedSum <= budget, near(acceptedSum));
  ev.check("accepted ≤ branch vendor cap", acceptedSum <= vendorCap, `${near(acceptedSum)} ≤ ${near(vendorCap)}`);
  ev.check("contract state matches observed outcomes", BigInt(t.total_reserved) === acceptedSum && exposure === acceptedSum, `reserved ${near(BigInt(t.total_reserved))}, exposure ${near(exposure)}`);
  for (const a of agents) {
    const mine = sum(accepted.filter((r) => r.req.agent === a).map((r) => r.req.amount));
    if (mine > childAlloc) ev.check(`agent ${a.id} within its allocation`, false, near(mine));
  }
  ev.check("every agent within its own allocation", true, `${AGENTS} agents checked`);
  await checkInvariants(ev, net, client, "after concurrent reservations");

  const before = await balanceOf(net, vendor.id);
  const executed = await executeAll(ctx, "execute", accepted);
  const after = await balanceOf(net, vendor.id);
  const settled = executed.filter((e) => e.ex.ok && e.ex.value === true);
  ev.check("all accepted payouts settle", settled.length === accepted.length, `${settled.length}/${accepted.length}`);
  ev.check("vendor received exactly the accepted total", after - before === acceptedSum, near(after - before));
  await checkInvariants(ev, net, client, "after concurrent payouts");

  const blocks = new Set(results.map((r) => r.out.blockHash));
  ev.metrics.experiment = {
    seed: `0x${seed.toString(16)}`,
    agents: AGENTS,
    requests: REQUESTS,
    keys_per_agent: lanes,
    budget: near(budget),
    child_allocation: near(childAlloc),
    branch_vendor_cap: near(vendorCap),
    total_requested: near(requested),
    total_accepted: near(acceptedSum),
    total_rejected: near(requested - acceptedSum),
    accepted_count: accepted.length,
    rejected_count: results.length - accepted.length,
    rejections_by_code: codes(results.map((r) => r.out)),
    treasury_remaining_after_payouts: near(BigInt((await client.getTreasury()).remaining)),
    distinct_inclusion_blocks: blocks.size,
    submission_wall_clock_ms: wallMs,
    reserve_latency_ms: stats(results.map((r) => r.ms)),
    execute_latency_ms: stats(executed.map((e) => e.ms)),
    reserve_gas_tgas_accepted: gasStats(accepted.map((r) => r.out)),
    reserve_gas_tgas_rejected: gasStats(results.filter((r) => !r.out.ok).map((r) => r.out)),
    execute_gas_tgas: gasStats(executed.map((e) => e.ex)),
  };
  return ev;
}

// ── Scenario 3: adversarial agents ──────────────────────────────────────────

export async function attackScenario(net: Network, wasm: string): Promise<Evidence> {
  const budget = parseNear("10");
  const ctx = await setup(net, wasm, "attacks", budget);
  const { client, ev, owner } = ctx;
  const vendor = await createActor(net, "vendor", parseNear("1"));
  const stranger = await createActor(net, "stranger", parseNear("1"));

  // Hierarchy: root → mid → leaf, plus root → 4 splitter children.
  const root = await createActor(net, "root", parseNear("3"));
  const mid = await createActor(net, "mid", parseNear("3"));
  const leaf = await createActor(net, "leaf", parseNear("3"), 5);
  must(await register(ctx, owner, root, null, policy({ max_counterparty_exposure: parseNear("0.3") }), parseNear("8")));
  must(await register(ctx, root, mid, root, policy({ max_counterparty_exposure: parseNear("0.3"), max_delegated: parseNear("1") }), parseNear("2")));
  must(await register(ctx, mid, leaf, mid, policy({ max_counterparty_exposure: parseNear("0.3"), max_delegated: 0 }), parseNear("1")));

  // A. Delegation escalation: a child cannot give away more than it has, or exceed its policy.
  const greedy = await createActor(net, "greedy", parseNear("1"));
  const esc = ev.record("escalation", mid.id, "register_agent", await client.registerAgent(mid.signer(), greedy.id, mid.id, policy({ max_counterparty_exposure: parseNear("0.3"), max_delegated: 0 }), parseNear("2.5")));
  ev.check("A. delegation beyond available budget rejected", esc.rejection?.code === "INSUFFICIENT_BUDGET", esc.rejection?.code ?? "accepted!");
  const loose = ev.record("escalation", mid.id, "register_agent", await client.registerAgent(mid.signer(), greedy.id, mid.id, policy(), parseNear("0.1")));
  ev.check("A. child policy looser than parent rejected", loose.rejection?.code === "POLICY_EXCEEDS_PARENT", loose.rejection?.code ?? "accepted!");
  const self = ev.record("escalation", leaf.id, "delegate_budget", await client.delegateBudget(leaf.signer(), leaf.id, parseNear("0.1")));
  ev.check("A. agent cannot top up its own budget", self.rejection?.code === "UNAUTHORIZED", self.rejection?.code ?? "accepted!");

  // B. Duplicate flood: the same request sent 5 times concurrently creates one commitment.
  const dupes = await reserveAll(ctx, "duplicates", Array.from({ length: 5 }, () => ({ agent: leaf, requestId: "invoice-42", counterparty: vendor.id, amount: parseNear("0.1") })));
  const ids = new Set(dupes.filter((d) => d.out.ok).map((d) => d.out.value!.reservation.id));
  const fresh = dupes.filter((d) => d.out.ok && d.out.value!.duplicate === false).length;
  const leafView = await client.getAgent(leaf.id);
  ev.check("B. 5 concurrent duplicates → exactly one reservation", ids.size === 1 && fresh === 1 && leafView!.reserved === parseNear("0.1").toString(), `ids ${[...ids].join(",")}, new ${fresh}, reserved ${near(BigInt(leafView!.reserved))}`);
  const dupId = [...ids][0]!;
  const conflict = ev.record("duplicates", leaf.id, "reserve", await client.reserve(leaf.signer(), "invoice-42", vendor.id, parseNear("0.2"), HOUR));
  ev.check("B. reused request id with different amount rejected", conflict.rejection?.code === "REQUEST_ID_CONFLICT", conflict.rejection?.code ?? "accepted!");

  // C. Forged settlement: nobody but the contract can deliver a payout result.
  for (const forger of [leaf, owner, stranger]) {
    const forged = ev.record("forged-callback", forger.id, "on_execute", await client.call(forger.signer(), "on_execute", { reservation_id: dupId }));
    ev.check(`C. forged on_execute by ${forger === owner ? "owner" : forger === leaf ? "agent" : "outsider"} rejected`, !forged.ok && (forged.error ?? "").includes("private"), forged.ok ? "accepted!" : "method is private");
  }
  const still = await client.getReservation(dupId);
  ev.check("C. reservation untouched by forgeries", still!.status === "Reserved", still!.status);

  // D. Counterparty splitting: root's 0.3 NEAR cap on one sink binds all its children.
  const splitters = await Promise.all(Array.from({ length: 4 }, () => createActor(net, "split", parseNear("1"))));
  for (const s of splitters) must(await register(ctx, root, s, root, policy({ max_counterparty_exposure: parseNear("0.3"), max_delegated: 0 }), parseNear("0.2")));
  const sink = await createActor(net, "sink", parseNear("1"));
  const split = await reserveAll(ctx, "splitting", splitters.map((s, i) => ({ agent: s, requestId: `split-${i}`, counterparty: sink.id, amount: parseNear("0.15") })));
  const splitAccepted = sum(split.filter((r) => r.out.ok).map((r) => r.req.amount));
  const rootExposure = BigInt(await client.getExposure(root.id, sink.id));
  ev.check("D. splitting across 4 children capped at the branch limit", splitAccepted <= parseNear("0.3") && rootExposure === splitAccepted, `accepted ${near(splitAccepted)}, codes ${JSON.stringify(codes(split.map((r) => r.out)))}`);

  // E. Revocation: revoking `mid` freezes `leaf` below it, including its open reservation.
  ev.record("revocation", root.id, "revoke_agent", await client.revokeAgent(root.signer(), mid.id));
  const r1 = ev.record("revocation", leaf.id, "reserve", await client.reserve(leaf.signer(), "after-revoke", vendor.id, parseNear("0.01"), HOUR));
  ev.check("E. descendant of revoked agent cannot reserve", r1.rejection?.code === "ANCESTOR_REVOKED", r1.rejection?.code ?? "accepted!");
  const r2 = ev.record("revocation", leaf.id, "execute", await client.execute(leaf.signer(), dupId));
  ev.check("E. descendant of revoked agent cannot execute", r2.rejection?.code === "ANCESTOR_REVOKED", r2.rejection?.code ?? "accepted!");
  const r3 = ev.record("revocation", mid.id, "reserve", await client.reserve(mid.signer(), "self", vendor.id, parseNear("0.01"), HOUR));
  ev.check("E. revoked agent cannot reserve", r3.rejection?.code === "AGENT_REVOKED", r3.rejection?.code ?? "accepted!");
  const rel = ev.record("revocation", root.id, "release", await client.release(root.signer(), dupId));
  ev.check("E. healthy ancestor can release the frozen reservation", rel.ok && rel.value?.release_reason === "Ancestor", rel.ok ? rel.value!.release_reason ?? "" : rel.rejection?.code ?? "");

  // F. Hoarding: reserve the whole budget with a short TTL; it expires and anyone can free it.
  const hoarder = await createActor(net, "hoard", parseNear("2"));
  must(await register(ctx, owner, hoarder, null, policy(), parseNear("0.5")));
  const h = ev.record("hoarding", hoarder.id, "reserve", await client.reserve(hoarder.signer(), "hoard", vendor.id, parseNear("0.5"), 3n * SEC));
  const blocked = ev.record("hoarding", hoarder.id, "reserve", await client.reserve(hoarder.signer(), "next", vendor.id, 1n, HOUR));
  ev.check("F. budget locked while reservation is live", blocked.rejection?.code === "INSUFFICIENT_BUDGET", blocked.rejection?.code ?? "accepted!");
  await new Promise((r) => setTimeout(r, 6_000));
  const late = ev.record("hoarding", hoarder.id, "execute", await client.execute(hoarder.signer(), h.value!.reservation.id));
  ev.check("F. expired reservation cannot be paid out", late.rejection?.code === "RESERVATION_EXPIRED", late.rejection?.code ?? "accepted!");
  const freed = ev.record("hoarding", stranger.id, "release_expired", await client.releaseExpired(stranger.signer(), [h.value!.reservation.id]));
  ev.check("F. anyone can release an expired reservation", freed.ok && freed.value?.length === 1, JSON.stringify(freed.value));

  // G. Payment to a missing account: the transfer fails, funds return, reservation reopens.
  const ghost = `ghost${Date.now()}.${net.funder.accountId}`;
  const g = ev.record("failed-transfer", hoarder.id, "reserve", await client.reserve(hoarder.signer(), "ghost", ghost, parseNear("0.2"), HOUR));
  const gx = ev.record("failed-transfer", hoarder.id, "execute", await client.execute(hoarder.signer(), g.value!.reservation.id));
  const gv = await client.getReservation(g.value!.reservation.id);
  ev.check("G. failed transfer returns reservation to Reserved", gx.ok && gx.value === false && gv!.status === "Reserved" && gv!.failed_attempts === 1, `settled=${gx.value}, status ${gv!.status}, attempts ${gv!.failed_attempts}`);

  await checkInvariants(ev, net, client, "after all attacks");
  return ev;
}
