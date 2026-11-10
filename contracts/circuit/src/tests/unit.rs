//! Unit tests against the near-sdk mocked blockchain.
//!
//! Limits of this layer (covered by sandbox tests instead): `#[private]` enforcement lives in
//! the generated wasm entry point, real transfers/refunds, real gas, real receipt ordering.

use std::panic::{catch_unwind, AssertUnwindSafe};

use near_sdk::json_types::{U128, U64};
use near_sdk::test_utils::{testing_env_with_promise_results, VMContextBuilder};
use near_sdk::{testing_env, AccountId, Gas, NearToken, PromiseResult};

use crate::agents::{AgentStatus, AgentView};
use crate::policies::PolicyJson;
use crate::reservations::{ReleaseReason, ReservationStatus};
use crate::Circuit;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
/// Generous storage deposit; excess is refunded.
const DEP: u128 = NEAR / 10;
const HOUR: u64 = 3_600 * 1_000_000_000;

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn contract_id() -> AccountId {
    id("circuit.test")
}
fn owner() -> AccountId {
    id("owner.test")
}

struct T {
    c: Circuit,
    now: u64,
    balance: u128,
}

impl T {
    fn set(&self, who: &AccountId, deposit: u128) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(contract_id())
            .predecessor_account_id(who.clone())
            .signer_account_id(who.clone())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .account_balance(NearToken::from_yoctonear(self.balance))
            .prepaid_gas(Gas::from_tgas(300))
            .block_timestamp(self.now)
            .build());
    }

    /// Fresh contract, treasury funded with `budget` NEAR.
    fn new(budget_near: u128) -> Self {
        let mut t = T { c: placeholder(), now: 1_000 * HOUR, balance: 10_000 * NEAR };
        t.set(&owner(), 0);
        t.c = Circuit::new(owner());
        t.set(&owner(), budget_near * NEAR);
        t.c.fund_treasury();
        t
    }

    fn register(&mut self, by: &AccountId, agent: &str, parent: Option<&str>, policy: PolicyJson, alloc: u128) -> AgentView {
        self.set(by, DEP);
        self.c.register_agent(id(agent), parent.map(id), policy, U128(alloc))
    }

    fn reserve(&mut self, agent: &str, req: &str, cp: &str, amount: u128) -> u64 {
        self.reserve_ttl(agent, req, cp, amount, HOUR)
    }

    fn reserve_ttl(&mut self, agent: &str, req: &str, cp: &str, amount: u128, ttl: u64) -> u64 {
        self.set(&id(agent), DEP);
        self.c
            .reserve(req.into(), id(cp), U128(amount), U64(ttl))
            .reservation
            .id
            .0
    }

    fn agent(&self, a: &str) -> AgentView {
        self.c.get_agent(id(a)).unwrap()
    }

    /// Simulates the runtime delivering the transfer outcome to the private callback.
    fn callback(&mut self, rid: u64, ok: bool) -> bool {
        let ctx = VMContextBuilder::new()
            .current_account_id(contract_id())
            .predecessor_account_id(contract_id())
            .account_balance(NearToken::from_yoctonear(self.balance))
            .prepaid_gas(Gas::from_tgas(300))
            .block_timestamp(self.now)
            .build();
        let result = if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed };
        testing_env_with_promise_results(ctx, result);
        self.c.on_execute(U64(rid))
    }

    fn execute_and_settle(&mut self, agent: &str, rid: u64) {
        self.set(&id(agent), 0);
        let _ = self.c.execute(U64(rid));
        assert!(self.callback(rid, true));
    }

    /// I1–I5 recomputed from the public views.
    fn check_invariants(&self) {
        let t = self.c.get_treasury();
        let agents = self.c.get_agents(None, None);
        let (mut spent, mut reserved, mut top_alloc) = (0u128, 0u128, 0u128);
        for a in &agents {
            let committed = a.spent.0 + a.reserved.0 + a.delegated.0;
            assert!(committed <= a.allocation.0, "I1 violated for {}", a.id);
            assert_eq!(a.available.0, a.allocation.0 - committed);
            let child_sum: u128 = agents
                .iter()
                .filter(|c| c.parent.as_ref() == Some(&a.id))
                .map(|c| c.allocation.0)
                .sum();
            assert_eq!(a.delegated.0, child_sum, "I2 violated for {}", a.id);
            if a.parent.is_none() {
                top_alloc += a.allocation.0;
            }
            spent += a.spent.0;
            reserved += a.reserved.0;
        }
        assert_eq!(t.allocated.0, top_alloc, "I3");
        assert!(t.allocated.0 <= t.total_budget.0, "I3");
        assert_eq!(t.total_spent.0, spent, "I4 spent");
        assert_eq!(t.total_reserved.0, reserved, "I4 reserved");
        assert!(t.total_spent.0 + t.total_reserved.0 <= t.total_budget.0, "I5");
    }
}

