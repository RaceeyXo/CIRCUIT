# CIRCUIT — Architecture (Phase 0 design, for review)

Status: **DRAFT — awaiting review before implementation.**
Items marked `[VERIFY]` are assumptions about NEAR behaviour that will be confirmed against
official docs / sandbox tests in Phase 1 before code depends on them.

---

## 1. Design summary

* The NEAR contract is the only authority. It holds the treasury funds, keeps the ledger,
  enforces policies, and is the **only** party that can move funds.
* Agents are NEAR accounts. Identity = `predecessor_account_id` (authenticated by NEAR
  signatures; works for agents that are themselves contracts).
* Hierarchical budgets use **carve-out accounting**: delegating to a child moves allocation
  out of the parent. Reservations touch only the reserving agent + global counters → the
  budget check is O(1) and cannot double count.
* Branch-wide properties (revocation, counterparty concentration) use a **bounded ancestor
  walk** (max depth 4 below the treasury) — O(depth) reads/writes, never O(subtree).
* Payment = contract-executed NEAR transfer with a `#[private]` callback. Nobody can "mark a
  payment as successful"; only the transfer's own promise result can settle a reservation.
* Off-chain components (API, simulator, dashboard, Postgres) are **observers and request
  generators**. Postgres stores history for display; current state is always read from the
  contract.

## 2. Components

```
                ┌───────────────────────────── NEAR (testnet / sandbox) ───────────────────┐
 agent keys ──► │  circuit contract                                                        │
 (simulator)    │   treasury ledger · agent registry · policies · reservations · payouts   │
                │   NEP-297 events in receipt logs                                         │
                └───────────────▲───────────────────────────────▲──────────────────────────┘
                                │ signed txs                    │ view calls
                ┌───────────────┴──────────┐        ┌───────────┴──────────┐
                │ packages/agent-simulator │◄──────►│ apps/api (Node/TS)   │──► Postgres
                │ deterministic agents,    │        │ runs scenarios,      │   (tx outcome
                │ scenarios, baseline      │        │ proxies views,       │    history only)
                └──────────────────────────┘        │ indexes outcomes     │
                                                    └───────────▲──────────┘
                                                                │ REST
                                                    ┌───────────┴──────────┐
                                                    │ apps/web (Next.js)   │
                                                    └──────────────────────┘
```

### Proposed deviations from the suggested structure

| Suggestion | Proposal | Reason |
|---|---|---|
| `packages/policy-engine` | **Drop as an authorisation component.** | A second implementation of the rules in TS is either redundant or a divergence/bypass risk. Rules exist once, in the contract. The "vulnerable baseline" (check-then-act against a stale snapshot) lives in the simulator, clearly labelled. |
| `tests/` at root for everything | Rust tests in `contracts/circuit/` (`src/` unit + property, `tests/` sandbox); TS scenario/experiment tests in `tests/`. | Cargo conventions; sandbox tests need the compiled wasm next to them. |
| Next.js route handlers vs separate API | Keep `apps/api` separate. | It holds agent signing keys and runs long scenarios; keys must never end up in the web bundle. |

## 3. Contract data model

All amounts are `u128` yoctoNEAR internally, `U128` (decimal string) in JSON. No floats anywhere.

```rust
struct Treasury {
    owner: AccountId,
    total_budget: u128,    // NEAR deposited via fund_treasury (authorised budget)
    allocated: u128,       // Σ allocation of top-level agents (carved out of total_budget)
    total_spent: u128,     // Σ agent.spent     (maintained incrementally)
    total_reserved: u128,  // Σ agent.reserved  (includes EXECUTING)
    paused: bool,
}

struct Agent {
    id: AccountId,
    parent: Option<AccountId>,   // None = top-level (parent is the treasury). IMMUTABLE.
    depth: u8,                   // 1 = top-level, ≤ MAX_DEPTH (4)
    allocation: u128,
    spent: u128,
    reserved: u128,
    delegated: u128,             // Σ allocation of direct children (exact)
    pending_count: u32,          // live RESERVED + EXECUTING reservations
    status: Active | Revoked,    // revocation is irreversible
    policy: Policy,
    created_at: u64,
}

struct Policy {
    max_tx_amount: u128,
    max_pending_amount: u128,          // cap on agent.reserved
    max_pending_count: u32,            // also bounds live storage
    max_counterparty_exposure: u128,   // BRANCH-level, see §4.3
    max_delegated: u128,               // 0 ⇒ cannot delegate / register children
    max_reservation_ttl_ns: u64,
}

struct Reservation {
    id: u64,                     // monotonic counter
    request_id: String,          // ≤ 64 bytes, [A-Za-z0-9_-:.]
    agent: AccountId,
    counterparty: AccountId,
    amount: u128,
    created_at: u64,             // block_timestamp (ns)
    expires_at: u64,
    status: Reserved | Executing | Settled | Released,
    closed_at: Option<u64>,
    release_reason: Option<Agent | Ancestor | Owner | Expired>,
}
```

