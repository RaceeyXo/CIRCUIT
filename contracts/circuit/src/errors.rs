//! Structured rejection codes.
//!
//! Every rejection panics with `CIRCUIT:<CODE>:<detail>`. A panic reverts the whole receipt
//! (including the attached deposit), so a rejected request leaves no state behind; the failed
//! transaction outcome carrying this string is the on-chain audit record of the rejection.

use near_sdk::env;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    NotOwner,
    Unauthorized,
    Paused,
    AgentNotFound,
    AgentExists,
    InvalidAgentId,
    AgentRevoked,
    AncestorRevoked,
    AlreadyRevoked,
    DepthExceeded,
    InvalidPolicy,
    PolicyExceedsParent,
    DelegationLimit,
    InsufficientBudget,
    ExceedsUnallocated,
    ZeroAmount,
    ExceedsTxLimit,
    PendingAmountLimit,
    PendingCountLimit,
    CounterpartyLimit,
    InvalidTtl,
    InvalidCounterparty,
    InvalidRequestId,
    RequestIdConflict,
    ReservationNotFound,
    InvalidTransition,
    ReservationExpired,
    InsufficientGas,
    BatchTooLarge,
    InsufficientStorageDeposit,
    CustodyViolation,
    ArithmeticOverflow,
}

impl Error {
    pub fn code(self) -> &'static str {
        match self {
            Error::NotOwner => "NOT_OWNER",
            Error::Unauthorized => "UNAUTHORIZED",
            Error::Paused => "PAUSED",
            Error::AgentNotFound => "AGENT_NOT_FOUND",
            Error::AgentExists => "AGENT_EXISTS",
            Error::InvalidAgentId => "INVALID_AGENT_ID",
            Error::AgentRevoked => "AGENT_REVOKED",
            Error::AncestorRevoked => "ANCESTOR_REVOKED",
            Error::AlreadyRevoked => "ALREADY_REVOKED",
            Error::DepthExceeded => "DEPTH_EXCEEDED",
            Error::InvalidPolicy => "INVALID_POLICY",
            Error::PolicyExceedsParent => "POLICY_EXCEEDS_PARENT",
            Error::DelegationLimit => "DELEGATION_LIMIT",
            Error::InsufficientBudget => "INSUFFICIENT_BUDGET",
            Error::ExceedsUnallocated => "EXCEEDS_UNALLOCATED",
            Error::ZeroAmount => "ZERO_AMOUNT",
            Error::ExceedsTxLimit => "EXCEEDS_TX_LIMIT",
            Error::PendingAmountLimit => "PENDING_AMOUNT_LIMIT",
            Error::PendingCountLimit => "PENDING_COUNT_LIMIT",
            Error::CounterpartyLimit => "COUNTERPARTY_LIMIT",
            Error::InvalidTtl => "INVALID_TTL",
            Error::InvalidCounterparty => "INVALID_COUNTERPARTY",
            Error::InvalidRequestId => "INVALID_REQUEST_ID",
            Error::RequestIdConflict => "REQUEST_ID_CONFLICT",
            Error::ReservationNotFound => "RESERVATION_NOT_FOUND",
            Error::InvalidTransition => "INVALID_TRANSITION",
            Error::ReservationExpired => "RESERVATION_EXPIRED",
            Error::InsufficientGas => "INSUFFICIENT_GAS",
            Error::BatchTooLarge => "BATCH_TOO_LARGE",
            Error::InsufficientStorageDeposit => "INSUFFICIENT_STORAGE_DEPOSIT",
            Error::CustodyViolation => "CUSTODY_VIOLATION",
            Error::ArithmeticOverflow => "ARITHMETIC_OVERFLOW",
        }
    }
}

pub fn fail(err: Error, detail: impl AsRef<str>) -> ! {
    env::panic_str(&format!("CIRCUIT:{}:{}", err.code(), detail.as_ref()))
}

pub fn require(cond: bool, err: Error, detail: impl AsRef<str>) {
    if !cond {
        fail(err, detail)
    }
}

/// Checked money arithmetic. Overflow/underflow is a hard failure, never a wrap.
pub fn add(a: u128, b: u128) -> u128 {
    a.checked_add(b)
        .unwrap_or_else(|| fail(Error::ArithmeticOverflow, "add"))
}

pub fn sub(a: u128, b: u128) -> u128 {
    a.checked_sub(b)
        .unwrap_or_else(|| fail(Error::ArithmeticOverflow, "sub"))
}
