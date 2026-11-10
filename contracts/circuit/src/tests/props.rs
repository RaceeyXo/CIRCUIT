//! Property / invariant tests.
//!
//! Each operation runs as one atomic "receipt": the contract is loaded from a copy of the
//! committed storage, the call runs, and the storage is committed only if the call did not
//! panic. That is exactly NEAR's rollback semantics, so a rejected call can never leave
//! partial state behind in the model. After every operation all invariants (I1–I7, I9 from
//! docs/architecture.md) are recomputed from scratch and compared with the contract's
//! incrementally maintained counters.

use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Once;

use near_sdk::json_types::{U128, U64};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{
    env, test_vm_config, AccountId, Gas, MockedBlockchain, NearToken, PromiseResult,
    RuntimeFeesConfig,
};
use proptest::prelude::*;

use crate::agents::Agent;
use crate::policies::PolicyJson;
use crate::reservations::ReservationStatus;
use crate::{pair_key, Circuit};

const UNIT: u64 = 1_000_000_000; // 1 s
const DEPOSIT: u128 = 1_000_000_000_000_000_000_000_000; // 1 NEAR storage deposit
const BUDGET: u128 = 1_000;
const N_AGENTS: usize = 6;
const N_COUNTERPARTIES: usize = 3;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn contract() -> AccountId {
    acc("circuit.test")
}
fn owner() -> AccountId {
    acc("owner.test")
}
fn agent(i: usize) -> AccountId {
    acc(&format!("a{i}.test"))
}
fn counterparty(i: usize) -> AccountId {
    acc(&format!("cp{i}.test"))
}
/// Callers: 0 = owner, 1..=N_AGENTS = agents, N_AGENTS+1 = stranger.
fn caller(i: usize) -> AccountId {
    match i {
        0 => owner(),
        i if i <= N_AGENTS => agent(i - 1),
        _ => acc("stranger.test"),
    }
}

fn policy(variant: u8) -> PolicyJson {
    match variant % 3 {
        // permissive
        0 => PolicyJson {
            max_tx_amount: U128(BUDGET),
            max_pending_amount: U128(BUDGET),
            max_pending_count: 10,
            max_counterparty_exposure: U128(BUDGET),
            max_delegated: U128(BUDGET),
            max_reservation_ttl_ns: U64(100 * UNIT),
        },
        // tight
        1 => PolicyJson {
            max_tx_amount: U128(200),
            max_pending_amount: U128(400),
            max_pending_count: 3,
            max_counterparty_exposure: U128(300),
            max_delegated: U128(300),
            max_reservation_ttl_ns: U64(50 * UNIT),
        },
        // cannot delegate
        _ => PolicyJson {
            max_tx_amount: U128(150),
            max_pending_amount: U128(300),
            max_pending_count: 2,
            max_counterparty_exposure: U128(200),
            max_delegated: U128(0),
            max_reservation_ttl_ns: U64(50 * UNIT),
        },
    }
}

#[derive(Clone, Debug)]
enum Op {
    Register { by: usize, agent: usize, parent: Option<usize>, policy: u8, alloc: u128 },
    Delegate { by: usize, child: usize, amount: u128 },
    Reclaim { by: usize, child: usize, amount: u128 },
    Revoke { by: usize, agent: usize },
    Reserve { agent: usize, req: u8, cp: usize, amount: u128, ttl: u64 },
    Execute { by: usize, rid: u64 },
    /// The runtime delivering a transfer outcome. May arrive arbitrarily later than `Execute`,
    /// interleaved with any other operation.
    Callback { rid: u64, ok: bool },
    Release { by: usize, rid: u64 },
    ReleaseExpired { rids: Vec<u64> },
    Advance { secs: u64 },
    Pause { on: bool },
}

fn amount() -> impl Strategy<Value = u128> {
    prop_oneof![
        4 => 1u128..=400,
        1 => Just(0u128),
        1 => Just(BUDGET),
        1 => Just(u128::MAX),
    ]
}

