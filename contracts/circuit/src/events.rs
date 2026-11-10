//! NEP-297 event logs. One event per state change; the off-chain indexer and the dashboard
//! consume these from transaction outcomes.

use near_sdk::env;
use near_sdk::serde_json::{json, Value};

pub const STANDARD: &str = "circuit";
pub const VERSION: &str = "1.0.0";

pub fn emit(event: &str, data: Value) {
    let payload = json!({
        "standard": STANDARD,
        "version": VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}