// `Circuit` has no Default (PanicOnDefault); build a throwaway instance to fill the field
// before the real `new()` call replaces it.
fn placeholder() -> Circuit {
    testing_env!(VMContextBuilder::new().current_account_id(contract_id()).build());
    Circuit::new(owner())
}

fn policy(max_tx: u128, max_delegated: u128) -> PolicyJson {
    PolicyJson {
        max_tx_amount: U128(max_tx),
        max_pending_amount: U128(u128::MAX / 4),
        max_pending_count: 100,
        max_counterparty_exposure: U128(u128::MAX / 4),
        max_delegated: U128(max_delegated),
        max_reservation_ttl_ns: U64(24 * HOUR),
    }
}

fn open() -> PolicyJson {
    policy(u128::MAX / 4, u128::MAX / 4)
}

/// Asserts that `f` is rejected with `CIRCUIT:<code>`. Only for rejections raised before any
/// state mutation (true for every check-phase rejection in the contract).
fn rejects<R>(code: &str, f: impl FnOnce() -> R) {
    let err = catch_unwind(AssertUnwindSafe(f)).err().expect("expected a rejection");
    let msg = err
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    assert!(
        msg.contains(&format!("CIRCUIT:{code}:")),
        "expected {code}, got: {msg}"
    );
}

/// root (treasury-funded) → a, b, c
fn spec_tree(t: &mut T) {
    let o = owner();
    t.register(&o, "root.test", None, open(), 1_000);
    for name in ["a.test", "b.test", "c.test"] {
        t.register(&id("root.test"), name, Some("root.test"), open(), 0);
    }
}

// ───────────────────────── Treasury & registry ─────────────────────────

#[test]
fn init_and_fund() {
    let t = T::new(1_000);
    let v = t.c.get_treasury();
    assert_eq!(v.owner, owner());
    assert_eq!(v.total_budget.0, 1_000 * NEAR);
    assert_eq!(v.remaining.0, 1_000 * NEAR);
    assert_eq!(v.allocated.0, 0);
}

#[test]
fn fund_is_owner_only() {
    let mut t = T::new(10);
    t.set(&id("mallory.test"), NEAR);
    rejects("NOT_OWNER", || t.c.fund_treasury());
}

#[test]
fn top_level_allocation_is_carved_from_treasury() {
    let mut t = T::new(10);
    t.register(&owner(), "root.test", None, open(), 4 * NEAR);
    let v = t.c.get_treasury();
    assert_eq!(v.allocated.0, 4 * NEAR);
    assert_eq!(v.unallocated.0, 6 * NEAR);
    rejects("EXCEEDS_UNALLOCATED", || {
        t.register(&owner(), "root2.test", None, open(), 7 * NEAR)
    });
    t.check_invariants();
}

#[test]
fn only_owner_registers_top_level_and_only_parent_registers_children() {
    let mut t = T::new(10);
    rejects("NOT_OWNER", || t.register(&id("x.test"), "y.test", None, open(), 0));
    t.register(&owner(), "root.test", None, open(), NEAR);
    rejects("UNAUTHORIZED", || {
        t.register(&id("x.test"), "y.test", Some("root.test"), open(), 0)
    });
    rejects("UNAUTHORIZED", || {
        t.register(&owner(), "y.test", Some("root.test"), open(), 0)
    });
}

#[test]
fn contract_and_owner_cannot_be_agents_and_ids_are_unique() {
    let mut t = T::new(10);
    rejects("INVALID_AGENT_ID", || t.register(&owner(), "owner.test", None, open(), 0));
    rejects("INVALID_AGENT_ID", || t.register(&owner(), "circuit.test", None, open(), 0));
    t.register(&owner(), "root.test", None, open(), 0);
    rejects("AGENT_EXISTS", || t.register(&owner(), "root.test", None, open(), 0));
}

#[test]
fn delegation_carves_out_of_parent_without_double_counting() {
    let mut t = T::new(1_000);
    t.register(&owner(), "root.test", None, open(), 1_000);
    t.register(&id("root.test"), "a.test", Some("root.test"), open(), 600);
    let root = t.agent("root.test");
    assert_eq!(root.delegated.0, 600);
    assert_eq!(root.available.0, 400);

    // The child's reservation is charged to the child only.
    t.reserve("a.test", "r1", "shop.test", 500);
    let root = t.agent("root.test");
    let a = t.agent("a.test");
    assert_eq!(root.reserved.0, 0);
    assert_eq!(root.available.0, 400);
    assert_eq!(a.reserved.0, 500);
    assert_eq!(a.available.0, 100);
    assert_eq!(t.c.get_treasury().total_reserved.0, 500);
    assert_eq!(t.c.get_treasury().remaining.0, 1_000 * NEAR - 500);
    t.check_invariants();
}

