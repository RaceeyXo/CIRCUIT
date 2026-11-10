#![allow(dead_code)]

use anyhow::{Context, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};

pub const MILLI: u128 = 1_000_000_000_000_000_000_000; // 0.001 NEAR
pub const NEAR: u128 = 1_000 * MILLI;
pub const HOUR_NS: u64 = 3_600 * 1_000_000_000;
/// Storage deposit attached to state-growing calls; the excess is refunded by the contract.
pub const DEPOSIT: NearToken = NearToken::from_millinear(100);
pub const EXECUTE_GAS: Gas = Gas::from_tgas(100);

pub fn wasm() -> Result<Vec<u8>> {
    let path = std::env::var("CIRCUIT_WASM")
        .context("set CIRCUIT_WASM to the cargo-near build output (target/near/circuit/circuit.wasm)")?;
    std::fs::read(&path).with_context(|| format!("reading {path}"))
}

pub struct Env {
    pub worker: Worker<Sandbox>,
    pub contract: Contract,
    pub owner: Account,
}

pub async fn new_worker() -> Result<Worker<Sandbox>> {
    Ok(near_workspaces::sandbox().await?)
}

/// Deploys a fresh contract owned by a new `owner` account and funds the treasury.
pub async fn deploy(worker: &Worker<Sandbox>, budget: u128) -> Result<Env> {
    let contract = worker.dev_deploy(&wasm()?).await?;
    let owner = account(worker, "owner", 50 * NEAR + budget).await?;
    contract
        .call("new")
        .args_json(json!({ "owner": owner.id() }))
        .transact()
        .await?
        .into_result()?;
    if budget > 0 {
        owner
            .call(contract.id(), "fund_treasury")
            .deposit(NearToken::from_yoctonear(budget))
            .transact()
            .await?
            .into_result()?;
    }
    Ok(Env { worker: worker.clone(), contract, owner })
}

/// Creates a uniquely named subaccount of the sandbox root.
pub async fn account(worker: &Worker<Sandbox>, prefix: &str, balance: u128) -> Result<Account> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let name = format!("{prefix}{}", N.fetch_add(1, Ordering::Relaxed));
    Ok(worker
        .root_account()?
        .create_subaccount(&name)
        .initial_balance(NearToken::from_yoctonear(balance))
        .transact()
        .await?
        .into_result()?)
}

pub fn policy(max_tx: u128, max_cp: u128, max_delegated: u128) -> Value {
    json!({
        "max_tx_amount": max_tx.to_string(),
        "max_pending_amount": (1_000 * NEAR).to_string(),
        "max_pending_count": 100,
        "max_counterparty_exposure": max_cp.to_string(),
        "max_delegated": max_delegated.to_string(),
        "max_reservation_ttl_ns": (24 * HOUR_NS).to_string(),
    })
}

pub fn open_policy() -> Value {
    policy(1_000 * NEAR, 1_000 * NEAR, 1_000 * NEAR)
}

impl Env {
    pub async fn register(
        &self,
        by: &Account,
        agent: &AccountId,
        parent: Option<&AccountId>,
        policy: Value,
        allocation: u128,
    ) -> Result<ExecutionFinalResult> {
        Ok(by
            .call(self.contract.id(), "register_agent")
            .args_json(json!({
                "agent_id": agent, "parent": parent, "policy": policy,
                "allocation": allocation.to_string(),
            }))
            .deposit(DEPOSIT)
            .transact()
            .await?)
    }

    pub async fn reserve(
        &self,
        agent: &Account,
        request_id: &str,
        counterparty: &AccountId,
        amount: u128,
        ttl_ns: u64,
    ) -> Result<ExecutionFinalResult> {
        Ok(agent
            .call(self.contract.id(), "reserve")
            .args_json(json!({
                "request_id": request_id, "counterparty": counterparty,
                "amount": amount.to_string(), "ttl_ns": ttl_ns.to_string(),
            }))
            .deposit(DEPOSIT)
            .transact()
            .await?)
    }

    pub async fn execute(&self, agent: &Account, id: u64) -> Result<ExecutionFinalResult> {
        Ok(agent
            .call(self.contract.id(), "execute")
            .args_json(json!({ "reservation_id": id.to_string() }))
            .gas(EXECUTE_GAS)
            .transact()
            .await?)
    }

    pub async fn view(&self, method: &str, args: Value) -> Result<Value> {
        Ok(self.contract.view(method).args_json(args).await?.json()?)
    }

    pub async fn treasury(&self) -> Result<Value> {
        self.view("get_treasury", json!({})).await
    }

    pub async fn agent(&self, id: &AccountId) -> Result<Value> {
        self.view("get_agent", json!({ "agent": id })).await
    }

    pub async fn reservation(&self, id: u64) -> Result<Value> {
        self.view("get_reservation", json!({ "reservation_id": id.to_string() })).await
    }

    pub async fn balance(&self, id: &AccountId) -> Result<u128> {
        Ok(self.worker.view_account(id).await?.balance.as_yoctonear())
    }

    /// I1–I5 from the public views.
    pub async fn check_invariants(&self) -> Result<()> {
        let t = self.treasury().await?;
        let agents = self.view("get_agents", json!({})).await?;
        let agents = agents.as_array().unwrap();
        let (mut spent, mut reserved, mut top) = (0u128, 0u128, 0u128);
        for a in agents {
            let (al, sp, re, de) = (u(&a["allocation"]), u(&a["spent"]), u(&a["reserved"]), u(&a["delegated"]));
            assert!(sp + re + de <= al, "I1 violated: {a}");
            let children: u128 = agents
                .iter()
                .filter(|c| c["parent"] == a["id"])
                .map(|c| u(&c["allocation"]))
                .sum();
            assert_eq!(de, children, "I2 violated: {a}");
            if a["parent"].is_null() {
                top += al;
            }
            spent += sp;
            reserved += re;
        }
        assert_eq!(u(&t["allocated"]), top, "I3");
        assert_eq!(u(&t["total_spent"]), spent, "I4");
        assert_eq!(u(&t["total_reserved"]), reserved, "I4");
        assert!(spent + reserved <= u(&t["total_budget"]), "I5");
        Ok(())
    }

    /// I8 against the real account: free balance covers unspent treasury obligations.
    pub async fn check_custody(&self) -> Result<()> {
        let t = self.treasury().await?;
        let acct = self.worker.view_account(self.contract.id()).await?;
        let storage = acct.storage_usage as u128 * 10_000_000_000_000_000_000; // 1e19 yocto/byte
        let free = acct.balance.as_yoctonear() - storage;
        let liabilities = u(&t["total_budget"]) - u(&t["total_spent"]) - u(&t["in_flight"]);
        assert!(free >= liabilities, "custody: free {free} < liabilities {liabilities}");
        Ok(())
    }
}

pub fn u(v: &Value) -> u128 {
    v.as_str().unwrap_or_else(|| panic!("expected a string number, got {v}")).parse().unwrap()
}

/// The structured rejection code of a failed transaction, e.g. `INSUFFICIENT_BUDGET`.
pub fn rejection_code(r: &ExecutionFinalResult) -> Option<String> {
    if r.is_success() {
        return None;
    }
    let text = format!("{:?}", r.clone().into_result().err());
    let start = text.find("CIRCUIT:")? + "CIRCUIT:".len();
    Some(text[start..].split(':').next()?.to_string())
}

pub fn reservation_id(r: &ExecutionFinalResult) -> u64 {
    let v: Value = r.clone().json().expect("reserve result");
    v["reservation"]["id"].as_str().unwrap().parse().unwrap()
}
