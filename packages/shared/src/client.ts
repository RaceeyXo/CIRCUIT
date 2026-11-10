// Thin typed client for the CIRCUIT contract. It never decides anything: it submits signed
// transactions and reports exactly what the chain returned.

import { Account, JsonRpcProvider, actions } from "near-api-js";
import type { KeyPairString } from "near-api-js";

import { interpretOutcome, type TxOutcome } from "./outcome.js";
import type { AgentView, PolicyJson, ReservationView, ReserveResult, TreasuryView } from "./types.js";
import { TGAS } from "./units.js";

/** Storage deposit attached to state-growing calls; the contract refunds the excess. */
export const STORAGE_DEPOSIT = 100_000_000_000_000_000_000_000n; // 0.1 NEAR
export const DEFAULT_GAS = 30n * TGAS;
export const EXECUTE_GAS = 100n * TGAS;

export class CircuitClient {
  readonly provider: JsonRpcProvider;

  constructor(readonly rpcUrl: string, readonly contractId: string) {
    this.provider = new JsonRpcProvider({ url: rpcUrl });
  }

  account(accountId: string, key: KeyPairString): Account {
    return new Account(accountId, this.provider, key);
  }

  async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return (await this.provider.callFunction({ contractId: this.contractId, method, args })) as T;
  }

  /** Signs and sends one function call; never throws for on-chain failures. */
  async call<T = unknown>(
    signer: Account,
    method: string,
    args: Record<string, unknown>,
    opts: { deposit?: bigint; gas?: bigint } = {},
  ): Promise<TxOutcome<T>> {
    const raw = await signer.signAndSendTransaction({
      receiverId: this.contractId,
      actions: [actions.functionCall(method, args, opts.gas ?? DEFAULT_GAS, opts.deposit ?? 0n)],
      throwOnFailure: false,
    });
    return interpretOutcome<T>(raw);
  }

  // ── Views ──────────────────────────────────────────────────────────────
  getTreasury() {
    return this.view<TreasuryView>("get_treasury");
  }
  getAgent(agent: string) {
    return this.view<AgentView | null>("get_agent", { agent });
  }
  async getAllAgents(): Promise<AgentView[]> {
    const out: AgentView[] = [];
    for (let from = 0; ; from += 100) {
      const page = await this.view<AgentView[]>("get_agents", { from_index: from, limit: 100 });
      out.push(...page);
      if (page.length < 100) return out;
    }
  }
  getReservation(id: string | bigint) {
    return this.view<ReservationView | null>("get_reservation", { reservation_id: String(id) });
  }
  async getAllReservations(): Promise<ReservationView[]> {
    const { reservation_count } = await this.getTreasury();
    const out: ReservationView[] = [];
    for (let from = 0; from < reservation_count; from += 100) {
      out.push(...(await this.view<ReservationView[]>("get_reservations", { from_id: String(from), limit: 100 })));
    }
    return out;
  }
  getExposure(agent: string, counterparty: string) {
    return this.view<string>("get_exposure", { agent, counterparty });
  }

  // ── Mutations ──────────────────────────────────────────────────────────
  init(signer: Account, owner: string) {
    return this.call(signer, "new", { owner });
  }
  fundTreasury(owner: Account, amount: bigint) {
    return this.call<TreasuryView>(owner, "fund_treasury", {}, { deposit: amount });
  }
  registerAgent(by: Account, agentId: string, parent: string | null, policy: PolicyJson, allocation: bigint) {
    return this.call<AgentView>(
      by,
      "register_agent",
      { agent_id: agentId, parent, policy, allocation: allocation.toString() },
      { deposit: STORAGE_DEPOSIT },
    );
  }
  delegateBudget(by: Account, child: string, amount: bigint) {
    return this.call<AgentView>(by, "delegate_budget", { child, amount: amount.toString() });
  }
  reclaimBudget(by: Account, child: string, amount: bigint) {
    return this.call<AgentView>(by, "reclaim_budget", { child, amount: amount.toString() });
  }
  revokeAgent(by: Account, agent: string) {
    return this.call<AgentView>(by, "revoke_agent", { agent });
  }
  reserve(agent: Account, requestId: string, counterparty: string, amount: bigint, ttlNs: bigint) {
    return this.call<ReserveResult>(
      agent,
      "reserve",
      { request_id: requestId, counterparty, amount: amount.toString(), ttl_ns: ttlNs.toString() },
      { deposit: STORAGE_DEPOSIT },
    );
  }
  execute(agent: Account, reservationId: string) {
    return this.call<boolean>(agent, "execute", { reservation_id: reservationId }, { gas: EXECUTE_GAS });
  }
  release(by: Account, reservationId: string) {
    return this.call<ReservationView>(by, "release", { reservation_id: reservationId });
  }
  releaseExpired(by: Account, ids: string[]) {
    return this.call<string[]>(by, "release_expired", { reservation_ids: ids });
  }
  setPaused(owner: Account, paused: boolean) {
    return this.call(owner, "set_paused", { paused });
  }
}
