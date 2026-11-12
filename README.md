# CIRCUIT

**On-chain financial control for autonomous agent networks on NEAR.**
One treasury, many agents, one limit that every agent is held to.

When many AI agents share a budget, each one usually checks a balance and pays on its own. Run
them concurrently and they all see the same balance, all approve, and together they overspend.
Delegation makes it worse: a sub-agent can hand out more than it was given, a revoked agent
keeps paying, and spend can be split across children to get around per-vendor limits.

CIRCUIT moves the decision into a NEAR smart contract. Agents don't pay; they **reserve**.
The contract checks the reservation against the agent's budget and the policy of every ancestor
in one atomic step, then pays out from a treasury that only the contract controls.

```
three agents, one 1 NEAR budget, concurrent requests for 0.6 / 0.5 / 0.3

without CIRCUIT (shared hot wallet)   →  all three pay           1.4 NEAR spent  (+0.4 over)
with CIRCUIT (contract-held treasury) →  0.5 + 0.3 accepted      0.8 NEAR spent
                                         0.6 rejected: INSUFFICIENT_BUDGET
```

Both rows are real simulator runs on a NEAR node (see [Evidence](#evidence)). Which requests win
depends on the order the chain processes them. The limit holds for every order.

## How it works

```
 Treasury (contract-held NEAR)
   └─ root agent ── allocation 10, vendor cap 6
        ├─ agent A ── allocation 1 ── reserve(0.6 → vendor) ── execute ── payout
        ├─ agent B ── allocation 1
        └─ …            (≤ 4 levels; a parent's limits bind its whole branch)
```

- **Carve-out budgets.** Delegating moves allocation from parent to child, so nothing is ever
  counted twice. A reservation touches only the reserving agent and the global counters, which
  is O(1).
- **Branch-wide checks on every reserve.** The contract walks the agent's ancestors (at most 4):
  - every agent on the path must be active;
  - every ancestor's per-transaction limit and TTL limit apply;
  - every ancestor's **branch-level counterparty cap** applies, so splitting payments across
    children doesn't get around it.
- **Reservation lifecycle:** `RESERVED → EXECUTING → SETTLED`, or `RESERVED → RELEASED`.
  - A payout only becomes final after the contract's own private callback sees the result of
    the transfer. If the transfer fails, the reservation goes back to RESERVED.
  - Expired reservations can be released by anyone, so locked budget can't be hoarded.
- **Idempotent requests.** `(agent, request_id)` is unique. A retry returns the original
  reservation. Reusing the id with different parameters is rejected.
- **Custody guard.** Every state-growing call is paid for by the caller's storage deposit. The
  contract asserts that its free balance still covers everything the treasury owes.
- **Structured rejections:** `CIRCUIT:<CODE>:<detail>`, with 32 codes. A rejected call reverts
  completely and leaves no state behind.

Full design, with nine invariants, alternatives considered and decisions:
[docs/architecture.md](docs/architecture.md). Threats and mitigations:
[docs/threat-model.md](docs/threat-model.md).

## Evidence

Everything below comes from CI runs on GitHub Actions. Nothing is estimated.
Details: [docs/benchmarks.md](docs/benchmarks.md).

| Layer | Result |
|---|---|
| Contract unit tests: attacks, accounting, state machine, storage, custody | 38 passed |
| Property tests: 256 random operation sequences, all invariants rechecked after every step, rollback on rejection | passed |
| Mutation check: a planted accounting bug | caught by both a unit and a property test |
| Sandbox tests on real receipts: payout, forged callback, failed transfer, refunds, revocation, expiry, concurrency | 7 passed |
| Agent simulator (TypeScript, real signed transactions), sandbox **and NEAR testnet** | spec 8/8, concurrency 9/9, attacks 19/19 |

**Concurrency experiment.** 10 agents send 24 requests concurrently (13.8 NEAR requested
against a 10 NEAR treasury, 1 NEAR per agent, 6 NEAR branch cap on one vendor). All 24 landed
in **one block**.
- 5.675 NEAR was accepted and paid out.
- The vendor's balance rose by exactly that amount.
- Every limit held in every ordering tried.
- Gas: `reserve` ≈ 3.6 Tgas, a rejection ≈ 2.6 Tgas, `execute` with callback ≈ 5.45 Tgas.

**NEAR testnet:** all four scenarios passed against deployed contracts: spec 8/8, concurrency 9/9,
attacks 19/19, and the baseline overspent as expected. Contract accounts, CI runs and selected
transaction hashes are in [docs/benchmarks.md](docs/benchmarks.md#near-testnet). The full reports
are in [`evidence/testnet/`](evidence/testnet).

## Repository

| Path | What |
|---|---|
| `contracts/circuit` | Rust contract (near-sdk 5.30) with unit and property tests |
| `tests/sandbox` | Real-transaction integration, adversarial and concurrency tests (near-workspaces) |
| `packages/shared` | Contract types, exact bigint NEAR units, RPC outcome parser, typed client |
| `packages/agent-simulator` | `circuit-sim`: baseline, spec, concurrency and attack scenarios with JSON evidence reports |
| `apps/web` | Next.js site: landing page + read-only console (treasury, agent hierarchy, reservations, evidence viewer) |
| `docs/` | Architecture, threat model, benchmarks |

## Running it

The contract builds and tests on **Linux** (CI does this on every push):

```bash
cargo test -p circuit                                   # unit + property tests
cd contracts/circuit && cargo near build non-reproducible-wasm
CIRCUIT_WASM=$PWD/../../target/near/circuit/circuit.wasm cargo test -p circuit-sandbox-tests
```

The TypeScript side runs anywhere with Node 22 and pnpm:

```bash
pnpm install && pnpm -r build && pnpm -r test

# Simulator against a throwaway local node (Linux/macOS, Node ≥ 22.22.2)
cd packages/agent-simulator
node dist/cli.js all --network sandbox --wasm ../../target/near/circuit/circuit.wasm

# …or against testnet (spends testnet NEAR only)
CIRCUIT_RPC_URL=https://test.rpc.fastnear.com CIRCUIT_FUNDER_ID=you.testnet CIRCUIT_FUNDER_KEY=ed25519:… \
  node dist/cli.js all --network external --scale 0.1 --wasm ../../target/near/circuit/circuit.wasm

# Dashboard
cd apps/web && pnpm dev    # Next.js on :3001 → /console/?contract=<contract account>&network=testnet
```

## Limits (honest scope)

- The MVP handles NEAR only, not fungible tokens. Policies are immutable once set
  (`update_policy` is deferred).
- No off-chain API or indexer. The dashboard reads contract views directly; the simulator reports
  hold the transaction history.
- Concurrency results come from a single-node sandbox. Testnet numbers are reported separately
  and are not comparable.
- The vulnerable baseline models the off-chain race deterministically: every agent reads the
  shared budget before any agent pays. It is labelled as a baseline, not as an attack on any
  real system.