Storage (near-sdk `store` collections):

| Collection | Key → Value | Notes |
|---|---|---|
| `agents` | `IterableMap<AccountId, Agent>` | iterable for paginated dashboard views |
| `reservations` | `LookupMap<u64, Reservation>` | + paginated range view by id |
| `request_index` | `LookupMap<[u8;32], u64>` | key = sha256(agent ‖ 0x00 ‖ request_id), fixed size |
| `exposure` | `LookupMap<[u8;32], u128>` | key = sha256(agent ‖ 0x00 ‖ counterparty); branch counters |

## 4. Accounting model and invariants

### 4.1 Definitions

```
available(a)       = allocation(a) − spent(a) − reserved(a) − delegated(a)
treasury_remaining = total_budget − total_spent − total_reserved
treasury_unallocated = total_budget − allocated
```

### 4.2 Invariants (checked by property tests after every operation)

| # | Invariant |
|---|---|
| I1 | ∀a: `spent + reserved + delegated ≤ allocation` |
| I2 | ∀a: `delegated(a) = Σ allocation(c)` over direct children c |
| I3 | `allocated = Σ allocation(t)` over top-level agents t; `allocated ≤ total_budget` |
| I4 | `total_spent = Σ spent(a)`, `total_reserved = Σ reserved(a)` |
| I5 | `total_spent + total_reserved ≤ allocated ≤ total_budget` |
| I6 | ∀a: `reserved(a) = Σ amount` of a's RESERVED+EXECUTING reservations; `pending_count` likewise |
| I7 | ∀(x, cp): `exposure(x, cp) = Σ amount` of RESERVED/EXECUTING/SETTLED reservations to cp made by x or any descendant of x |
| I8 | Custody: `account_balance − storage_cost ≥ total_budget − total_spent − in_flight` (see §6) |
| I9 | Status transitions only along the edges in §5; terminal states never change |

**Why the hierarchy cannot overcommit (proof sketch).** Every agent's own spent and reserved
amounts, plus its children's whole allocations, fit inside its allocation (I1, I2). By induction
from the leaves, the total spent + reserved across any subtree is at most the allocation of
that subtree's root. Summing over top-level agents (I3) gives
Σ(spent + reserved) ≤ allocated ≤ total_budget. A child's reservation is never charged to
the parent: the parent already gave up that amount when it delegated. That is why nothing
is double counted. Every mutation of an agent's `spent`/`reserved` updates the global
counters inside the same receipt, so I4 holds by construction. Property tests recompute the
sums independently and check them.

### 4.3 Hierarchy design — alternatives considered

| Option | Verdict |
|---|---|
| **Ancestor accounting** (each reservation increments `reserved` at every ancestor) | Rejected. It duplicates what carve-out already guarantees, creates the double-count hazard the spec warns about, and costs O(depth) writes for no extra safety. |
| **Root-only accounting** (one global counter) | Insufficient on its own: no per-agent or per-branch limits. It is kept anyway as global counters for O(1) treasury reads. |
| **Carve-out + O(1) budget check** | **Chosen** for budget enforcement. |
| **Cascade revocation** (mark every descendant) | Rejected. O(subtree) writes with unbounded gas; a large branch could become impossible to revoke. |
| **Bounded ancestor walk for status** | **Chosen.** `parent` is immutable and depth ≤ 4, so a reserve does ≤ 4 extra agent reads. Revoking any ancestor blocks the whole branch at O(1) cost. |
| **Branch-level counterparty counters** | **Proposed** (decision D2). Per-agent caps alone are defeated by *splitting*: a parent spreads budget over many children who all pay the same counterparty. With branch counters, each agent x on the path keeps `exposure(x, cp)` and its own policy caps the whole branch. Cost: ≤ depth+1 reads and writes per reserve/release. |

