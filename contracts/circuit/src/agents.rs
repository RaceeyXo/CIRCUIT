//! Agent registry and hierarchical budget delegation (carve-out accounting).
//!
//! Delegating `x` to a child: `parent.delegated += x`, `child.allocation += x`. The parent's
//! available budget shrinks by exactly `x`, once. The child's later reservations are charged
//! only to the child. This keeps invariants I1–I3 with O(1) work per operation.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{env, near, AccountId};

use crate::errors::{add, fail, require, sub, Error};
use crate::events::emit;
use crate::policies::{Policy, PolicyJson};
use crate::{Circuit, CircuitExt, MAX_DEPTH};

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentStatus {
    Active,
    /// Irreversible. Blocks new commitments by the agent and its entire branch.
    Revoked,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Agent {
    /// None ⇒ top-level agent funded directly by the treasury. Immutable after registration.
    pub parent: Option<AccountId>,
    /// 1 for top-level agents.
    pub depth: u8,
    pub allocation: u128,
    pub spent: u128,
    /// RESERVED + EXECUTING reservations of this agent only.
    pub reserved: u128,
    /// Σ allocation of direct children.
    pub delegated: u128,
    pub pending_count: u32,
    pub status: AgentStatus,
    pub policy: Policy,
    pub created_at: u64,
    pub revoked_at: Option<u64>,
}

impl Agent {
    /// allocation − spent − reserved − delegated. I1 guarantees this never underflows.
    pub fn available(&self) -> u128 {
        sub(
            sub(sub(self.allocation, self.spent), self.reserved),
            self.delegated,
        )
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentView {
    pub id: AccountId,
    pub parent: Option<AccountId>,
    pub depth: u8,
    pub allocation: U128,
    pub spent: U128,
    pub reserved: U128,
    pub delegated: U128,
    pub available: U128,
    pub pending_count: u32,
    pub status: AgentStatus,
    pub policy: PolicyJson,
    pub created_at: U64,
    pub revoked_at: Option<U64>,
}

impl AgentView {
    fn from_agent(id: &AccountId, a: &Agent) -> Self {
        AgentView {
            id: id.clone(),
            parent: a.parent.clone(),
            depth: a.depth,
            allocation: U128(a.allocation),
            spent: U128(a.spent),
            reserved: U128(a.reserved),
            delegated: U128(a.delegated),
            available: U128(a.available()),
            pending_count: a.pending_count,
            status: a.status,
            policy: PolicyJson::from(&a.policy),
            created_at: U64(a.created_at),
            revoked_at: a.revoked_at.map(U64),
        }
    }
}

const MAX_PAGE: u32 = 100;

#[near]
impl Circuit {
    /// Registers `agent_id` under `parent` with an initial allocation carved out of the parent.
    /// * `parent == None`: owner only; allocation comes from the treasury's unallocated budget.
    /// * `parent == Some(p)`: caller must be `p`, an Active agent on an Active branch, allowed
    ///   to delegate, below MAX_DEPTH. The child policy must be within the parent's.
    ///
    /// The caller pays the storage cost via the attached deposit; any excess is refunded.
    #[payable]
    pub fn register_agent(
        &mut self,
        agent_id: AccountId,
        parent: Option<AccountId>,
        policy: PolicyJson,
        allocation: U128,
    ) -> AgentView {
        self.assert_not_paused();
        let caller = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        let allocation = allocation.0;
        let policy: Policy = policy.into();
        policy.validate();

        require(
            !self.agents.contains_key(&agent_id),
            Error::AgentExists,
            agent_id.as_str(),
        );
        require(
            agent_id != env::current_account_id() && agent_id != self.treasury.owner,
            Error::InvalidAgentId,
            "the contract and the owner cannot be agents",
        );

        let storage_before = env::storage_usage();
        let depth = match &parent {
            None => {
                self.assert_owner();
                let unallocated = sub(self.treasury.total_budget, self.treasury.allocated);
                require(
                    allocation <= unallocated,
                    Error::ExceedsUnallocated,
                    format!("unallocated {unallocated}"),
                );
                self.treasury.allocated = add(self.treasury.allocated, allocation);
                1
            }
            Some(p) => {
                require(caller == *p, Error::Unauthorized, "only the parent can register children");
                let path = self.path_of(p);
                self.assert_path_active(&path);
                let pa = self.agent(p).clone();
                require(pa.depth < MAX_DEPTH, Error::DepthExceeded, format!("max depth {MAX_DEPTH}"));
                require(
                    policy.is_within(&pa.policy),
                    Error::PolicyExceedsParent,
                    "child policy must not exceed the parent's",
                );
                self.assert_can_delegate(p, &pa, allocation);
                self.agent_mut(p).delegated = add(pa.delegated, allocation);
                pa.depth + 1
            }
        };

        let agent = Agent {
            parent: parent.clone(),
            depth,
            allocation,
            spent: 0,
            reserved: 0,
            delegated: 0,
            pending_count: 0,
            status: AgentStatus::Active,
            policy,
            created_at: env::block_timestamp(),
            revoked_at: None,
        };
        let view = AgentView::from_agent(&agent_id, &agent);
        self.agents.insert(agent_id.clone(), agent);

        let refund = self.charge_storage(storage_before, deposit);
        self.assert_custody(refund);
        emit(
            "agent_registered",
            json!({ "agent": agent_id, "parent": parent, "depth": depth,
                    "allocation": U128(allocation), "by": caller }),
        );
        Self::refund(&caller, refund);
        view
    }

    /// Moves `amount` of the parent's available budget (or the treasury's unallocated budget,
    /// for a top-level agent) into the child's allocation.
    pub fn delegate_budget(&mut self, child: AccountId, amount: U128) -> AgentView {
        self.assert_not_paused();
        let amount = amount.0;
        require(amount > 0, Error::ZeroAmount, "amount must be > 0");
        let parent = self.assert_manager(&child);
        // The child's whole branch must be Active: no new budget into a revoked branch.
        let path = self.path_of(&child);
        self.assert_path_active(&path);

        match &parent {
            None => {
                let unallocated = sub(self.treasury.total_budget, self.treasury.allocated);
                require(
                    amount <= unallocated,
                    Error::ExceedsUnallocated,
                    format!("unallocated {unallocated}"),
                );
                self.treasury.allocated = add(self.treasury.allocated, amount);
            }
            Some(p) => {
                let pa = self.agent(p).clone();
                self.assert_can_delegate(p, &pa, amount);
                self.agent_mut(p).delegated = add(pa.delegated, amount);
            }
        }
        let c = self.agent_mut(&child);
        c.allocation = add(c.allocation, amount);
        emit(
            "budget_delegated",
            json!({ "agent": child, "amount": U128(amount), "by": env::predecessor_account_id() }),
        );
        self.get_agent(child).expect("exists")
    }

    /// Returns up to the child's *available* budget to its parent (or to the treasury's
    /// unallocated pool). Allowed while paused and for revoked children: it only reduces
    /// exposure. Reserved/spent/delegated amounts of the child are never reclaimable.
    pub fn reclaim_budget(&mut self, child: AccountId, amount: U128) -> AgentView {
        let amount = amount.0;
        require(amount > 0, Error::ZeroAmount, "amount must be > 0");
        let parent = self.assert_manager(&child);
        let available = self.agent(&child).available();
        require(
            amount <= available,
            Error::InsufficientBudget,
            format!("child available {available}"),
        );
        let c = self.agent_mut(&child);
        c.allocation = sub(c.allocation, amount);
        match &parent {
            None => self.treasury.allocated = sub(self.treasury.allocated, amount),
            Some(p) => {
                let pa = self.agent_mut(p);
                pa.delegated = sub(pa.delegated, amount);
            }
        }
        emit(
            "budget_reclaimed",
            json!({ "agent": child, "amount": U128(amount), "by": env::predecessor_account_id() }),
        );
        self.get_agent(child).expect("exists")
    }

    /// Irreversibly revokes `agent` and thereby its whole branch (enforced by the ancestor walk
    /// on every reserve/execute). Caller: the owner or any Active ancestor. O(1).
    pub fn revoke_agent(&mut self, agent: AccountId) -> AgentView {
        let caller = env::predecessor_account_id();
        let path = self.path_of(&agent);
        let authorized = caller == self.treasury.owner
            || path[1..].iter().any(|a| {
                *a == caller && self.agent(a).status == AgentStatus::Active
            });
        require(
            authorized,
            Error::Unauthorized,
            "only the owner or an active ancestor can revoke",
        );
        let a = self.agent_mut(&agent);
        require(a.status == AgentStatus::Active, Error::AlreadyRevoked, agent.as_str());
        a.status = AgentStatus::Revoked;
        a.revoked_at = Some(env::block_timestamp());
        emit("agent_revoked", json!({ "agent": agent, "by": caller }));
        self.get_agent(agent).expect("exists")
    }

    pub fn get_agent(&self, agent: AccountId) -> Option<AgentView> {
        self.agents.get(&agent).map(|a| AgentView::from_agent(&agent, a))
    }

    pub fn get_agents(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<AgentView> {
        self.agents
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE) as usize)
            .map(|(id, a)| AgentView::from_agent(id, a))
            .collect()
    }
}

impl Circuit {
    /// The account allowed to manage `child`'s budget: its parent, or the owner for top-level
    /// agents. Returns the child's parent.
    fn assert_manager(&self, child: &AccountId) -> Option<AccountId> {
        let parent = self.agent(child).parent.clone();
        match &parent {
            None => self.assert_owner(),
            Some(p) => require(
                env::predecessor_account_id() == *p,
                Error::Unauthorized,
                "only the parent manages this agent's budget",
            ),
        }
        parent
    }

    fn assert_can_delegate(&self, id: &AccountId, pa: &Agent, amount: u128) {
        if pa.policy.max_delegated == 0 {
            fail(Error::DelegationLimit, format!("{id} may not delegate"));
        }
        let available = pa.available();
        require(
            amount <= available,
            Error::InsufficientBudget,
            format!("{id} available {available}"),
        );
        require(
            add(pa.delegated, amount) <= pa.policy.max_delegated,
            Error::DelegationLimit,
            format!("{id} max_delegated {}", pa.policy.max_delegated),
        );
    }
}