fn op() -> impl Strategy<Value = Op> {
    let who = 0..=N_AGENTS + 1;
    let ag = 0..N_AGENTS;
    let rid = 0u64..24;
    prop_oneof![
        2 => (who.clone(), ag.clone(), proptest::option::weighted(0.7, ag.clone()), any::<u8>(), amount())
            .prop_map(|(by, agent, parent, policy, alloc)| Op::Register { by, agent, parent, policy, alloc }),
        2 => (who.clone(), ag.clone(), amount()).prop_map(|(by, child, amount)| Op::Delegate { by, child, amount }),
        1 => (who.clone(), ag.clone(), amount()).prop_map(|(by, child, amount)| Op::Reclaim { by, child, amount }),
        1 => (who.clone(), ag.clone()).prop_map(|(by, agent)| Op::Revoke { by, agent }),
        8 => (ag.clone(), 0u8..12, 0..N_COUNTERPARTIES, amount(), prop_oneof![Just(1u64), Just(10), Just(60), Just(0), Just(1_000)])
            .prop_map(|(agent, req, cp, amount, ttl)| Op::Reserve { agent, req, cp, amount, ttl: ttl * UNIT }),
        4 => (who.clone(), rid.clone()).prop_map(|(by, rid)| Op::Execute { by, rid }),
        4 => (rid.clone(), any::<bool>()).prop_map(|(rid, ok)| Op::Callback { rid, ok }),
        3 => (who.clone(), rid.clone()).prop_map(|(by, rid)| Op::Release { by, rid }),
        1 => proptest::collection::vec(rid, 0..4).prop_map(|rids| Op::ReleaseExpired { rids }),
        2 => prop_oneof![Just(1u64), Just(20), Just(100)].prop_map(|secs| Op::Advance { secs }),
        1 => any::<bool>().prop_map(|on| Op::Pause { on }),
    ]
}

/// Suppress the panic messages of expected contract rejections only (the mock wraps them as
/// `HostError(GuestPanic { panic_msg: "CIRCUIT:..." })`).
fn quiet_rejections() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let default = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let msg = info
                .payload()
                .downcast_ref::<String>()
                .map(String::as_str)
                .or_else(|| info.payload().downcast_ref::<&str>().copied())
                .unwrap_or("");
            if !msg.contains("CIRCUIT:") {
                default(info);
            }
        }));
    });
}

struct Chain {
    storage: HashMap<Vec<u8>, Vec<u8>>,
    now: u64,
    /// Reservations seen in a terminal state, for I9.
    terminal: HashMap<u64, ReservationStatus>,
    committed: usize,
}

impl Chain {
    fn install(&self, who: &AccountId, deposit: u128, results: Vec<PromiseResult>) {
        let ctx = VMContextBuilder::new()
            .current_account_id(contract())
            .predecessor_account_id(who.clone())
            .signer_account_id(who.clone())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .account_balance(NearToken::from_near(1_000_000))
            .prepaid_gas(Gas::from_tgas(300))
            .block_timestamp(self.now)
            .build();
        env::set_blockchain_interface(MockedBlockchain::new(
            ctx,
            test_vm_config(),
            RuntimeFeesConfig::test(),
            results,
            self.storage.clone(),
            Default::default(),
            None,
        ));
    }

    fn genesis() -> Self {
        let mut chain = Chain { storage: HashMap::new(), now: 1_000 * UNIT, terminal: HashMap::new(), committed: 0 };
        chain.install(&owner(), BUDGET, vec![]);
        let mut c = Circuit::new(owner());
        c.fund_treasury();
        chain.commit(c);
        chain
    }

    fn commit(&mut self, mut c: Circuit) {
        c.flush_collections();
        env::state_write(&c);
        drop(c);
        self.storage = near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
    }

    /// Runs `f` as one atomic receipt. Returns whether it committed.
    fn tx(
        &mut self,
        who: &AccountId,
        deposit: u128,
        results: Vec<PromiseResult>,
        f: impl FnOnce(&mut Circuit),
    ) -> bool {
        self.install(who, deposit, results);
        let mut c: Circuit = env::state_read().expect("contract state");
        let ok = catch_unwind(AssertUnwindSafe(|| f(&mut c))).is_ok();
        if ok {
            self.commit(c);
            self.committed += 1;
        } else {
            std::mem::forget(c); // never flush a rolled-back receipt's cached writes
        }
        ok
    }

