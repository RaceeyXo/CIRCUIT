//! Critical concurrency experiment (spec §8).
//!
//! Ten agents under one root submit 24 reservation requests *concurrently* (all transactions
//! are in flight at once; nothing waits for a previous result). The combined request value
//! (≈ 14 NEAR) exceeds the 10 NEAR treasury, every child's own 1 NEAR carve-out, and the
//! root's branch-level 6 NEAR cap on the shared vendor. The experiment repeats with a
//! different, seeded submission order per round and records real outcomes, gas and the
//! blocks the transactions landed in. Results go to `target/bench/concurrency-sandbox.json`.

mod common;

use std::collections::{BTreeMap, BTreeSet};

use anyhow::Result;
use common::*;
use futures::future::join_all;
use near_workspaces::types::{AccessKey, KeyType, SecretKey};
use near_workspaces::Account;
use serde_json::{json, Value};

const AGENTS: usize = 10;
const REQUESTS: usize = 24;
const SIGNERS_PER_AGENT: usize = REQUESTS.div_ceil(AGENTS);
const ROUNDS: u64 = 3;
const BUDGET: u128 = 10 * NEAR;
const CHILD_ALLOCATION: u128 = NEAR;
const VENDOR_CAP: u128 = 6 * NEAR;

/// Deterministic xorshift so every round's amounts and ordering are reproducible from its seed.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn shuffle<T>(&mut self, v: &mut [T]) {
        for i in (1..v.len()).rev() {
            v.swap(i, (self.next() % (i as u64 + 1)) as usize);
        }
    }
}

#[tokio::test]
async fn competing_concurrent_requests_never_exceed_authority() -> Result<()> {
    let worker = new_worker().await?;
    let mut rounds = Vec::new();

    for round in 0..ROUNDS {
        let seed = 0x5eed_0000 + round;
        let mut rng = Rng(seed);
        let env = deploy(&worker, BUDGET).await?;
        let root = account(&worker, "root", 20 * NEAR).await?;
        let vendor = account(&worker, "vendor", NEAR).await?;
        env.register(&env.owner, root.id(), None, policy(BUDGET, VENDOR_CAP, BUDGET), BUDGET)
            .await?
            .into_result()?;
        // Each agent gets one signer (access key) per concurrent request so in-flight
        // transactions never share a nonce, as independent worker processes would.
        let mut agents: Vec<Vec<Account>> = Vec::new();
        for _ in 0..AGENTS {
            let a = account(&worker, "worker", 5 * NEAR).await?;
            env.register(&root, a.id(), Some(root.id()), policy(NEAR, VENDOR_CAP, 0), CHILD_ALLOCATION)
                .await?
                .into_result()?;
            let mut signers = vec![a.clone()];
            for _ in 1..SIGNERS_PER_AGENT {
                let sk = SecretKey::from_random(KeyType::ED25519);
                a.batch(a.id())
                    .add_key(sk.public_key(), AccessKey::full_access())
                    .transact()
                    .await?
                    .into_result()?;
                signers.push(Account::from_secret_key(a.id().clone(), sk, &worker));
            }
            agents.push(signers);
        }

        // 24 requests of 0.30–0.85 NEAR, all to the same vendor.
        let mut requests: Vec<(usize, String, u128)> = (0..REQUESTS)
            .map(|k| (k % AGENTS, format!("r{round}-{k}"), (300 + (rng.next() % 551) as u128) * MILLI))
            .collect();
        rng.shuffle(&mut requests);
        let requested: u128 = requests.iter().map(|r| r.2).sum();

        // Fire everything at once.
        let futures = requests.iter().map(|(a, req, amt)| {
            let env = &env;
            let slot: usize = req.rsplit('-').next().unwrap().parse::<usize>().unwrap() / AGENTS;
            let agent = &agents[*a][slot];
            let vendor = vendor.id();
            async move { (env.reserve(agent, req, vendor, *amt, HOUR_NS).await, *a, *amt) }
        });
        let outcomes = join_all(futures).await;

        let mut accepted = 0u128;
        let mut per_agent = vec![0u128; AGENTS];
        let mut codes: BTreeMap<String, u32> = BTreeMap::new();
        let mut gas_ok = Vec::new();
        let mut gas_rejected = Vec::new();
        let mut blocks = BTreeSet::new();
        for (res, a, amt) in outcomes {
            let res = res?;
            blocks.insert(res.outcome().block_hash.to_string());
            if res.is_success() {
                accepted += amt;
                per_agent[a] += amt;
                gas_ok.push(res.total_gas_burnt.as_gas());
            } else {
                *codes.entry(rejection_code(&res).unwrap_or_else(|| format!("{res:?}"))).or_default() += 1;
                gas_rejected.push(res.total_gas_burnt.as_gas());
            }
        }

        // The guarantees.
        let t = env.treasury().await?;
        let exposure = u(&env
            .view("get_exposure", json!({ "agent": root.id(), "counterparty": vendor.id() }))
            .await?);
        assert!(requested > BUDGET, "experiment must over-subscribe the treasury");
        assert!(accepted <= BUDGET, "accepted {accepted} > budget");
        assert!(accepted <= VENDOR_CAP, "accepted {accepted} > branch vendor cap");
        assert_eq!(exposure, accepted);
        assert_eq!(u(&t["total_reserved"]), accepted, "contract state matches observed outcomes");
        for (i, amt) in per_agent.iter().enumerate() {
            assert!(*amt <= CHILD_ALLOCATION, "agent {i} accepted {amt} > its allocation");
        }
        env.check_invariants().await?;
        env.check_custody().await?;

        let stats = |g: &Vec<u64>| -> Value {
            if g.is_empty() {
                return Value::Null;
            }
            let tgas = |x: u64| x as f64 / 1e12;
            json!({
                "count": g.len(),
                "min_tgas": tgas(*g.iter().min().unwrap()),
                "max_tgas": tgas(*g.iter().max().unwrap()),
                "mean_tgas": tgas(g.iter().sum::<u64>() / g.len() as u64),
            })
        };
        rounds.push(json!({
            "round": round,
            "seed": format!("{seed:#x}"),
            "requests": REQUESTS,
            "agents": AGENTS,
            "total_requested_near": near_str(requested),
            "total_accepted_near": near_str(accepted),
            "total_rejected_near": near_str(requested - accepted),
            "accepted_count": gas_ok.len(),
            "rejected_count": gas_rejected.len(),
            "rejections_by_code": codes,
            "treasury_remaining_near": near_str(u(&t["remaining"])),
            "max_exposure_to_vendor_near": near_str(exposure),
            "distinct_blocks": blocks.len(),
            "gas_accepted": stats(&gas_ok),
            "gas_rejected": stats(&gas_rejected),
        }));
    }

    let report = json!({
        "experiment": "concurrent competing reservations",
        "environment": "near-workspaces sandbox (local single-node NEAR), GitHub Actions ubuntu-latest",
        "budget_near": near_str(BUDGET),
        "child_allocation_near": near_str(CHILD_ALLOCATION),
        "branch_vendor_cap_near": near_str(VENDOR_CAP),
        "rounds": rounds,
    });
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/bench");
    std::fs::create_dir_all(dir)?;
    std::fs::write(format!("{dir}/concurrency-sandbox.json"), serde_json::to_string_pretty(&report)?)?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