Policy **monotonicity**: when a child is registered or its policy is updated, every field must be
≤ the parent's. Child policies can therefore never be looser than their ancestors'. Only the parent
(or the owner, for top-level agents) sets a child's policy.

Gas: the reserve path is O(depth) storage operations with depth ≤ 4, which is bounded. The
real numbers will be **measured** in sandbox and recorded in `docs/benchmarks.md`. No estimates
are claimed here.

## 5. Reservation lifecycle

```
                  reserve() ok
 (REQUESTED) ───────────────────► RESERVED ──execute()──► EXECUTING ──transfer ok──► SETTLED
      │                            │  ▲                       │
      │ reserve() fails            │  └──── transfer failed ──┘  (callback restores RESERVED)
      ▼                            │
  REJECTED                         └── release() / release_expired() ──► RELEASED
 (failed tx; nothing stored)
```

`REQUESTED` exists only while `reserve` is executing. A NEAR function call is atomic, so the
request either commits as `RESERVED` or the receipt fails (`REJECTED`), in which case no state
and no attached deposit is kept. The failed transaction stays on-chain with a structured
error (`CIRCUIT:<CODE>:<detail>`), which serves as the audit record of the rejection. Nothing
is persisted for rejections, so they cannot be used to grow storage.

`EXECUTING` is an addition to the spec's state machine. It covers the asynchronous gap between
sending a transfer and learning its outcome.

### Transition rules

| Transition | Caller | Preconditions | Effects |
|---|---|---|---|
| → RESERVED (`reserve(request_id, counterparty, amount, ttl)`) | the agent | not paused; agent registered + Active; every ancestor Active; 0 < amount ≤ max_tx; amount ≤ available; reserved+amount ≤ max_pending_amount; pending_count < max_pending_count; ∀x on path: exposure(x,cp)+amount ≤ policy(x).max_counterparty; ttl ≤ max_ttl; counterparty ≠ contract, ≠ agent; valid request_id; storage deposit attached | agent.reserved += amt, pending_count += 1, total_reserved += amt, exposure(x,cp) += amt on path, store reservation + request_index, emit `reservation_created`, refund excess deposit |
| duplicate `reserve` | the agent | same (agent, request_id) **and** same counterparty+amount | no state change, returns existing reservation, deposit refunded, emit `reservation_duplicate` |
| conflicting duplicate | — | same request_id, different params | reject `REQUEST_ID_CONFLICT` |
| RESERVED → EXECUTING (`execute(id)`) | the agent only | not paused; status RESERVED; now < expires_at; agent + ancestors Active; enough prepaid gas for transfer + callback | status = EXECUTING; `Promise::transfer(amount)` to counterparty `.then(on_execute(id))` |
| EXECUTING → SETTLED | `#[private] on_execute` | promise result = success | reserved −= amt, spent += amt (agent + global), pending_count −= 1, exposure unchanged (still counts) |
| EXECUTING → RESERVED | `#[private] on_execute` | promise result = failure | status back to RESERVED (expiry still runs), emit `execution_failed` |
| RESERVED → RELEASED (`release(id)`) | the agent, any Active ancestor, or owner | status RESERVED | reserved −= amt, pending_count −= 1, exposure(x,cp) −= amt on path, emit `reservation_released` |
| RESERVED → RELEASED (`release_expired(ids)`) | anyone | status RESERVED and now ≥ expires_at | same as release, reason Expired; batch ≤ 50; ineligible ids skipped |
| anything else | — | — | panic `INVALID_TRANSITION` |

Notes:
* A revoked agent may still *release* its own reservations: that only reduces exposure.
* EXECUTING can never be released or expired, because the funds are already in flight.
* `on_execute` is minimal and never panics. It runs with a fixed, generous gas allocation.
  `execute` requires enough attached gas to cover it. Residual risk: if the callback still ran
  out of gas, the reservation would stay EXECUTING with the budget held, which fails safe
  (no overspend, only locked budget). This is documented in the threat model.