    fn apply(&mut self, op: &Op) -> bool {
        match op.clone() {
            Op::Register { by, agent: a, parent, policy: p, alloc } => {
                self.tx(&caller(by), DEPOSIT, vec![], |c| {
                    c.register_agent(agent(a), parent.map(agent), policy(p), U128(alloc));
                })
            }
            Op::Delegate { by, child, amount } => self.tx(&caller(by), 0, vec![], |c| {
                c.delegate_budget(agent(child), U128(amount));
            }),
            Op::Reclaim { by, child, amount } => self.tx(&caller(by), 0, vec![], |c| {
                c.reclaim_budget(agent(child), U128(amount));
            }),
            Op::Revoke { by, agent: a } => self.tx(&caller(by), 0, vec![], |c| {
                c.revoke_agent(agent(a));
            }),
            Op::Reserve { agent: a, req, cp, amount, ttl } => {
                self.tx(&agent(a), DEPOSIT, vec![], |c| {
                    c.reserve(format!("req-{req}"), counterparty(cp), U128(amount), U64(ttl));
                })
            }
            Op::Execute { by, rid } => self.tx(&caller(by), 0, vec![], |c| {
                let _ = c.execute(U64(rid));
            }),
            Op::Callback { rid, ok } => {
                let result = if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed };
                self.tx(&contract(), 0, vec![result], |c| {
                    c.on_execute(U64(rid));
                })
            }
            Op::Release { by, rid } => self.tx(&caller(by), 0, vec![], |c| {
                c.release(U64(rid));
            }),
            Op::ReleaseExpired { rids } => self.tx(&acc("anyone.test"), 0, vec![], |c| {
                c.release_expired(rids.into_iter().map(U64).collect());
            }),
            Op::Advance { secs } => {
                self.now += secs * UNIT;
                true
            }
            Op::Pause { on } => self.tx(&owner(), 0, vec![], |c| c.set_paused(on)),
        }
    }

    /// Recomputes every invariant from raw state and compares with the stored counters.
    fn check(&mut self) {
        self.install(&owner(), 0, vec![]);
        let c: Circuit = env::state_read().expect("contract state");
        let t = &c.treasury;
        let agents: Vec<(AccountId, Agent)> =
            c.agents.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let by_id: HashMap<&AccountId, &Agent> = agents.iter().map(|(k, v)| (k, v)).collect();

        let (mut spent, mut reserved, mut top_alloc) = (0u128, 0u128, 0u128);
        for (id, a) in &agents {
            let committed = a.spent.checked_add(a.reserved).and_then(|x| x.checked_add(a.delegated));
            assert!(committed.is_some_and(|x| x <= a.allocation), "I1 {id}: {a:?}");
            let children: u128 = agents
                .iter()
                .filter(|(_, ch)| ch.parent.as_ref() == Some(id))
                .map(|(_, ch)| ch.allocation)
                .sum();
            assert_eq!(a.delegated, children, "I2 {id}");
            if let Some(p) = &a.parent {
                let pa = by_id.get(p).expect("parent exists");
                assert_eq!(a.depth, pa.depth + 1, "depth {id}");
            } else {
                assert_eq!(a.depth, 1);
                top_alloc += a.allocation;
            }
            assert!(a.depth <= crate::MAX_DEPTH);
            spent += a.spent;
            reserved += a.reserved;
        }
        assert_eq!(t.allocated, top_alloc, "I3");
        assert!(t.allocated <= t.total_budget, "I3 bound");
        assert_eq!(t.total_spent, spent, "I4 spent");
        assert_eq!(t.total_reserved, reserved, "I4 reserved");
        assert!(t.total_spent + t.total_reserved <= t.allocated, "I5");
        assert_eq!(t.total_budget, BUDGET, "budget is never altered by agent activity");

        // I6, I7, in-flight and request-index consistency, from the reservation records.
        let mut live_amount: HashMap<AccountId, u128> = HashMap::new();
        let mut live_count: HashMap<AccountId, u32> = HashMap::new();
        let mut settled: HashMap<AccountId, u128> = HashMap::new();
        let mut exposure: HashMap<(AccountId, AccountId), u128> = HashMap::new();
        let mut in_flight = 0u128;
        for rid in 0..c.next_reservation_id {
            let r = c.reservations.get(&rid).expect("ids are dense");
            assert_eq!(
                c.request_index.get(&pair_key(r.agent.as_str(), &r.request_id)),
                Some(&rid),
                "request index"
            );
            if let Some(prev) = self.terminal.get(&rid) {
                assert_eq!(*prev, r.status, "I9: terminal reservation {rid} changed");
            }
            match r.status {
                ReservationStatus::Reserved | ReservationStatus::Executing => {
                    *live_amount.entry(r.agent.clone()).or_default() += r.amount;
                    *live_count.entry(r.agent.clone()).or_default() += 1;
                    if r.status == ReservationStatus::Executing {
                        in_flight += r.amount;
                    }
                }
                ReservationStatus::Settled => {
                    *settled.entry(r.agent.clone()).or_default() += r.amount;
                    self.terminal.insert(rid, r.status);
                }
                ReservationStatus::Released => {
                    self.terminal.insert(rid, r.status);
                }
            }
            if r.status != ReservationStatus::Released {
                for anc in c.path_of(&r.agent) {
                    *exposure.entry((anc, r.counterparty.clone())).or_default() += r.amount;
                }
            }
        }
        assert_eq!(t.in_flight, in_flight, "in_flight");
        for (id, a) in &agents {
            assert_eq!(a.reserved, live_amount.get(id).copied().unwrap_or(0), "I6 reserved {id}");
            assert_eq!(a.pending_count, live_count.get(id).copied().unwrap_or(0), "I6 count {id}");
            assert_eq!(a.spent, settled.get(id).copied().unwrap_or(0), "spent = settled {id}");
            for k in 0..N_COUNTERPARTIES {
                let cp = counterparty(k);
                let stored = c.exposure.get(&pair_key(id.as_str(), cp.as_str())).copied().unwrap_or(0);
                let expected = exposure.get(&(id.clone(), cp.clone())).copied().unwrap_or(0);
                assert_eq!(stored, expected, "I7 exposure {id} -> {cp}");
                // Policies are immutable, and exposure only grows through a checked reserve.
                assert!(stored <= a.policy.max_counterparty_exposure, "branch cap {id} -> {cp}");
            }
        }
        std::mem::forget(c);
    }
}