// ───────────────────────── Spec scenario ─────────────────────────

/// Spec §1: three requests (600, 500, 300) against one shared 1000 allocation.
/// Under carve-out accounting "shared" means one allocation; here a single pool agent submits
/// the three requests (in the simulator, three worker processes sign as that agent).
#[test]
fn spec_example_600_500_300() {
    let mut t = T::new(1_000);
    t.register(&owner(), "pool.test", None, open(), 1_000);
    let a = t.reserve("pool.test", "agent-a", "vendor-a.test", 600);
    rejects("INSUFFICIENT_BUDGET", || t.reserve("pool.test", "agent-b", "vendor-b.test", 500));
    let c = t.reserve("pool.test", "agent-c", "vendor-c.test", 300);
    assert_ne!(a, c);
    assert_eq!(t.agent("pool.test").available.0, 100);
    t.check_invariants();
}

#[test]
fn siblings_compete_only_for_their_own_carve_outs() {
    let mut t = T::new(1_000);
    spec_tree(&mut t);
    for (n, amt) in [("a.test", 600u128), ("b.test", 300), ("c.test", 100)] {
        t.set(&id("root.test"), 0);
        t.c.delegate_budget(id(n), U128(amt));
    }
    rejects("INSUFFICIENT_BUDGET", || {
        t.set(&id("root.test"), 0);
        t.c.delegate_budget(id("a.test"), U128(1))
    });
    t.reserve("a.test", "1", "v.test", 600);
    rejects("INSUFFICIENT_BUDGET", || t.reserve("b.test", "1", "v.test", 500));
    t.reserve("c.test", "1", "v.test", 100);
    assert_eq!(t.c.get_treasury().total_reserved.0, 700);
    t.check_invariants();
}

// ───────────────────────── Attack 2: delegation escalation ─────────────────────────

#[test]
fn attack_delegation_escalation() {
    let mut t = T::new(1_000);
    t.register(&owner(), "root.test", None, open(), 1_000);
    t.register(&id("root.test"), "a.test", Some("root.test"), policy(1_000, 500), 400);
    // Child tries to give its own child more than it has.
    rejects("INSUFFICIENT_BUDGET", || {
        t.register(&id("a.test"), "a1.test", Some("a.test"), policy(100, 0), 401)
    });
    // Within budget but above its max_delegated.
    t.register(&id("root.test"), "b.test", Some("root.test"), policy(1_000, 50), 400);
    rejects("DELEGATION_LIMIT", || {
        t.register(&id("b.test"), "b1.test", Some("b.test"), policy(100, 0), 51)
    });
    // Child policy looser than the parent.
    rejects("POLICY_EXCEEDS_PARENT", || {
        t.register(&id("a.test"), "a1.test", Some("a.test"), policy(1_001, 0), 10)
    });
    // An agent that may not delegate.
    t.register(&id("a.test"), "a1.test", Some("a.test"), policy(100, 0), 10);
    rejects("DELEGATION_LIMIT", || {
        t.register(&id("a1.test"), "a2.test", Some("a1.test"), policy(100, 0), 0)
    });
    // A sibling cannot top itself up from its parent.
    rejects("UNAUTHORIZED", || {
        t.set(&id("a.test"), 0);
        t.c.delegate_budget(id("a.test"), U128(1))
    });
    t.check_invariants();
}

#[test]
fn depth_is_bounded() {
    let mut t = T::new(10);
    t.register(&owner(), "d1.test", None, open(), 100);
    t.register(&id("d1.test"), "d2.test", Some("d1.test"), open(), 50);
    t.register(&id("d2.test"), "d3.test", Some("d2.test"), open(), 20);
    t.register(&id("d3.test"), "d4.test", Some("d3.test"), open(), 10);
    assert_eq!(t.agent("d4.test").depth, 4);
    rejects("DEPTH_EXCEEDED", || {
        t.register(&id("d4.test"), "d5.test", Some("d4.test"), open(), 1)
    });
}

#[test]
fn reclaim_returns_only_available_budget() {
    let mut t = T::new(1_000);
    t.register(&owner(), "root.test", None, open(), 1_000);
    t.register(&id("root.test"), "a.test", Some("root.test"), open(), 600);
    t.reserve("a.test", "r", "v.test", 500);
    rejects("INSUFFICIENT_BUDGET", || {
        t.set(&id("root.test"), 0);
        t.c.reclaim_budget(id("a.test"), U128(101))
    });
    t.set(&id("root.test"), 0);
    t.c.reclaim_budget(id("a.test"), U128(100));
    assert_eq!(t.agent("a.test").allocation.0, 500);
    assert_eq!(t.agent("root.test").available.0, 500);
    t.check_invariants();
}

