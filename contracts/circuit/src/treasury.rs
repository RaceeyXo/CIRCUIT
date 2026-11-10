//! Treasury: custody of NEAR and the global counters.
//!
//! Funds enter only via `fund_treasury` and leave only via a reservation payout (`execute`)
//! or `withdraw_unallocated`, which can never touch funds already allocated to agents.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, AccountId, NearToken, Promise};

use crate::errors::{add, require, sub, Error};
use crate::events::emit;
use crate::Circuit;

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Treasury {
    pub owner: AccountId,
    /// NEAR deposited via `fund_treasury` (net of withdrawals): the authorised budget.
    pub total_budget: u128,
    /// Σ allocation of top-level agents.
    pub allocated: u128,
    /// Σ agent.spent.
    pub total_spent: u128,
    /// Σ agent.reserved (RESERVED + EXECUTING).
    pub total_reserved: u128,
    /// Amount of EXECUTING reservations whose transfer has left (or is leaving) the account.
    pub in_flight: u128,
    pub paused: bool,
}

impl Treasury {
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            total_budget: 0,
            allocated: 0,
            total_spent: 0,
            total_reserved: 0,
            in_flight: 0,
            paused: false,
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TreasuryView {
    pub owner: AccountId,
    pub total_budget: U128,
    pub allocated: U128,
    pub unallocated: U128,
    pub total_spent: U128,
    pub total_reserved: U128,
    pub in_flight: U128,
    /// total_budget − total_spent − total_reserved
    pub remaining: U128,
    pub paused: bool,
    pub agent_count: u32,
    pub reservation_count: u64,
}

#[near]
impl Circuit {
    /// Owner-only. The attached deposit is added to the authorised budget, 1:1.
    #[payable]
    pub fn fund_treasury(&mut self) -> TreasuryView {
        self.assert_owner();
        let amount = env::attached_deposit().as_yoctonear();
        require(amount > 0, Error::ZeroAmount, "attach NEAR to fund the treasury");
        self.treasury.total_budget = add(self.treasury.total_budget, amount);
        emit(
            "treasury_funded",
            json!({ "amount": U128(amount), "total_budget": U128(self.treasury.total_budget) }),
        );
        self.get_treasury()
    }

    /// Owner-only. Withdraws budget that has not been allocated to any agent.
    pub fn withdraw_unallocated(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        let amount = amount.0;
        require(amount > 0, Error::ZeroAmount, "amount must be > 0");
        let unallocated = sub(self.treasury.total_budget, self.treasury.allocated);
        require(
            amount <= unallocated,
            Error::ExceedsUnallocated,
            format!("unallocated {unallocated}"),
        );
        self.treasury.total_budget -= amount;
        self.assert_custody(amount);
        emit(
            "treasury_withdrawn",
            json!({ "amount": U128(amount), "total_budget": U128(self.treasury.total_budget) }),
        );
        Promise::new(self.treasury.owner.clone()).transfer(NearToken::from_yoctonear(amount))
    }

    /// Owner-only emergency stop. Blocks new commitments (register, delegate, reserve, execute).
    /// Exposure-reducing actions (release, revoke, reclaim) stay available.
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.treasury.paused = paused;
        emit("paused_set", json!({ "paused": paused }));
    }

    pub fn get_treasury(&self) -> TreasuryView {
        let t = &self.treasury;
        TreasuryView {
            owner: t.owner.clone(),
            total_budget: U128(t.total_budget),
            allocated: U128(t.allocated),
            unallocated: U128(t.total_budget - t.allocated),
            total_spent: U128(t.total_spent),
            total_reserved: U128(t.total_reserved),
            in_flight: U128(t.in_flight),
            remaining: U128(t.total_budget - t.total_spent - t.total_reserved),
            paused: t.paused,
            agent_count: self.agents.len(),
            reservation_count: self.next_reservation_id,
        }
    }
}
