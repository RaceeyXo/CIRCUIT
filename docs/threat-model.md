# CIRCUIT — Threat Model (Phase 0 draft)

## Assets
1. Treasury NEAR held by the contract.
2. Integrity of the ledger (invariants I1–I9 in `architecture.md`).
3. Availability: legitimate agents can still reserve, execute and release.
4. Audit trail: events and failed-transaction records.

## Actors and trust

| Actor | Trust | Powers |
|---|---|---|
| Contract full-access key holder | **Fully trusted** (MVP) | Can redeploy code, so can do anything. Disclosed limitation. |
| Owner | Trusted root of authority | Funds the treasury, registers top-level agents, revokes, pauses, withdraws unallocated funds. **Cannot** move allocated funds. |
| Agent | Untrusted beyond its policy | Reserves and executes within its budget; manages its own children. |
| Compromised agent | Adversarial | Same powers as the agent, so the damage is bounded by its allocation and policy. |
| Unregistered account | Adversarial | Can call methods; every mutating path rejects it. |
| API / simulator / dashboard | **Untrusted for authorisation** | Submit signed txs; they hold no privileged role in the contract. |
| Counterparty | Untrusted | Receives transfers. Can be a nonexistent account, or a contract that does something unexpected. |

## Threats → mitigations → tests

| # | Threat | Mitigation | Test |
|---|---|---|---|
| T1 | Concurrent overspend (spec attack 1) | Atomic read-check-write in `reserve`; carve-out invariants | unit permutations, proptest, sandbox + testnet concurrent experiment |
| T2 | Delegation escalation (attack 2) | `delegate_budget` ≤ parent available, `delegated ≤ max_delegated`, policy monotonicity, depth ≤ 4 | unit + sandbox |
| T3 | Duplicate requests / replay (attack 3) | `(agent, request_id)` index; same params ⇒ idempotent, different params ⇒ conflict | unit + sandbox repeated submission |
| T4 | Revoked agent commits (attack 4) | status check in reserve **and** execute | unit + sandbox |
| T5 | Revoked ancestor's branch commits (attack 5) | bounded ancestor walk in reserve and execute | unit (depth 1–4) + sandbox |
| T6 | Counterparty concentration, including **splitting across children** (attack 6) | branch-level exposure counters (D2) | unit, proptest, sandbox splitter scenario |
| T7 | Reservations held indefinitely (attack 7) | mandatory TTL ≤ policy max; permissionless `release_expired`; `max_pending_count` | unit with time travel, sandbox `fast_forward` `[VERIFY]` |
| T8 | Invalid transitions (attack 8) | explicit transition table; terminal states are immutable | exhaustive unit tests over (state × operation × caller) |
| T9 | Overflow / underflow / malformed input (attack 9) | `checked_*` arithmetic that panics on overflow; release profile `overflow-checks = true`; validated `request_id`, `AccountId`, non-zero amounts, ttl bounds | boundary unit tests (0, 1, u128::MAX), proptest |
| T10 | Forged settlement: someone calls the callback | `#[private]` callback; settlement depends only on the promise result | unit (wrong predecessor) + sandbox |
| T11 | Async gap: state changes between `execute` and `on_execute` | amount stays reserved while EXECUTING; EXECUTING cannot be released/expired; revocation does not unwind in-flight funds | proptest interleavings, sandbox |
| T12 | Callback runs out of gas, leaving the reservation stuck | fixed callback gas, minimum prepaid gas enforced in `execute`, non-panicking callback | sandbox test at the minimum gas |
| T13 | Storage exhaustion drains the treasury | caller pays storage via attached deposit (D3); `max_pending_count`; I8 assertion; rejections store nothing | sandbox storage accounting test |
| T14 | Ledger diverges from the real balance | payouts are the only outflow; I8 check; ledger never reads the balance to make budget decisions | sandbox balance reconciliation |
| T15 | Unauthorised management (register, revoke or delegate someone else's child) | parent-only / ancestor / owner checks on predecessor | unit auth matrix |
| T16 | Off-chain layer bypasses policy | the contract enforces everything; the API has no role in it | sandbox: direct txs that skip the API get identical decisions |
| T17 | Reentrancy-style surprises from a counterparty contract | plain `Transfer` action only; no function call on the counterparty | review + sandbox |

## Residual risks (MVP, documented)
* Full-access key holder / owner compromise = total compromise (needs a multisig/DAO in production).
* The simulator holds all agent keys, so key isolation is not demonstrated.
* A reservation stuck in EXECUTING after an out-of-gas callback locks budget; it fails safe and does not overspend.
* The activity feed shows only transactions submitted through the API; contract state is complete regardless.
* NEAR-native token only; no FT/NEP-141, no cross-chain.