// ───────────────────────── Attack 3: duplicates ─────────────────────────

#[test]
fn attack_duplicate_request_is_idempotent() {
    let mut t = T::new(1_000);
    t.register(&owner(), "a.test", None, open(), 1_000);
    let r1 = t.reserve("a.test", "req-1", "v.test", 300);
    for _ in 0..5 {
        t.set(&id("a.test"), DEP);
        let res = t.c.reserve("req-1".into(), id("v.test"), U128(300), U64(HOUR));
        assert!(res.duplicate);
        assert_eq!(res.reservation.id.0, r1);
    }
    assert_eq!(t.agent("a.test").reserved.0, 300);
    assert_eq!(t.agent("a.test").pending_count, 1);
    rejects("REQUEST_ID_CONFLICT", || t.reserve("a.test", "req-1", "v.test", 301));
    rejects("REQUEST_ID_CONFLICT", || t.reserve("a.test", "req-1", "w.test", 300));
    // Request ids are scoped per agent: another agent may reuse "req-1".
    t.register(&owner(), "b.test", None, open(), 500);
    let rb = t.reserve("b.test", "req-1", "v.test", 300);
    assert_ne!(rb, r1);
    t.check_invariants();
}

#[test]
fn duplicate_of_settled_request_does_not_recommit() {
    let mut t = T::new(1_000);
    t.register(&owner(), "a.test", None, open(), 1_000);
    let r = t.reserve("a.test", "req", "v.test", 300);
    t.execute_and_settle("a.test", r);
    t.set(&id("a.test"), DEP);
    let res = t.c.reserve("req".into(), id("v.test"), U128(300), U64(HOUR));
    assert!(res.duplicate);
    assert_eq!(res.reservation.status, ReservationStatus::Settled);
    assert_eq!(t.agent("a.test").spent.0, 300);
    assert_eq!(t.agent("a.test").reserved.0, 0);
    t.check_invariants();
}

// ───────────────────────── Attacks 4 & 5: revocation ─────────────────────────

#[test]
fn attack_revoked_agent_cannot_commit() {
    let mut t = T::new(1_000);
    t.register(&owner(), "a.test", None, open(), 1_000);
    let r = t.reserve("a.test", "before", "v.test", 100);
    t.set(&owner(), 0);
    t.c.revoke_agent(id("a.test"));
    assert_eq!(t.agent("a.test").status, AgentStatus::Revoked);
    rejects("AGENT_REVOKED", || t.reserve("a.test", "after", "v.test", 100));
    rejects("AGENT_REVOKED", || {
        t.set(&id("a.test"), 0);
        t.c.execute(U64(r))
    });
    // Releasing its own reservation is still allowed: it only reduces exposure.
    t.set(&id("a.test"), 0);
    t.c.release(U64(r));
    assert_eq!(t.agent("a.test").reserved.0, 0);
    rejects("ALREADY_REVOKED", || {
        t.set(&owner(), 0);
        t.c.revoke_agent(id("a.test"))
    });
    t.check_invariants();
}

#[test]
fn attack_revoked_ancestor_blocks_whole_branch() {
    let mut t = T::new(1_000);
    t.register(&owner(), "root.test", None, open(), 1_000);
    t.register(&id("root.test"), "a.test", Some("root.test"), open(), 500);
    t.register(&id("a.test"), "a1.test", Some("a.test"), open(), 200);
    t.register(&id("a1.test"), "a2.test", Some("a1.test"), open(), 100);
    let r = t.reserve("a2.test", "pre", "v.test", 50);

    // The parent revokes its child `a`; everything below `a` is frozen.
    t.set(&id("root.test"), 0);
    t.c.revoke_agent(id("a.test"));
    rejects("ANCESTOR_REVOKED", || t.reserve("a2.test", "post", "v.test", 1));
    rejects("ANCESTOR_REVOKED", || t.reserve("a1.test", "post", "v.test", 1));
    rejects("ANCESTOR_REVOKED", || {
        t.set(&id("a2.test"), 0);
        t.c.execute(U64(r))
    });
    rejects("ANCESTOR_REVOKED", || {
        t.register(&id("a1.test"), "x.test", Some("a1.test"), open(), 0)
    });
    rejects("ANCESTOR_REVOKED", || {
        t.set(&id("a.test"), 0);
        t.c.delegate_budget(id("a1.test"), U128(1))
    });
    // A revoked ancestor cannot act as an ancestor either.
    rejects("UNAUTHORIZED", || {
        t.set(&id("a.test"), 0);
        t.c.revoke_agent(id("a1.test"))
    });
    // The healthy root can still release the stuck reservation and reclaim budget.
    t.set(&id("root.test"), 0);
    let v = t.c.release(U64(r));
    assert_eq!(v.release_reason, Some(ReleaseReason::Ancestor));
    // Unrelated branches are unaffected.
    t.register(&id("root.test"), "b.test", Some("root.test"), open(), 100);
    t.reserve("b.test", "ok", "v.test", 100);
    t.check_invariants();
}

