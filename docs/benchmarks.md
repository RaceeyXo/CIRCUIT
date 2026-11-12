# Benchmarks and experiment results

Every number in this file comes from a recorded run. Each section names its source. Nothing here
is an estimate.

## NEAR testnet

Every scenario passed against contracts deployed on NEAR testnet. The full reports, with every
transaction hash, are in [`evidence/testnet/`](../evidence/testnet). Amounts are scaled down to
save faucet NEAR; scaling changes magnitudes only, never the checks.

| Scenario | Contract | Result | Txs | CI run |
|---|---|---|---|---|
| baseline (no CIRCUIT) | `hotwalletmwdgni7f1.circuit-demo.testnet` (plain wallet) | overspent 0.14 vs 0.10, as expected | 3 | [43208727340](https://github.com/RaceeyXo/CIRCUIT/actions/runs/43208727340) |
| spec 0.6 / 0.5 / 0.3 | [`circuitmwdgnus36.circuit-demo.testnet`](https://testnet.nearblocks.io/address/circuitmwdgnus36.circuit-demo.testnet) | 8/8 | 8 | [43208727340](https://github.com/RaceeyXo/CIRCUIT/actions/runs/43208727340) |
| concurrency: 10 agents, 24 requests | [`circuitmwdgosbr12.circuit-demo.testnet`](https://testnet.nearblocks.io/address/circuitmwdgosbr12.circuit-demo.testnet) | 9/9 | 48 | [43208727340](https://github.com/RaceeyXo/CIRCUIT/actions/runs/43208727340) |
| attacks: escalation, duplicates, forged callback, splitting, revocation, hoarding, failed transfer | [`circuitmwdkvj042.circuit-demo.testnet`](https://testnet.nearblocks.io/address/circuitmwdkvj042.circuit-demo.testnet) | 19/19 | 37 | [43226562697](https://github.com/RaceeyXo/CIRCUIT/actions/runs/43226562697) |

Selected testnet transactions (open on [testnet.nearblocks.io](https://testnet.nearblocks.io)):

| What | Outcome | Tx |
|---|---|---|
| Forged payout callback, sent by the agent | rejected: method is private | `E3Eq3raSmUxYXAjd4QUMPjGNzLvChf9jfKFNd47CyAG8` |
| Forged payout callback, sent by the owner | rejected: method is private | `Ei8dHL735xxdspz72Q7Y2Y7xdhDveakZk9rLQPu98QFK` |
| Reserve by a descendant of a revoked agent | `ANCESTOR_REVOKED` | `8vxuGBZMGZsKj5BQCXm2jxtJ8rB1q7shBoLCatE9U7UZ` |
| Execute by a descendant of a revoked agent | `ANCESTOR_REVOKED` | `Hk9uE5GN1af1FiGL4cY5Pk1pnnmBCYgSimC86hoKT9Z6` |
| Reused request id with a different amount | `REQUEST_ID_CONFLICT` | `2CSog8HGHGEzPCNqVrK8CwWY8pBPrLR2UidnPQcnVAyP` |

Testnet concurrency run (scale 0.1, seed `0x5eed`): 1.3815 NEAR requested against a 1.0 NEAR
treasury, 0.5728 accepted (11 requests, all settled), 13 rejected (5 `INSUFFICIENT_BUDGET`, 8
`COUNTERPARTY_LIMIT`), across 3 blocks. `reserve` gas about 4.0 Tgas (rejection about 2.6), `execute`
about 5.8 Tgas. Time to final: p50 4.45 s for `reserve`, 5.37 s for `execute`.

## Environment

| | |
|---|---|
| Chain | near-workspaces sandbox: a local, single-node NEAR network |
| Host | GitHub Actions `ubuntu-latest` |
| Contract | `circuit.wasm`, 230,001 bytes, sha256 prefix `834ebd8522ac8615` |
| Source | CI run [42815586711](https://github.com/RaceeyXo/CIRCUIT/actions/runs/42815586711), `tests/sandbox` |

A single local node shows contract logic, gas and atomicity under real receipts. It does not
show network latency or behaviour across shards.

## Gas (sandbox, measured)

| Operation | Gas burnt |
|---|---|
| `reserve`, accepted | 3.58–3.64 Tgas (mean ≈ 3.60, over 30 accepted requests) |
| `reserve`, rejected | 2.56–2.57 Tgas (over 42 rejected requests) |
| `execute` (transfer plus callback) | 5.43–5.49 Tgas (10 samples, simulator run 43079101112) |

An agent pays about 0.00358 NEAR per accepted `reserve`, gas and storage combined: 3,580,553,369,769,200,000,000 yocto.
The rest of the 0.1 NEAR deposit is refunded. A rejected request costs only gas, because the
deposit comes back with the failed receipt.

## Concurrency experiment (spec §8)

Setup:
- One root agent holds the entire 10 NEAR treasury.
- Ten child agents get 1 NEAR each.
- The root's policy caps the whole branch's exposure to one shared vendor at 6 NEAR.
- 24 requests of 0.300–0.850 NEAR are submitted **concurrently**.
- Each agent signs with several access keys, so no transaction waits on another.
- Three rounds use different seeded submission orders.

| Round | Seed | Requested | Accepted | Rejected (by reason) | Treasury remaining |
|---|---|---|---|---|---|
| 0 | `0x5eed0000` | 13.773 | 5.633 (10 tx) | 14: 9 over budget, 5 over vendor limit | 4.367 |
| 1 | `0x5eed0001` | 14.633 | 5.752 (9 tx) | 15: 5 over budget, 10 over vendor limit | 4.248 |
| 2 | `0x5eed0002` | 12.588 | 5.803 (11 tx) | 13: all over vendor limit | 4.197 |

In every round, all 24 transactions landed in **one block**, so they really competed. The test
asserted all of the following for every round:
- accepted ≤ treasury budget
- accepted ≤ the branch's vendor limit
- each agent's accepted total ≤ its 1 NEAR allocation
- the contract's `total_reserved` and its exposure counter equal the sum observed from the
  transaction outcomes
- invariants I1–I5 and custody (I8) hold

The seed fixes the request amounts and the order they're submitted in. It does not fix the order
the node processes transactions within a block. Re-running the same seeds therefore gives
different accepted sets: in CI run 43079101112, round 0 accepted 5.708 NEAR instead of 5.633.
The guarantees held in every run; the exact accepted set depends on that processing order.

Over budget means the agent's own allocation was exhausted (`INSUFFICIENT_BUDGET`). Over vendor
limit means the root branch reached its 6 NEAR cap for that vendor (`COUNTERPARTY_LIMIT`).

## Agent simulator (TypeScript, near-api-js, real signed transactions)

Source: CI run [43079101112](https://github.com/RaceeyXo/CIRCUIT/actions/runs/43079101112), a
`near-sandbox` node. Every agent is its own NEAR account and signs its own transactions. The
simulator only submits requests and records outcomes. Reports are JSON with the hash, block,
gas, outcome and events of every transaction.

| Scenario | Checks | Transactions |
|---|---|---|
| `spec`: one 1 NEAR allocation, concurrent 0.6 / 0.5 / 0.3 | 8/8 passed | 8 |
| `concurrency`: 10 agents, 24 concurrent requests, then 10 concurrent payouts | 9/9 passed | 47 |
| `attacks`: escalation, duplicate flood, forged callback, splitting, revocation, hoarding and expiry, failed transfer | 19/19 passed | 37 |

The spec run accepted 0.5 and 0.3 NEAR and rejected 0.6 NEAR (`INSUFFICIENT_BUDGET`). Both payouts
settled, and each vendor's balance rose by exactly the reserved amount.

Concurrency run, seed `0x5eed`:

| Metric | Value |
|---|---|
| Requested / accepted / rejected | 13.815 / 5.675 / 8.140 NEAR |
| Accepted / rejected transactions | 10 / 14 (10 over vendor limit, 4 over budget) |
| Inclusion blocks for 24 concurrent requests | 1 |
| `reserve` client latency, submit → final outcome | p50 494 ms, p95 497 ms |
| `execute` client latency, including callback | p50 609 ms, p95 610 ms |
| `reserve` gas, accepted / rejected | p50 3.626 / 2.579 Tgas |
| `execute` gas, transfer plus callback | p50 5.452 Tgas (5.432–5.486) |
| Vendor balance increase | exactly 5.675 NEAR (= accepted) |

The latencies are for a local single-node sandbox and say nothing about testnet latency.

## Baseline vs CIRCUIT

Source: CI run [43198136717](https://github.com/RaceeyXo/CIRCUIT/actions/runs/43198136717), sandbox.
The same three concurrent requests (0.6, 0.5, 0.3 NEAR) were run against one 1 NEAR budget.

| | Paid out | Over budget |
|---|---|---|
| Baseline: shared hot wallet, budget kept off-chain, each agent checks a snapshot | 1.400 NEAR (3 transfers) | **+0.400 NEAR** |
| CIRCUIT | 0.800 NEAR (0.5 + 0.3; 0.6 rejected with `INSUFFICIENT_BUDGET`) | 0 |

The baseline models the off-chain race deterministically: every agent reads the shared
"spent so far" value before any agent pays. The same run at 0.1 scale paid 0.14 against 0.10.

## Correctness evidence

| Suite | Result | What it covers |
|---|---|---|
| Unit tests (`contracts/circuit/src/tests/unit.rs`) | 38 passed | Attacks 2–9, accounting, state machine, pause, storage deposits, custody |
| Property tests (`src/tests/props.rs`) | 2 × 256 cases passed | Random operation sequences with atomic rollback; I1–I7 and I9 rechecked after every step; random orderings of competing requests |
| Sandbox tests (`tests/sandbox`) | 7 passed | Real payout, forged callback rejected, failed transfer refunded, deposit refunds, duplicates, branch revocation, expiry, concurrency experiment |
| Mutation check | caught | A planted bug (release skipping ancestor exposure) failed both a unit test and the property test |
