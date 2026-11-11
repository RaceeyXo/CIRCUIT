// Recomputes the treasury invariants (architecture §4.2) from the contract's public views and
// the contract account's real balance. Read-only: it judges the contract, it never steers it.

import type { AgentView, CircuitClient, TreasuryView } from "@circuit/shared";

import type { Evidence } from "./evidence.js";
import type { Network } from "./network.js";

const STORAGE_PRICE_PER_BYTE = 10n ** 19n;

export function checkAccounting(t: TreasuryView, agents: AgentView[]): string[] {
  const errors: string[] = [];
  const b = (s: string) => BigInt(s);
  let spent = 0n;
  let reserved = 0n;
  let top = 0n;
  for (const a of agents) {
    const committed = b(a.spent) + b(a.reserved) + b(a.delegated);
    if (committed > b(a.allocation)) errors.push(`I1 ${a.id}: committed ${committed} > allocation ${a.allocation}`);
    if (b(a.available) !== b(a.allocation) - committed) errors.push(`available mismatch ${a.id}`);
    const children = agents.filter((c) => c.parent === a.id).reduce((s, c) => s + b(c.allocation), 0n);
    if (children !== b(a.delegated)) errors.push(`I2 ${a.id}: delegated ${a.delegated} ≠ Σchildren ${children}`);
    if (a.parent === null) top += b(a.allocation);
    spent += b(a.spent);
    reserved += b(a.reserved);
  }
  if (top !== b(t.allocated)) errors.push(`I3 allocated ${t.allocated} ≠ Σtop-level ${top}`);
  if (b(t.allocated) > b(t.total_budget)) errors.push(`I3 allocated > budget`);
  if (spent !== b(t.total_spent)) errors.push(`I4 total_spent ${t.total_spent} ≠ Σspent ${spent}`);
  if (reserved !== b(t.total_reserved)) errors.push(`I4 total_reserved ${t.total_reserved} ≠ Σreserved ${reserved}`);
  if (spent + reserved > b(t.total_budget)) errors.push(`I5 spent + reserved > budget`);
  return errors;
}

export async function checkInvariants(ev: Evidence, net: Network, client: CircuitClient, label: string): Promise<boolean> {
  const [t, agents] = await Promise.all([client.getTreasury(), client.getAllAgents()]);
  const errors = checkAccounting(t, agents);

  // I8 custody: the account's free balance covers every unspent treasury obligation.
  const state = await net.provider.viewAccount({ accountId: client.contractId });
  const storage = BigInt(state.storage_usage) * STORAGE_PRICE_PER_BYTE;
  const free = state.amount - storage;
  const liabilities = BigInt(t.total_budget) - BigInt(t.total_spent) - BigInt(t.in_flight);
  if (free < liabilities) errors.push(`I8 free balance ${free} < liabilities ${liabilities}`);

  return ev.check(`invariants (${label})`, errors.length === 0, errors.length ? errors.join("; ") : `I1–I5, I8 hold over ${agents.length} agents`);
}