#[test]
fn only_owner_or_ancestor_can_revoke() {
    let mut t = T::new(10);
    t.register(&owner(), "a.test", None, open(), 10);
    t.register(&owner(), "b.test", None, open(), 10);
    rejects("UNAUTHORIZED", || {
        t.set(&id("b.test"), 0);
        t.c.revoke_agent(id("a.test"))
    });
    rejects("UNAUTHORIZED", || {
        t.set(&id("a.test"), 0);
        t.c.revoke_agent(id("a.test"))
    });
}

// ───────────────────────── Attack 6: counterparty concentration ─────────────────────────

#[test]
fn attack_counterparty_limit_per_agent() {
    let mut t = T::new(1_000);
    let mut p = open();
    p.max_counterparty_exposure = U128(300);
    t.register(&owner(), "a.test", None, p, 1_000);
    t.reserve("a.test", "1", "v.test", 200);
    rejects("COUNTERPARTY_LIMIT", || t.reserve("a.test", "2", "v.test", 101));
    t.reserve("a.test", "3", "v.test", 100);
    t.reserve("a.test", "4", "other.test", 300);
    assert_eq!(t.c.get_exposure(id("a.test"), id("v.test")).0, 300);
}

#[test]
fn attack_counterparty_splitting_across_children_is_blocked() {
    let mut t = T::new(1_000);
    let mut p = open();
    p.max_counterparty_exposure = U128(300);
    t.register(&owner(), "root.test", None, p.clone(), 1_000);
    for c in ["s1.test", "s2.test", "s3.test", "s4.test"] {
        t.register(&id("root.test"), c, Some("root.test"), p.clone(), 200);
    }
    // Each child alone is under its own 300 cap, but the branch cap of root binds.
    t.reserve("s1.test", "x", "sink.test", 150);
    t.reserve("s2.test", "x", "sink.test", 150);
    rejects("COUNTERPARTY_LIMIT", || t.reserve("s3.test", "x", "sink.test", 1));
    assert_eq!(t.c.get_exposure(id("root.test"), id("sink.test")).0, 300);
    // Releasing restores branch headroom.
    t.set(&id("s1.test"), 0);
    let first = t.c.get_reservation_by_request(id("s1.test"), "x".into()).unwrap().id;
    t.c.release(first);
    assert_eq!(t.c.get_exposure(id("root.test"), id("sink.test")).0, 150);
    t.reserve("s3.test", "x", "sink.test", 150);
    t.check_invariants();
}

#[test]
fn settled_amounts_keep_counting_towards_exposure() {
    let mut t = T::new(1_000);
    let mut p = open();
    p.max_counterparty_exposure = U128(300);
    t.register(&owner(), "a.test", None, p, 1_000);
    let r = t.reserve("a.test", "1", "v.test", 300);
    t.execute_and_settle("a.test", r);
    rejects("COUNTERPARTY_LIMIT", || t.reserve("a.test", "2", "v.test", 1));
}

#[test]
fn ancestor_tx_limit_binds_descendants() {
    let mut t = T::new(1_000);
    t.register(&owner(), "root.test", None, policy(100, 1_000), 1_000);
    t.register(&id("root.test"), "a.test", Some("root.test"), policy(100, 0), 500);
    rejects("EXCEEDS_TX_LIMIT", || t.reserve("a.test", "1", "v.test", 101));
    t.reserve("a.test", "1", "v.test", 100);
}

// ───────────────────────── Pending limits ─────────────────────────

#[test]
fn pending_amount_and_count_limits() {
    let mut t = T::new(1_000);
    let mut p = open();
    p.max_pending_amount = U128(250);
    p.max_pending_count = 2;
    t.register(&owner(), "a.test", None, p, 1_000);
    t.reserve("a.test", "1", "v.test", 100);
    rejects("PENDING_AMOUNT_LIMIT", || t.reserve("a.test", "2", "v.test", 151));
    let r2 = t.reserve("a.test", "2", "v.test", 100);
    rejects("PENDING_COUNT_LIMIT", || t.reserve("a.test", "3", "v.test", 1));
    t.execute_and_settle("a.test", r2);
    t.reserve("a.test", "3", "v.test", 1);
    t.check_invariants();
}

