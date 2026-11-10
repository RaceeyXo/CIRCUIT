//! CIRCUIT — financial control layer for autonomous agent networks.
//!
//! Security model (see docs/architecture.md):
//! * The contract holds the treasury NEAR and is the only party that can move it.
//! * Carve-out accounting: delegating moves allocation out of the parent. A reservation only
//!   touches the reserving agent and the global counters, so nothing is double counted.
//! * Branch-wide checks (revocation, per-path policy limits, counterparty exposure) walk the
//!   agent's ancestors. `parent` is immutable and depth ≤ MAX_DEPTH, so the walk is bounded.
//! * Every state-growing call is paid for by the caller's attached deposit, and every such
//!   call asserts that treasury liabilities stay covered by the free account balance.

use near_sdk::borsh::BorshSerialize;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise};

pub mod agents;
pub mod errors;
pub mod events;
pub mod policies;
pub mod reservations;
pub mod treasury;

#[cfg(test)]
mod tests;

use agents::{Agent, AgentStatus};
use errors::{fail, require, sub, Error};
use reservations::Reservation;
use treasury::Treasury;

/// Maximum depth of the hierarchy. Top-level agents (children of the treasury) have depth 1.
pub const MAX_DEPTH: u8 = 4;

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    Agents,
    Reservations,
    RequestIndex,
    Exposure,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Circuit {
    treasury: Treasury,
    agents: IterableMap<AccountId, Agent>,
    reservations: LookupMap<u64, Reservation>,
    /// sha256(agent ‖ 0x00 ‖ request_id) → reservation id. Fixed-size keys bound storage.
    request_index: LookupMap<[u8; 32], u64>,
    /// sha256(agent ‖ 0x00 ‖ counterparty) → branch exposure of `agent` to `counterparty`.
    exposure: LookupMap<[u8; 32], u128>,
    next_reservation_id: u64,
}

#[near]
impl Circuit {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            treasury: Treasury::new(owner),
            agents: IterableMap::new(StorageKey::Agents),
            reservations: LookupMap::new(StorageKey::Reservations),
            request_index: LookupMap::new(StorageKey::RequestIndex),
            exposure: LookupMap::new(StorageKey::Exposure),
            next_reservation_id: 0,
        }
    }
}

/// Internal helpers shared by the module impls.
impl Circuit {
    pub(crate) fn assert_owner(&self) {
        require(
            env::predecessor_account_id() == self.treasury.owner,
            Error::NotOwner,
            "caller is not the treasury owner",
        );
    }

    pub(crate) fn assert_not_paused(&self) {
        require(!self.treasury.paused, Error::Paused, "contract is paused");
    }

    pub(crate) fn agent(&self, id: &AccountId) -> &Agent {
        self.agents
            .get(id)
            .unwrap_or_else(|| fail(Error::AgentNotFound, id.as_str()))
    }

    pub(crate) fn agent_mut(&mut self, id: &AccountId) -> &mut Agent {
        self.agents
            .get_mut(id)
            .unwrap_or_else(|| fail(Error::AgentNotFound, id.as_str()))
    }

    /// `[agent, parent, grandparent, …, top-level]`. Length ≤ MAX_DEPTH by construction.
    pub(crate) fn path_of(&self, id: &AccountId) -> Vec<AccountId> {
        let mut path = Vec::with_capacity(MAX_DEPTH as usize);
        let mut cur = Some(id.clone());
        while let Some(a) = cur {
            cur = self.agent(&a).parent.clone();
            path.push(a);
        }
        path
    }

    /// Fails unless every agent on the path is Active. Index 0 is the agent itself.
    pub(crate) fn assert_path_active(&self, path: &[AccountId]) {
        for (i, id) in path.iter().enumerate() {
            if self.agent(id).status == AgentStatus::Revoked {
                if i == 0 {
                    fail(Error::AgentRevoked, id.as_str())
                } else {
                    fail(Error::AncestorRevoked, id.as_str())
                }
            }
        }
    }

    pub(crate) fn flush_collections(&mut self) {
        self.agents.flush();
        self.reservations.flush();
        self.request_index.flush();
        self.exposure.flush();
    }

    /// Charges the caller for storage added since `before` and returns the refund amount.
    /// Collections are flushed first so `storage_usage()` reflects the real writes.
    pub(crate) fn charge_storage(&mut self, before: u64, deposit: u128) -> u128 {
        self.flush_collections();
        let added = env::storage_usage().saturating_sub(before) as u128;
        let cost = added
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap_or_else(|| fail(Error::ArithmeticOverflow, "storage cost"));
        require(
            deposit >= cost,
            Error::InsufficientStorageDeposit,
            format!("required {cost} yoctoNEAR, attached {deposit}"),
        );
        deposit - cost
    }

    /// Invariant I8: the balance left after `outgoing` transfers and storage staking must cover
    /// every unspent treasury obligation that has not already left the account.
    pub(crate) fn assert_custody(&self, outgoing: u128) {
        let balance = env::account_balance().as_yoctonear();
        let storage = (env::storage_usage() as u128)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap_or_else(|| fail(Error::ArithmeticOverflow, "storage cost"));
        let liabilities = sub(
            sub(self.treasury.total_budget, self.treasury.total_spent),
            self.treasury.in_flight,
        );
        let free = balance
            .checked_sub(outgoing)
            .and_then(|b| b.checked_sub(storage))
            .unwrap_or(0);
        require(
            free >= liabilities,
            Error::CustodyViolation,
            format!("free balance {free} < liabilities {liabilities}"),
        );
    }

    pub(crate) fn refund(to: &AccountId, amount: u128) {
        if amount > 0 {
            Promise::new(to.clone()).transfer(NearToken::from_yoctonear(amount)).detach();
        }
    }
}

/// sha256(a ‖ 0x00 ‖ b). `AccountId` and validated request ids never contain 0x00, so the
/// encoding is injective.
pub(crate) fn pair_key(a: &str, b: &str) -> [u8; 32] {
    let mut buf = Vec::with_capacity(a.len() + b.len() + 1);
    buf.extend_from_slice(a.as_bytes());
    buf.push(0);
    buf.extend_from_slice(b.as_bytes());
    env::sha256_array(&buf)
}