/// A fixed starting hierarchy so random sequences spend most of their time on interesting
/// states: a0 (top, permissive) → a1 (tight) → a2 (no delegation); a3 (top, tight).
fn seed(chain: &mut Chain) {
    let setup = [
        Op::Register { by: 0, agent: 0, parent: None, policy: 0, alloc: 700 },
        Op::Register { by: 0, agent: 3, parent: None, policy: 1, alloc: 250 },
        Op::Register { by: 1, agent: 1, parent: Some(0), policy: 1, alloc: 300 },
        Op::Register { by: 2, agent: 2, parent: Some(1), policy: 2, alloc: 150 },
    ];
    for op in &setup {
        assert!(chain.apply(op), "seed op failed: {op:?}");
    }
    chain.check();
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, max_shrink_iters: 2_000, ..ProptestConfig::default() })]

    /// Any interleaving of operations — including rejected ones, out-of-order and duplicated
    /// callbacks, expiry, revocation and pausing — preserves every invariant.
    #[test]
    fn invariants_hold_for_any_operation_sequence(ops in proptest::collection::vec(op(), 1..80)) {
        quiet_rejections();
        let mut chain = Chain::genesis();
        seed(&mut chain);
        for op in &ops {
            chain.apply(op);
            chain.check();
        }
    }

    /// The concurrency experiment at unit level: 10 agents submit 20 competing requests whose
    /// total exceeds the budget. Whatever order the chain processes them in, accepted
    /// commitments never exceed the budget, and each agent's own carve-out bounds its accepted
    /// total.
    #[test]
    fn competing_requests_never_exceed_budget(
        order in Just((0..20usize).collect::<Vec<_>>()).prop_shuffle(),
        amounts in proptest::collection::vec(1u128..=150, 20),
    ) {
        quiet_rejections();
        let mut chain = Chain::genesis();
        // Ten top-level agents with 100 each: 1000 allocated, requests total up to 3000.
        for i in 0..10usize {
            let name = format!("w{i}.test");
            chain.tx(&owner(), DEPOSIT, vec![], |c| {
                c.register_agent(acc(&name), None, policy(0), U128(100));
            });
        }
        let mut accepted = 0u128;
        for &k in &order {
            let who = acc(&format!("w{}.test", k % 10));
            let amt = amounts[k];
            if chain.tx(&who, DEPOSIT, vec![], |c| {
                c.reserve(format!("job-{k}"), counterparty(k % N_COUNTERPARTIES), U128(amt), U64(10 * UNIT));
            }) {
                accepted += amt;
            }
        }
        let requested: u128 = amounts.iter().sum();
        prop_assert!(accepted <= BUDGET);
        prop_assert!(accepted <= requested);
        chain.install(&owner(), 0, vec![]);
        let c: Circuit = env::state_read().unwrap();
        prop_assert_eq!(c.treasury.total_reserved, accepted);
        std::mem::forget(c);
        chain.check();
    }
}