## 6. Treasury custody

* **Funds in.** `fund_treasury()` is `#[payable]` and owner-only (decision D5). It adds exactly
  the attached deposit to `total_budget`.
* **Funds out.** There are only two paths: (1) `execute` → `on_execute` (the payout path), and
  (2) `withdraw_unallocated(amount)`, owner-only, limited to `total_budget − allocated`. No
  method can move funds that have been allocated to agents.
* **Storage.** The NEAR balance also has to cover storage staking. The spec warns that the
  ledger must not be confused with the transferable balance, so:
  * every state-growing call (`reserve`, `register_agent`) requires an **attached storage
    deposit** from the caller. The exact byte cost is measured via `storage_usage()` before and
    after the write, and any excess is refunded. A compromised agent spamming reservations pays
    for that storage with its own funds, not the treasury's (decision D3);
  * as a backstop, every state-mutating call asserts I8. Storage that would eat into treasury
    funds makes the call fail. The deployer seeds a separate storage buffer at deploy time.
* **Failure modes.**

| Failure | Outcome |
|---|---|
| Counterparty account does not exist | Transfer fails and the deposit is refunded to the contract `[VERIFY]`. The callback sees failure → RESERVED, and the agent can retry or release. |
| Refund arrives after the callback | The ledger never reads the balance to decide budget, so nothing breaks. I8 tolerates `in_flight`. |
| Callback out of gas | Stuck EXECUTING, which fails safe (see §5). Mitigation: fixed callback gas, tests at the minimum attached gas. |
| Contract balance below a payout | The transfer receipt cannot be created, the `execute` receipt fails, and the state rolls back `[VERIFY]`. |
| Interleaving during the async gap | The amount stays in `reserved` while EXECUTING, so concurrent reserves see it as committed. |

**Trust assumptions (disclosed, not solved, in the MVP).** The account holding the contract's
full-access key can redeploy the code and therefore drain the treasury. The owner key can
create top-level agents. In production these should be a multisig/DAO, or the full-access key
should be removed after deploy. The simulator holds every agent's key, so the demo shows
contract enforcement, **not** key isolation between agents.

## 7. Contract interface (draft)

Mutating: `new(owner)`, `fund_treasury()`, `withdraw_unallocated(amount)`,
`register_agent(agent, parent?, policy, allocation)`, `delegate_budget(child, amount)`,
`reclaim_budget(child, amount)`, `update_policy(agent, policy)`, `revoke_agent(agent)`,
`reserve(request_id, counterparty, amount, ttl_ns)`, `execute(reservation_id)`,
`on_execute(reservation_id)` (private), `release(reservation_id)`, `release_expired(ids)`,
`set_paused(bool)`.

Views: `get_treasury`, `get_agent`, `get_agents(from, limit)`, `get_reservation`,
`get_reservations(from_id, limit)`, `get_reservation_by_request(agent, request_id)`,
`get_exposure(agent, counterparty)`, `get_available(agent)`.

Authority:
* `register_agent`: the owner registers top-level agents (funded from `treasury_unallocated`).
  An Active agent with `max_delegated > 0` and depth < 4 registers its own children.
* `delegate_budget` / `reclaim_budget`: only the direct parent (or the owner for top-level
  agents). The amount must be ≤ the parent's `available` (or ≤ the child's `available` when
  reclaiming), and the parent's `delegated` stays ≤ `max_delegated`.
* `revoke_agent`: the owner or any Active ancestor. Irreversible. The parent can then reclaim
  the child's unused allocation.

Events: NEP-297 JSON logs, `standard: "circuit"`, one per state change.

## 8. Concurrency on NEAR — what "concurrent" means here

All of a contract's state lives on one shard, and receipts for it execute **sequentially**. A
reserve is a single atomic read-check-write with no cross-contract call in the middle, so two
reserves cannot interleave inside each other. The real race is the classic check-then-act from
a **stale off-chain read** (the vulnerable baseline), plus the async gap in `execute`, which
§5 covers. The concurrency experiment therefore submits ≥ 20 signed transactions from 10 agent
accounts at the same time (`broadcast_tx_async`, no waiting between sends). Each run uses a
different submission order. The experiment records the block height and the ordering each one
landed in, and verifies the invariant against final contract state for every ordering.

