# Demo script (about 3 minutes)

Before recording:
- Open the console on the concurrency contract: `/console/?contract=<id>&network=testnet`.
- Load the four testnet reports into the Evidence tab, or open the Pages URL, which bundles them.
- Keep a terminal in `packages/agent-simulator` with the testnet environment variables set.
- Keep the README and `evidence/testnet/` open in the GitHub repo.

Every number you say on camera must come from a report or the dashboard; none are invented. Where the
script says *[from report]*, read the real value.

---

## 0:00–0:25: The problem

**Show:** the README headline.

> AI agents increasingly spend money on their own. When many of them share one budget, each
> agent checks the balance and pays on its own. Run them at the same time and they all see the
> same balance, all approve, and together they overspend. Delegation makes it worse: a
> sub-agent hands out more than it got, a revoked agent keeps paying, and spend gets split
> across children to dodge per-vendor limits.

## 0:25–0:50: The failure, live

**Show:** the Evidence tab, **baseline** report (or run `node dist/cli.js baseline --network external --scale 0.1`).

> Here are three agents with one budget, requesting 0.6, 0.5 and 0.3, paid from a shared
> wallet. Each checked the budget, each saw room, and all three paid: *[from report: paid X
> against Y]*. That's 40% over budget.

Say once: *this baseline models the race deterministically; it is the pattern we replace, not
a specific product.*

## 0:50–1:20: CIRCUIT: the same requests, one enforced limit

**Show:** the **spec** report: checks list, then the transaction table with explorer links.

> Same agents, same requests, but now the budget lives in a NEAR contract. Agents don't pay,
> they *reserve*. The contract checks the agent's budget and every ancestor's policy in one
> atomic step. The 0.5 and 0.3 got through, and the 0.6 was rejected with
> `INSUFFICIENT_BUDGET`. Each vendor received exactly what was reserved. Here is the
> transaction on the testnet explorer.

**Click** one tx hash so the explorer opens.

## 1:20–1:55: Under real concurrency

**Show:** the **concurrency** report metrics, then switch to **Live state** on that contract.

> Ten agents, 24 requests fired at once: *[from report: requested]* against a 10-scale
> treasury, with each agent capped at its own allocation and the whole branch capped per vendor.
> *[accepted]* accepted, *[rejected]* rejected, and every rejection has a reason code. On the
> sandbox, all 24 landed in a single block. The limit held in every ordering we tried.

**On the dashboard:**
- Point at the treasury bar: spent vs reserved vs remaining.
- Point at the hierarchy: one root and ten agents, each bar showing its own budget.
- Click an agent to show its policy.

## 1:55–2:35: Attacks

**Show:** the **attacks** report checks. Scroll slowly and name each one.

> We also attacked it with real transactions:
> - delegating more than you have, or looser than your parent: rejected;
> - the same invoice five times at once: exactly one reservation;
> - forging the payout callback as the agent, the owner and an outsider: the method is
>   private;
> - splitting payments across four children to dodge a vendor cap: capped at the branch
>   limit;
> - revoking a middle agent: everything below it freezes instantly, and a healthy ancestor
>   can still release funds;
> - hoarding budget: it expires and anyone can free it;
> - paying a non-existent account: the transfer fails, the money returns, and the
>   reservation reopens.
>
> After every scenario the simulator rechecks the treasury invariants against the contract's
> real balance.

## 2:35–3:00: Why you can trust it

**Show:** README → Evidence table, then `docs/benchmarks.md`.

> All of this runs in CI on every push: 38 unit tests, property tests that replay hundreds of
> random operation sequences and recheck nine invariants after every step, sandbox tests on
> real receipts, and the simulator. We planted a bug to prove the tests catch it, and they did.
>
> CIRCUIT: one treasury, many agents, one enforceable limit.

---

## Fallbacks

- **Testnet RPC slow or failing on camera:** show the committed reports in `evidence/testnet/`
  and the CI run links in `docs/benchmarks.md` instead of running live.
- **Dashboard empty:** check that `?contract=` is the concurrency contract and `network=testnet`.
  The status pill in the top right shows any RPC error.
- **Don't** claim mainnet readiness, fungible-token support or an indexer. See README → Limits.
