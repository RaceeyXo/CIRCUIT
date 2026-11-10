//! Reservation engine.
//!
//! ```text
//!  reserve ──► RESERVED ──execute──► EXECUTING ──transfer ok──► SETTLED
//!                │  ▲                    │
//!                │  └── transfer failed ─┘
//!                └── release / release_expired ──► RELEASED
//! ```
//! A rejected `reserve` panics, so REQUESTED → REJECTED leaves no state; the failed
//! transaction is the audit record. SETTLED and RELEASED are terminal.
//!
//! Async safety: while EXECUTING the amount stays in `reserved`, so concurrent reserves see it
//! as committed, and EXECUTING can be neither released nor expired (funds are in flight).
//! Only the contract's own private callback, driven by the transfer's promise result, can
//! settle a reservation.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{env, near, AccountId, Gas, NearToken, Promise, PromiseError};

use crate::agents::AgentStatus;
use crate::errors::{add, fail, require, sub, Error};
use crate::events::emit;
use crate::{pair_key, Circuit, CircuitExt};

/// Gas reserved for `on_execute`. The callback is O(1) and never panics.
pub const CALLBACK_GAS: Gas = Gas::from_tgas(15);
/// Minimum prepaid gas for `execute`: its own work + the transfer receipt + the callback.
pub const MIN_EXECUTE_GAS: Gas = Gas::from_tgas(40);
pub const MAX_REQUEST_ID_LEN: usize = 64;
pub const MAX_RELEASE_BATCH: usize = 50;
const MAX_PAGE: u64 = 100;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReservationStatus {
    Reserved,
    Executing,
    Settled,
    Released,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleaseReason {
    Agent,
    Ancestor,
    Owner,
    Expired,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Reservation {
    pub request_id: String,
    pub agent: AccountId,
    pub counterparty: AccountId,
    pub amount: u128,
    pub created_at: u64,
    pub expires_at: u64,
    pub status: ReservationStatus,
    pub closed_at: Option<u64>,
    pub release_reason: Option<ReleaseReason>,
    /// Number of payout attempts that came back failed.
    pub failed_attempts: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ReservationView {
    pub id: U64,
    pub request_id: String,
    pub agent: AccountId,
    pub counterparty: AccountId,
    pub amount: U128,
    pub created_at: U64,
    pub expires_at: U64,
    pub status: ReservationStatus,
    pub closed_at: Option<U64>,
    pub release_reason: Option<ReleaseReason>,
    pub failed_attempts: u32,
}

impl ReservationView {
    fn from_reservation(id: u64, r: &Reservation) -> Self {
        ReservationView {
            id: U64(id),
            request_id: r.request_id.clone(),
            agent: r.agent.clone(),
            counterparty: r.counterparty.clone(),
            amount: U128(r.amount),
            created_at: U64(r.created_at),
            expires_at: U64(r.expires_at),
            status: r.status,
            closed_at: r.closed_at.map(U64),
            release_reason: r.release_reason,
            failed_attempts: r.failed_attempts,
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ReserveResult {
    pub reservation: ReservationView,
    /// True if `(agent, request_id)` already existed with identical parameters; no new
    /// commitment was created.
    pub duplicate: bool,
}

fn validate_request_id(id: &str) {
    require(
        !id.is_empty()
            && id.len() <= MAX_REQUEST_ID_LEN
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b':' | b'.')),
        Error::InvalidRequestId,
        "1-64 chars of [A-Za-z0-9_-:.]",
    );
}

#[near]
impl Circuit {
    /// Atomically reserves `amount` for a future payment to `counterparty`.
    ///
    /// Idempotent on `(caller, request_id)`: a retry with identical counterparty and amount
    /// returns the existing reservation (any status) with `duplicate = true` and refunds the
    /// deposit; a retry with different parameters is rejected (REQUEST_ID_CONFLICT).
    /// `ttl_ns` is not part of the request identity.
    #[payable]
    pub fn reserve(
        &mut self,
        request_id: String,
        counterparty: AccountId,
        amount: U128,
        ttl_ns: U64,
    ) -> ReserveResult {
        let caller = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        let (amount, ttl) = (amount.0, ttl_ns.0);
        validate_request_id(&request_id);
        let agent = self.agent(&caller).clone();

        let req_key = pair_key(caller.as_str(), &request_id);
        if let Some(&id) = self.request_index.get(&req_key) {
            let r = self.reservations.get(&id).expect("request index is consistent");
            require(
                r.counterparty == counterparty && r.amount == amount,
                Error::RequestIdConflict,
                format!("request_id {request_id} already used with different parameters"),
            );
            let view = ReservationView::from_reservation(id, r);
            emit(
                "reservation_duplicate",
                json!({ "id": U64(id), "agent": caller, "request_id": request_id }),
            );
            Self::refund(&caller, deposit);
            return ReserveResult { reservation: view, duplicate: true };
        }

        self.assert_not_paused();
        require(amount > 0, Error::ZeroAmount, "amount must be > 0");
        require(ttl > 0, Error::InvalidTtl, "ttl must be > 0");
        require(
            counterparty != env::current_account_id() && counterparty != caller,
            Error::InvalidCounterparty,
            "counterparty cannot be the contract or the agent itself",
        );

        // Branch checks: every agent on the path must be Active and every policy on the path
        // binds (tx limit, ttl, branch counterparty exposure).
        let path = self.path_of(&caller);
        let mut exposure_keys = Vec::with_capacity(path.len());
        for (i, id) in path.iter().enumerate() {
            let a = self.agent(id);
            if a.status == AgentStatus::Revoked {
                fail(
                    if i == 0 { Error::AgentRevoked } else { Error::AncestorRevoked },
                    id.as_str(),
                );
            }
            require(
                amount <= a.policy.max_tx_amount,
                Error::ExceedsTxLimit,
                format!("{id} max_tx_amount {}", a.policy.max_tx_amount),
            );
            require(
                ttl <= a.policy.max_reservation_ttl_ns,
                Error::InvalidTtl,
                format!("{id} max_reservation_ttl_ns {}", a.policy.max_reservation_ttl_ns),
            );
            let key = pair_key(id.as_str(), counterparty.as_str());
            let exposure = self.exposure.get(&key).copied().unwrap_or(0);
            require(
                add(exposure, amount) <= a.policy.max_counterparty_exposure,
                Error::CounterpartyLimit,
                format!(
                    "{id} exposure to {counterparty} {exposure} + {amount} > {}",
                    a.policy.max_counterparty_exposure
                ),
            );
            exposure_keys.push((key, exposure));
        }

        // Agent-local checks.
        let available = agent.available();
        require(
            amount <= available,
            Error::InsufficientBudget,
            format!("available {available}, requested {amount}"),
        );
        require(
            add(agent.reserved, amount) <= agent.policy.max_pending_amount,
            Error::PendingAmountLimit,
            format!("max_pending_amount {}", agent.policy.max_pending_amount),
        );
        require(
            agent.pending_count < agent.policy.max_pending_count,
            Error::PendingCountLimit,
            format!("max_pending_count {}", agent.policy.max_pending_count),
        );

        // Effects.
        let storage_before = env::storage_usage();
        let now = env::block_timestamp();
        let expires_at = now
            .checked_add(ttl)
            .unwrap_or_else(|| fail(Error::InvalidTtl, "expiry overflow"));
        let id = self.next_reservation_id;
        self.next_reservation_id += 1;

        for (key, exposure) in exposure_keys {
            self.exposure.insert(key, exposure + amount);
        }
        let a = self.agent_mut(&caller);
        a.reserved = add(a.reserved, amount);
        a.pending_count += 1;
        self.treasury.total_reserved = add(self.treasury.total_reserved, amount);

        let reservation = Reservation {
            request_id: request_id.clone(),
            agent: caller.clone(),
            counterparty: counterparty.clone(),
            amount,
            created_at: now,
            expires_at,
            status: ReservationStatus::Reserved,
            closed_at: None,
            release_reason: None,
            failed_attempts: 0,
        };
        let view = ReservationView::from_reservation(id, &reservation);
        self.reservations.insert(id, reservation);
        self.request_index.insert(req_key, id);

        let refund = self.charge_storage(storage_before, deposit);
        self.assert_custody(refund);
        emit(
            "reservation_created",
            json!({ "id": U64(id), "agent": caller, "request_id": request_id,
                    "counterparty": counterparty, "amount": U128(amount),
                    "expires_at": U64(expires_at) }),
        );
        Self::refund(&caller, refund);
        ReserveResult { reservation: view, duplicate: false }
    }

    /// Pays out a RESERVED reservation. Only the reserving agent may call it, only before
    /// expiry, and only while its whole branch is Active. The transfer outcome is delivered to
    /// `on_execute`; the returned promise resolves to `true` if settled.
    pub fn execute(&mut self, reservation_id: U64) -> Promise {
        self.assert_not_paused();
        let id = reservation_id.0;
        require(
            env::prepaid_gas() >= MIN_EXECUTE_GAS,
            Error::InsufficientGas,
            format!("attach at least {} Tgas", MIN_EXECUTE_GAS.as_tgas()),
        );
        let r = self.reservation(id).clone();
        require(
            env::predecessor_account_id() == r.agent,
            Error::Unauthorized,
            "only the reserving agent can execute",
        );
        require(
            r.status == ReservationStatus::Reserved,
            Error::InvalidTransition,
            format!("{:?} -> Executing", r.status),
        );
        require(
            env::block_timestamp() < r.expires_at,
            Error::ReservationExpired,
            format!("expired at {}", r.expires_at),
        );
        let path = self.path_of(&r.agent);
        self.assert_path_active(&path);

        self.reservation_mut(id).status = ReservationStatus::Executing;
        self.treasury.in_flight = add(self.treasury.in_flight, r.amount);
        emit(
            "execution_started",
            json!({ "id": U64(id), "agent": r.agent, "counterparty": r.counterparty,
                    "amount": U128(r.amount) }),
        );
        Promise::new(r.counterparty.clone())
            .transfer(NearToken::from_yoctonear(r.amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_execute(reservation_id),
            )
    }

    /// Private callback. Settles on transfer success; returns the reservation to RESERVED on
    /// failure (the transfer's deposit is refunded to this account by the runtime).
    /// Deliberately contains no failing checks: a panic here would strand the reservation in
    /// EXECUTING.
    #[private]
    pub fn on_execute(&mut self, reservation_id: U64) -> bool {
        // A plain Transfer produces no return data, so read the raw result with a zero-byte
        // bound rather than JSON-decoding it (which could panic inside the callback).
        let result: Result<(), PromiseError> = if env::promise_results_count() == 1 {
            env::promise_result_checked(0, 0).map(|_| ())
        } else {
            Err(PromiseError::Failed)
        };
        let id = reservation_id.0;
        let Some(r) = self.reservations.get(&id).cloned() else {
            env::log_str("on_execute: unknown reservation");
            return false;
        };
        if r.status != ReservationStatus::Executing {
            env::log_str("on_execute: reservation not executing");
            return false;
        }
        self.treasury.in_flight -= r.amount;
        let now = env::block_timestamp();
        match result {
            Ok(()) => {
                let res = self.reservations.get_mut(&id).expect("checked");
                res.status = ReservationStatus::Settled;
                res.closed_at = Some(now);
                if let Some(a) = self.agents.get_mut(&r.agent) {
                    a.reserved -= r.amount;
                    a.spent += r.amount;
                    a.pending_count -= 1;
                }
                self.treasury.total_reserved -= r.amount;
                self.treasury.total_spent += r.amount;
                emit(
                    "reservation_settled",
                    json!({ "id": U64(id), "agent": r.agent, "counterparty": r.counterparty,
                            "amount": U128(r.amount) }),
                );
                true
            }
            Err(_) => {
                let res = self.reservations.get_mut(&id).expect("checked");
                res.status = ReservationStatus::Reserved;
                res.failed_attempts += 1;
                emit(
                    "execution_failed",
                    json!({ "id": U64(id), "agent": r.agent, "counterparty": r.counterparty,
                            "amount": U128(r.amount) }),
                );
                false
            }
        }
    }

    /// Releases a RESERVED reservation, restoring the agent's available budget.
    /// Caller: the reserving agent (even if revoked — releasing only reduces exposure), any
    /// Active ancestor, or the owner.
    pub fn release(&mut self, reservation_id: U64) -> ReservationView {
        let id = reservation_id.0;
        let caller = env::predecessor_account_id();
        let r = self.reservation(id);
        let path = self.path_of(&r.agent);
        let reason = if caller == r.agent {
            ReleaseReason::Agent
        } else if path[1..]
            .iter()
            .any(|a| *a == caller && self.agent(a).status == AgentStatus::Active)
        {
            ReleaseReason::Ancestor
        } else if caller == self.treasury.owner {
            ReleaseReason::Owner
        } else {
            fail(
                Error::Unauthorized,
                "only the agent, an active ancestor or the owner can release",
            )
        };
        require(
            r.status == ReservationStatus::Reserved,
            Error::InvalidTransition,
            format!("{:?} -> Released", r.status),
        );
        self.close_released(id, &path, reason);
        ReservationView::from_reservation(id, self.reservation(id))
    }

    /// Permissionless cleanup of expired RESERVED reservations. Ineligible ids are skipped.
    /// Returns the ids actually released.
    pub fn release_expired(&mut self, reservation_ids: Vec<U64>) -> Vec<U64> {
        require(
            reservation_ids.len() <= MAX_RELEASE_BATCH,
            Error::BatchTooLarge,
            format!("max {MAX_RELEASE_BATCH}"),
        );
        let now = env::block_timestamp();
        let mut released = Vec::new();
        for rid in reservation_ids {
            let eligible = self
                .reservations
                .get(&rid.0)
                .is_some_and(|r| r.status == ReservationStatus::Reserved && now >= r.expires_at);
            if eligible {
                let agent = self.reservation(rid.0).agent.clone();
                let path = self.path_of(&agent);
                self.close_released(rid.0, &path, ReleaseReason::Expired);
                released.push(rid);
            }
        }
        released
    }

    pub fn get_reservation(&self, reservation_id: U64) -> Option<ReservationView> {
        self.reservations
            .get(&reservation_id.0)
            .map(|r| ReservationView::from_reservation(reservation_id.0, r))
    }

    pub fn get_reservations(&self, from_id: Option<U64>, limit: Option<u64>) -> Vec<ReservationView> {
        let from = from_id.map(|x| x.0).unwrap_or(0);
        let to = from
            .saturating_add(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE))
            .min(self.next_reservation_id);
        (from..to)
            .filter_map(|id| {
                self.reservations
                    .get(&id)
                    .map(|r| ReservationView::from_reservation(id, r))
            })
            .collect()
    }

    pub fn get_reservation_by_request(
        &self,
        agent: AccountId,
        request_id: String,
    ) -> Option<ReservationView> {
        let id = *self.request_index.get(&pair_key(agent.as_str(), &request_id))?;
        self.get_reservation(U64(id))
    }

    /// Branch exposure of `agent` (itself + descendants) to `counterparty`.
    pub fn get_exposure(&self, agent: AccountId, counterparty: AccountId) -> U128 {
        U128(
            self.exposure
                .get(&pair_key(agent.as_str(), counterparty.as_str()))
                .copied()
                .unwrap_or(0),
        )
    }
}

impl Circuit {
    fn reservation(&self, id: u64) -> &Reservation {
        self.reservations
            .get(&id)
            .unwrap_or_else(|| fail(Error::ReservationNotFound, id.to_string()))
    }

    fn reservation_mut(&mut self, id: u64) -> &mut Reservation {
        self.reservations
            .get_mut(&id)
            .unwrap_or_else(|| fail(Error::ReservationNotFound, id.to_string()))
    }

    /// RESERVED → RELEASED: undo the reservation's budget and exposure effects.
    fn close_released(&mut self, id: u64, path: &[AccountId], reason: ReleaseReason) {
        let now = env::block_timestamp();
        let r = self.reservation_mut(id);
        r.status = ReservationStatus::Released;
        r.closed_at = Some(now);
        r.release_reason = Some(reason);
        let r = r.clone();

        for anc in path {
            let key = pair_key(anc.as_str(), r.counterparty.as_str());
            let cur = self.exposure.get(&key).copied().unwrap_or(0);
            self.exposure.insert(key, sub(cur, r.amount));
        }
        let a = self.agent_mut(&r.agent);
        a.reserved = sub(a.reserved, r.amount);
        a.pending_count -= 1;
        self.treasury.total_reserved = sub(self.treasury.total_reserved, r.amount);
        emit(
            "reservation_released",
            json!({ "id": U64(id), "agent": r.agent, "counterparty": r.counterparty,
                    "amount": U128(r.amount), "reason": reason }),
        );
    }
}