## 9. Vulnerable baseline (for the demo)

The same scenario runs without CIRCUIT's shared ledger. Each agent reads a snapshot of the
balance, decides locally, and pays from a shared hot wallet. Every agent sees the full
budget, so all of them approve → over-commitment. The baseline is labelled clearly, lives
only in the simulator, and runs on the same accounts and amounts so the comparison is
like-for-like.

## 10. Off-chain stack

* `packages/shared`: types mirroring the contract JSON, unit conversion (bigint only), and
  a contract client on `near-api-js`. The v7 API surface will be checked before use `[VERIFY]`.
* `packages/agent-simulator`: a seeded PRNG, agent behaviours (honest, greedy, duplicate
  spammer, escalator, splitter, holder), scenario definitions, and the baseline.
* `apps/api`: Fastify. Runs scenarios, proxies view calls, and writes every submitted tx
  outcome (hash, method, args, status, error code, gas burnt, logs) to Postgres. Every row
  links to the explorer by tx hash. Limitation: txs submitted by other clients show up in
  state but not in the activity feed.
* `apps/web`: Next.js + Tailwind. Treasury, hierarchy, reservations, security events,
  simulator, and baseline vs CIRCUIT. All numbers come from contract views or indexed outcomes.

## 11. Testing strategy

| Layer | Tooling | Runs on Windows? | Covers |
|---|---|---|---|
| Unit | near-sdk `testing_env!` | yes | every transition, auth check, rejection code, boundary value |
| Property / invariant | `proptest` random op sequences (including callback success/failure and time jumps) against the contract plus a simple reference model | yes | I1–I9 after every step, model equivalence, order-independence |
| Integration | `near-workspaces` + sandbox | **no — needs Linux** (D1) | real receipts, real transfers, failed transfer to a missing account, callback gas, storage deposits |
| Adversarial | attacks 1–9 at both unit and sandbox level | partly | spec §8 |
| Concurrency experiment | TS script, 10 accounts, ≥ 20 concurrent txs, N shuffled orderings, sandbox **and** testnet | sandbox: needs Linux; testnet: yes | recorded in `docs/benchmarks.md` with raw outputs |

## 12. Milestones (deadline 2026-11-14 — 5 working days, tight)

| Day | Work | Exit criterion |
|---|---|---|
| Nov 9 | Phase 0 sign-off · Phase 1 (init, treasury, registry, delegation, views) · start Phase 2 | unit tests green |
| Nov 10 | Phase 2 (reserve/execute/callback/release/expiry) · Phase 3 (policies, revocation, branch exposure) | unit + property tests green |
| Nov 11 | Phase 4 sandbox + adversarial suite · Phase 6 testnet deploy · Phase 5 simulator | attacks 1–9 pass on sandbox; testnet tx hashes recorded |
| Nov 12 | Phase 7 API + dashboard on live data | dashboard shows testnet state |
| Nov 13 | Phase 8 concurrency experiment + benchmarks + docs | `benchmarks.md` built from real runs |
| Nov 14 | Phase 9 demo walkthrough · buffer | — |

**Cut order if behind:** (1) replace Postgres with an append-only JSON log, (2) reduce the
dashboard to treasury, hierarchy and events, (3) defer `withdraw_unallocated` and
`update_policy`. The contract, the tests and the testnet evidence are never cut.

## 13. Decisions

| # | Decision | Status |
|---|---|---|
| D1 | Sandbox tests run in WSL2 Ubuntu locally, plus GitHub Actions CI | **Decided** 2026-11-09 |
| D2 | Branch-level counterparty exposure counters | **Decided** |
| D3 | Storage paid by the caller's attached deposit, with the I8 guard as backstop | **Decided** |
| D4 | Real NEAR payouts via `execute` + private callback | **Decided** |
| D5 | Owner-only `fund_treasury` | Default (not contested) |
| — | Testnet deployment | Needs a faucet-funded testnet account; explicit go-ahead before deploy |