// ───────────────────────── Attack 7: reservation abuse / expiry ─────────────────────────

#[test]
fn attack_reservation_hoarding_is_bounded_by_expiry() {
    let mut t = T::new(1_000);
    t.register(&owner(), "a.test", None, open(), 1_000);
    let r = t.reserve_ttl("a.test", "hoard", "v.test", 1_000, HOUR);
    rejects("INSUFFICIENT_BUDGET", || t.reserve("a.test", "other", "v.test", 1));

    // Not yet expired: permissionless cleanup is a no-op.
    t.now += HOUR - 1;
    t.set(&id("anyone.test"), 0);
    assert!(t.c.release_expired(vec![U64(r)]).is_empty());

    // Expired: cannot be executed, and anyone can release it.
    t.now += 1;
    rejects("RESERVATION_EXPIRED", || {
        t.set(&id("a.test"), 0);
        t.c.execute(U64(r))
    });
    t.set(&id("anyone.test"), 0);
    assert_eq!(t.c.release_expired(vec![U64(r), U64(r), U64(999)]), vec![U64(r)]);
    let v = t.c.get_reservation(U64(r)).unwrap();
    assert_eq!(v.status, ReservationStatus::Released);
    assert_eq!(v.release_reason, Some(ReleaseReason::Expired));
    t.reserve("a.test", "other", "v.test", 1_000);
    t.check_invariants();
}

#[test]
fn ttl_bounds() {
    let mut t = T::new(10);
    t.register(&owner(), "a.test", None, open(), 100);
    rejects("INVALID_TTL", || t.reserve_ttl("a.test", "1", "v.test", 1, 0));
    rejects("INVALID_TTL", || t.reserve_ttl("a.test", "1", "v.test", 1, 24 * HOUR + 1));
    t.reserve_ttl("a.test", "1", "v.test", 1, 24 * HOUR);
}

#[test]
fn executing_reservation_cannot_expire_or_be_released() {
    let mut t = T::new(1_000);
    t.register(&owner(), "a.test", None, open(), 1_000);
    let r = t.reserve_ttl("a.test", "1", "v.test", 100, HOUR);
    t.set(&id("a.test"), 0);
    let _ = t.c.execute(U64(r));
    t.now += 2 * HOUR;
    t.set(&id("anyone.test"), 0);
    assert!(t.c.release_expired(vec![U64(r)]).is_empty());
    rejects("INVALID_TRANSITION", || {
        t.set(&id("a.test"), 0);
        t.c.release(U64(r))
    });
    assert_eq!(t.c.get_treasury().in_flight.0, 100);
    assert_eq!(t.agent("a.test").reserved.0, 100);
    t.check_invariants();
}

// ───────────────────────── Attack 8: state machine ─────────────────────────

#[test]
fn attack_invalid_transitions() {
    let mut t = T::new(1_000);
    t.register(&owner(), "a.test", None, open(), 1_000);

    // released → settle / release
    let r = t.reserve("a.test", "1", "v.test", 100);
    t.set(&id("a.test"), 0);
    t.c.release(U64(r));
    rejects("INVALID_TRANSITION", || {
        t.set(&id("a.test"), 0);
        t.c.execute(U64(r))
    });
    rejects("INVALID_TRANSITION", || {
        t.set(&id("a.test"), 0);
        t.c.release(U64(r))
    });

    // settled → release / execute
    let s = t.reserve("a.test", "2", "v.test", 100);
    t.execute_and_settle("a.test", s);
    rejects("INVALID_TRANSITION", || {
        t.set(&id("a.test"), 0);
        t.c.release(U64(s))
    });
    rejects("INVALID_TRANSITION", || {
        t.set(&id("a.test"), 0);
        t.c.execute(U64(s))
    });
    // A stray callback for a non-executing reservation changes nothing.
    assert!(!t.callback(s, true));
    assert!(!t.callback(r, true));
    assert_eq!(t.agent("a.test").spent.0, 100);

    // executing → execute again
    let e = t.reserve("a.test", "3", "v.test", 100);
    t.set(&id("a.test"), 0);
    let _ = t.c.execute(U64(e));
    rejects("INVALID_TRANSITION", || {
        t.set(&id("a.test"), 0);
        t.c.execute(U64(e))
    });
    rejects("RESERVATION_NOT_FOUND", || {
        t.set(&id("a.test"), 0);
        t.c.execute(U64(12345))
    });
    t.check_invariants();
}

