//! Agent policies.
//!
//! Policies are enforced along the agent's whole path (agent + every ancestor) at reserve
//! time, so a parent's limits bind its entire branch even if a child's own policy were looser.
//! Monotonicity at registration (child ≤ parent) is therefore a usability guarantee, not the
//! security boundary.

use near_sdk::json_types::{U128, U64};
use near_sdk::near;

use crate::errors::{require, Error};

/// Hard upper bound on any reservation TTL: 30 days.
pub const GLOBAL_MAX_TTL_NS: u64 = 30 * 24 * 60 * 60 * 1_000_000_000;
/// Hard upper bound on live reservations per agent (bounds live storage per agent).
pub const GLOBAL_MAX_PENDING_COUNT: u32 = 1_000;

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    pub max_tx_amount: u128,
    pub max_pending_amount: u128,
    pub max_pending_count: u32,
    /// Branch-level: caps exposure (reserved + executing + settled) of this agent *and all
    /// its descendants* to any single counterparty.
    pub max_counterparty_exposure: u128,
    /// Cap on `Agent::delegated`. Zero means the agent cannot delegate or register children.
    pub max_delegated: u128,
    pub max_reservation_ttl_ns: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PolicyJson {
    pub max_tx_amount: U128,
    pub max_pending_amount: U128,
    pub max_pending_count: u32,
    pub max_counterparty_exposure: U128,
    pub max_delegated: U128,
    pub max_reservation_ttl_ns: U64,
}

impl From<PolicyJson> for Policy {
    fn from(p: PolicyJson) -> Self {
        Policy {
            max_tx_amount: p.max_tx_amount.0,
            max_pending_amount: p.max_pending_amount.0,
            max_pending_count: p.max_pending_count,
            max_counterparty_exposure: p.max_counterparty_exposure.0,
            max_delegated: p.max_delegated.0,
            max_reservation_ttl_ns: p.max_reservation_ttl_ns.0,
        }
    }
}

impl From<&Policy> for PolicyJson {
    fn from(p: &Policy) -> Self {
        PolicyJson {
            max_tx_amount: U128(p.max_tx_amount),
            max_pending_amount: U128(p.max_pending_amount),
            max_pending_count: p.max_pending_count,
            max_counterparty_exposure: U128(p.max_counterparty_exposure),
            max_delegated: U128(p.max_delegated),
            max_reservation_ttl_ns: U64(p.max_reservation_ttl_ns),
        }
    }
}

impl Policy {
    pub fn validate(&self) {
        require(
            self.max_reservation_ttl_ns > 0 && self.max_reservation_ttl_ns <= GLOBAL_MAX_TTL_NS,
            Error::InvalidPolicy,
            "max_reservation_ttl_ns out of range",
        );
        require(
            self.max_pending_count <= GLOBAL_MAX_PENDING_COUNT,
            Error::InvalidPolicy,
            "max_pending_count out of range",
        );
    }

    /// True if every limit of `self` is no looser than `parent`'s.
    pub fn is_within(&self, parent: &Policy) -> bool {
        self.max_tx_amount <= parent.max_tx_amount
            && self.max_pending_amount <= parent.max_pending_amount
            && self.max_pending_count <= parent.max_pending_count
            && self.max_counterparty_exposure <= parent.max_counterparty_exposure
            && self.max_delegated <= parent.max_delegated
            && self.max_reservation_ttl_ns <= parent.max_reservation_ttl_ns
    }
}