#[test]
fn settle_moves_reserved_to_spent() {
    let mut t = T::new(1_000);
    t.register(&owner(), "a.test", None, open(), 1_000);
    let r = t.reserve("a.test", "1", "v.test", 400);
    t.set(&id("a.test"), 0);
    let _ = t.c.execute(U64(r));
    assert_eq!(t.c.get_reservation(U64(r)).unwrap().status, ReservationStatus::Executing);
    assert!(t.callback(r, true));
    let a = t.agent("a.test");
    assert_eq!((a.spent.0, a.reserved.0, a.available.0, a.pending_count), (400, 0, 600, 0));
    let tv = t.c.get_treasury();
    assert_eq!((tv.total_spent.0, tv.total_reserved.0, tv.in_flight.0), (400, 0, 0));
    t.check_invariants();
}

#[test]
fn failed_transfer_returns_reservation_to_reserved() {
    let mut t = T::new(1_000);
    t.register(&owner(), "a.test", None, open(), 1_000);
    let r = t.reserve("a.test", "1", "missing.test", 400);
    t.set(&id("a.test"), 0);
    let _ = t.c.execute(U64(r));
    assert!(!t.callback(r, false));
    let v = t.c.get_reservation(U64(r)).unwrap();
    assert_eq!(v.status, ReservationStatus::Reserved);
    assert_eq!(v.failed_attempts, 1);
    assert_eq!(t.agent("a.test").reserved.0, 400);
    assert_eq!(t.c.get_treasury().in_flight.0, 0);
    // The agent may then release it.
    t.set(&id("a.test"), 0);
    t.c.release(U64(r));
    assert_eq!(t.agent("a.test").available.0, 1_000);
    t.check_invariants();
}

#[test]
fn only_the_reserving_agent_executes_and_authorised_parties_release() {
    let mut t = T::new(1_000);
    t.register(&owner(), "root.test", None, open(), 1_000);
    t.register(&id("root.test"), "a.test", Some("root.test"), open(), 500);
    t.register(&id("root.test"), "b.test", Some("root.test"), open(), 500);
    let r = t.reserve("a.test", "1", "v.test", 100);
    for who in ["b.test", "root.test", "owner.test", "v.test"] {
        rejects("UNAUTHORIZED", || {
            t.set(&id(who), 0);
            t.c.execute(U64(r))
        });
    }
    for who in ["b.test", "v.test"] {
        rejects("UNAUTHORIZED", || {
            t.set(&id(who), 0);
            t.c.release(U64(r))
        });
    }
    t.set(&owner(), 0);
    assert_eq!(t.c.release(U64(r)).release_reason, Some(ReleaseReason::Owner));
}

#[test]
fn execute_requires_enough_gas() {
    let mut t = T::new(1_000);
    t.register(&owner(), "a.test", None, open(), 1_000);
    let r = t.reserve("a.test", "1", "v.test", 100);
    testing_env!(VMContextBuilder::new()
        .current_account_id(contract_id())
        .predecessor_account_id(id("a.test"))
        .account_balance(NearToken::from_yoctonear(t.balance))
        .prepaid_gas(Gas::from_tgas(39))
        .block_timestamp(t.now)
        .build());
    rejects("INSUFFICIENT_GAS", || t.c.execute(U64(r)));
}

// ───────────────────────── Attack 9: boundaries & malformed input ─────────────────────────

#[test]
fn attack_boundary_values() {
    let mut t = T::new(1_000);
    t.register(&owner(), "a.test", None, open(), 1_000);
    rejects("ZERO_AMOUNT", || t.reserve("a.test", "z", "v.test", 0));
    rejects("EXCEEDS_TX_LIMIT", || t.reserve("a.test", "m", "v.test", u128::MAX));
    rejects("INSUFFICIENT_BUDGET", || t.reserve("a.test", "m", "v.test", 1_001));
    rejects("INVALID_COUNTERPARTY", || t.reserve("a.test", "s", "a.test", 1));
    rejects("INVALID_COUNTERPARTY", || t.reserve("a.test", "s", "circuit.test", 1));
    rejects("AGENT_NOT_FOUND", || t.reserve("ghost.test", "g", "v.test", 1));
    // Exactly the available amount is accepted; one more yocto is not.
    t.reserve("a.test", "all", "v.test", 1_000);
    rejects("INSUFFICIENT_BUDGET", || t.reserve("a.test", "one", "v.test", 1));
    t.check_invariants();
}

#[test]
fn malformed_request_ids() {
    let mut t = T::new(10);
    t.register(&owner(), "a.test", None, open(), 100);
    for bad in ["", "has space", "nul\0byte", "ünicode", &"x".repeat(65)] {
        rejects("INVALID_REQUEST_ID", || t.reserve("a.test", bad, "v.test", 1));
    }
    t.reserve("a.test", &"x".repeat(64), "v.test", 1);
    t.reserve("a.test", "job-1:step_2.retry", "v.test", 1);
}

#[test]
fn max_values_do_not_wrap() {
    let mut t = T::new(10);
    let huge = PolicyJson {
        max_tx_amount: U128(u128::MAX),
        max_pending_amount: U128(u128::MAX),
        max_pending_count: 1_000,
        max_counterparty_exposure: U128(u128::MAX),
        max_delegated: U128(u128::MAX),
        max_reservation_ttl_ns: U64(24 * HOUR),
    };
    t.register(&owner(), "a.test", None, huge, 10 * NEAR);
    rejects("INSUFFICIENT_BUDGET", || t.reserve("a.test", "1", "v.test", u128::MAX));
    // u64 expiry overflow is rejected, not wrapped.
    t.now = u64::MAX - 10;
    rejects("INVALID_TTL", || t.reserve_ttl("a.test", "2", "v.test", 1, 11));
}

#[test]
fn zero_amounts_rejected_in_budget_operations() {
    let mut t = T::new(10);
    t.register(&owner(), "a.test", None, open(), 1);
    rejects("ZERO_AMOUNT", || {
        t.set(&owner(), 0);
        t.c.delegate_budget(id("a.test"), U128(0))
    });
    rejects("ZERO_AMOUNT", || {
        t.set(&owner(), 0);
        t.c.reclaim_budget(id("a.test"), U128(0))
    });
    rejects("ZERO_AMOUNT", || {
        t.set(&owner(), 0);
        t.c.fund_treasury()
    });
}

#[test]
fn invalid_policies_rejected() {
    let mut t = T::new(10);
    let mut p = open();
    p.max_reservation_ttl_ns = U64(0);
    rejects("INVALID_POLICY", || t.register(&owner(), "a.test", None, p.clone(), 0));
    p.max_reservation_ttl_ns = U64(31 * 24 * HOUR);
    rejects("INVALID_POLICY", || t.register(&owner(), "a.test", None, p.clone(), 0));
    let mut p = open();
    p.max_pending_count = 1_001;
    rejects("INVALID_POLICY", || t.register(&owner(), "a.test", None, p, 0));
}

// ───────────────────────── Pause, storage, custody ─────────────────────────

#[test]
fn pause_blocks_commitments_but_not_exposure_reduction() {
    let mut t = T::new(1_000);
    t.register(&owner(), "a.test", None, open(), 1_000);
    let r = t.reserve("a.test", "1", "v.test", 100);
    t.set(&owner(), 0);
    t.c.set_paused(true);
    rejects("PAUSED", || t.reserve("a.test", "2", "v.test", 1));
    rejects("PAUSED", || {
        t.set(&id("a.test"), 0);
        t.c.execute(U64(r))
    });
    rejects("PAUSED", || t.register(&owner(), "b.test", None, open(), 0));
    t.set(&id("a.test"), 0);
    t.c.release(U64(r));
    rejects("NOT_OWNER", || {
        t.set(&id("a.test"), 0);
        t.c.set_paused(false)
    });
}

#[test]
#[should_panic(expected = "CIRCUIT:INSUFFICIENT_STORAGE_DEPOSIT:")]
fn reserve_requires_storage_deposit() {
    let mut t = T::new(1_000);
    t.register(&owner(), "a.test", None, open(), 1_000);
    t.set(&id("a.test"), 0);
    t.c.reserve("1".into(), id("v.test"), U128(1), U64(HOUR));
}

#[test]
#[should_panic(expected = "CIRCUIT:CUSTODY_VIOLATION:")]
fn custody_guard_rejects_state_growth_into_treasury_funds() {
    let mut t = T::new(1_000);
    t.register(&owner(), "a.test", None, open(), 1_000);
    // The account holds less than the 1000 NEAR it owes the treasury.
    t.balance = 999 * NEAR;
    t.reserve("a.test", "1", "v.test", 1);
}

#[test]
fn withdraw_only_unallocated() {
    let mut t = T::new(1_000);
    t.register(&owner(), "a.test", None, open(), 600 * NEAR);
    rejects("EXCEEDS_UNALLOCATED", || {
        t.set(&owner(), 0);
        t.c.withdraw_unallocated(U128(400 * NEAR + 1))
    });
    rejects("NOT_OWNER", || {
        t.set(&id("a.test"), 0);
        t.c.withdraw_unallocated(U128(1))
    });
    t.set(&owner(), 0);
    let _ = t.c.withdraw_unallocated(U128(400 * NEAR));
    assert_eq!(t.c.get_treasury().total_budget.0, 600 * NEAR);
    t.check_invariants();
}
