//! Real-transaction tests: actual receipts, transfers, refunds, gas and the generated
//! `#[private]` guard — the things the mocked unit-test environment cannot show.

mod common;

use anyhow::Result;
use common::*;
use serde_json::json;

#[tokio::test]
async fn payout_moves_real_funds_and_settles() -> Result<()> {
    let worker = new_worker().await?;
    let env = deploy(&worker, 10 * NEAR).await?;
    let agent = account(&worker, "agent", 5 * NEAR).await?;
    let vendor = account(&worker, "vendor", NEAR).await?;
    env.register(&env.owner, agent.id(), None, open_policy(), 5 * NEAR).await?.into_result()?;

    let r = env.reserve(&agent, "invoice-1", vendor.id(), 2 * NEAR, HOUR_NS).await?;
    assert!(r.is_success(), "{r:?}");
    let id = reservation_id(&r);
    println!("reserve gas burnt: {} Tgas", r.total_gas_burnt.as_tgas());

    let before = env.balance(vendor.id()).await?;
    let ex = env.execute(&agent, id).await?;
    assert!(ex.is_success(), "{ex:?}");
    assert!(ex.clone().json::<bool>()?, "execute should resolve to settled = true");
    println!("execute gas burnt: {} Tgas", ex.total_gas_burnt.as_tgas());
    let after = env.balance(vendor.id()).await?;
    assert_eq!(after - before, 2 * NEAR, "vendor receives exactly the reserved amount");

    let res = env.reservation(id).await?;
    assert_eq!(res["status"], "Settled");
    let t = env.treasury().await?;
    assert_eq!(u(&t["total_spent"]), 2 * NEAR);
    assert_eq!(u(&t["total_reserved"]), 0);
    assert_eq!(u(&t["in_flight"]), 0);
    let a = env.agent(agent.id()).await?;
    assert_eq!(u(&a["available"]), 3 * NEAR);
    env.check_invariants().await?;
    env.check_custody().await?;
    Ok(())
}

#[tokio::test]
async fn callback_cannot_be_called_by_anyone_else() -> Result<()> {
    let worker = new_worker().await?;
    let env = deploy(&worker, 10 * NEAR).await?;
    let agent = account(&worker, "agent", 5 * NEAR).await?;
    let vendor = account(&worker, "vendor", NEAR).await?;
    env.register(&env.owner, agent.id(), None, open_policy(), 5 * NEAR).await?.into_result()?;
    let id = reservation_id(&env.reserve(&agent, "r", vendor.id(), NEAR, HOUR_NS).await?);

    // Forge a "payment succeeded" callback from the agent, the owner and an outsider.
    for forger in [&agent, &env.owner, &vendor] {
        let r = forger
            .call(env.contract.id(), "on_execute")
            .args_json(json!({ "reservation_id": id.to_string() }))
            .transact()
            .await?;
        assert!(r.is_failure(), "forged callback must fail");
        assert!(format!("{r:?}").contains("is private"), "{r:?}");
    }
    assert_eq!(env.reservation(id).await?["status"], "Reserved");
    assert_eq!(u(&env.treasury().await?["total_spent"]), 0);
    Ok(())
}

#[tokio::test]
async fn failed_transfer_restores_reservation_and_funds() -> Result<()> {
    let worker = new_worker().await?;
    let env = deploy(&worker, 10 * NEAR).await?;
    let agent = account(&worker, "agent", 5 * NEAR).await?;
    env.register(&env.owner, agent.id(), None, open_policy(), 5 * NEAR).await?.into_result()?;
    // A named account that does not exist: the transfer fails and the runtime refunds it.
    let ghost: near_workspaces::AccountId = format!("ghost.{}", worker.root_account()?.id()).parse()?;
    let id = reservation_id(&env.reserve(&agent, "r", &ghost, 2 * NEAR, HOUR_NS).await?);

    let before = env.balance(env.contract.id()).await?;
    let ex = env.execute(&agent, id).await?;
    assert!(ex.is_success(), "the execute tx itself succeeds; the inner transfer fails: {ex:?}");
    assert!(!ex.json::<bool>()?, "execute should resolve to settled = false");
    let after = env.balance(env.contract.id()).await?;
    // The 2 NEAR came back; the contract may even gain gas rewards.
    assert!(after + MILLI >= before, "contract lost funds: before {before}, after {after}");

    let res = env.reservation(id).await?;
    assert_eq!(res["status"], "Reserved");
    assert_eq!(res["failed_attempts"], 1);
    let t = env.treasury().await?;
    assert_eq!(u(&t["in_flight"]), 0);
    assert_eq!(u(&t["total_reserved"]), 2 * NEAR);
    assert_eq!(u(&t["total_spent"]), 0);
    env.check_invariants().await?;
    env.check_custody().await?;

    // The agent can then release the reservation.
    agent
        .call(env.contract.id(), "release")
        .args_json(json!({ "reservation_id": id.to_string() }))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(u(&env.agent(agent.id()).await?["available"]), 5 * NEAR);
    Ok(())
}

#[tokio::test]
async fn rejected_requests_leave_no_state_and_refund_the_deposit() -> Result<()> {
    let worker = new_worker().await?;
    let env = deploy(&worker, 10 * NEAR).await?;
    let agent = account(&worker, "agent", 5 * NEAR).await?;
    let vendor = account(&worker, "vendor", NEAR).await?;
    env.register(&env.owner, agent.id(), None, open_policy(), NEAR).await?.into_result()?;

    let before = env.balance(agent.id()).await?;
    let r = env.reserve(&agent, "too-big", vendor.id(), 2 * NEAR, HOUR_NS).await?;
    assert_eq!(rejection_code(&r).as_deref(), Some("INSUFFICIENT_BUDGET"));
    let after = env.balance(agent.id()).await?;
    // Only gas is lost; the 0.1 NEAR deposit is returned with the failed receipt.
    assert!(before - after < 10 * MILLI, "lost {} yocto", before - after);
    let t = env.treasury().await?;
    assert_eq!(t["reservation_count"], 0);
    assert_eq!(u(&t["total_reserved"]), 0);

    // A successful reserve keeps only the storage cost.
    let before = env.balance(agent.id()).await?;
    env.reserve(&agent, "ok", vendor.id(), NEAR / 2, HOUR_NS).await?.into_result()?;
    let after = env.balance(agent.id()).await?;
    let cost = before - after;
    println!("reserve total cost to agent (gas + storage): {cost} yocto");
    assert!(cost < 20 * MILLI, "excess deposit not refunded: cost {cost}");

    // No deposit at all is rejected.
    let r = agent
        .call(env.contract.id(), "reserve")
        .args_json(json!({ "request_id": "nodep", "counterparty": vendor.id(),
                           "amount": "1", "ttl_ns": HOUR_NS.to_string() }))
        .transact()
        .await?;
    assert_eq!(rejection_code(&r).as_deref(), Some("INSUFFICIENT_STORAGE_DEPOSIT"));
    Ok(())
}

#[tokio::test]
async fn duplicates_and_revocation_on_chain() -> Result<()> {
    let worker = new_worker().await?;
    let env = deploy(&worker, 10 * NEAR).await?;
    let root = account(&worker, "root", 5 * NEAR).await?;
    let child = account(&worker, "child", 5 * NEAR).await?;
    let grandchild = account(&worker, "grand", 5 * NEAR).await?;
    let vendor = account(&worker, "vendor", NEAR).await?;
    env.register(&env.owner, root.id(), None, open_policy(), 6 * NEAR).await?.into_result()?;
    env.register(&root, child.id(), Some(root.id()), open_policy(), 3 * NEAR).await?.into_result()?;
    env.register(&child, grandchild.id(), Some(child.id()), open_policy(), NEAR).await?.into_result()?;

    // Duplicate submissions: one commitment.
    let first = env.reserve(&grandchild, "dup", vendor.id(), NEAR / 2, HOUR_NS).await?;
    let id = reservation_id(&first);
    for _ in 0..3 {
        let again = env.reserve(&grandchild, "dup", vendor.id(), NEAR / 2, HOUR_NS).await?;
        let v: serde_json::Value = again.clone().json()?;
        assert_eq!(v["duplicate"], true);
        assert_eq!(reservation_id(&again), id);
    }
    let conflict = env.reserve(&grandchild, "dup", vendor.id(), NEAR / 4, HOUR_NS).await?;
    assert_eq!(rejection_code(&conflict).as_deref(), Some("REQUEST_ID_CONFLICT"));
    assert_eq!(u(&env.agent(grandchild.id()).await?["reserved"]), NEAR / 2);

    // Revoking the middle agent freezes the branch below it.
    root.call(env.contract.id(), "revoke_agent")
        .args_json(json!({ "agent": child.id() }))
        .transact()
        .await?
        .into_result()?;
    let r = env.reserve(&grandchild, "after", vendor.id(), 1, HOUR_NS).await?;
    assert_eq!(rejection_code(&r).as_deref(), Some("ANCESTOR_REVOKED"));
    let r = env.execute(&grandchild, id).await?;
    assert_eq!(rejection_code(&r).as_deref(), Some("ANCESTOR_REVOKED"));
    let r = env.reserve(&child, "after", vendor.id(), 1, HOUR_NS).await?;
    assert_eq!(rejection_code(&r).as_deref(), Some("AGENT_REVOKED"));
    env.check_invariants().await?;
    Ok(())
}

#[tokio::test]
async fn expired_reservations_can_be_released_by_anyone() -> Result<()> {
    let worker = new_worker().await?;
    let env = deploy(&worker, 10 * NEAR).await?;
    let agent = account(&worker, "agent", 5 * NEAR).await?;
    let vendor = account(&worker, "vendor", NEAR).await?;
    let stranger = account(&worker, "stranger", NEAR).await?;
    env.register(&env.owner, agent.id(), None, open_policy(), NEAR).await?.into_result()?;

    let id = reservation_id(&env.reserve(&agent, "hoard", vendor.id(), NEAR, 2_000_000_000).await?);
    let r = env.reserve(&agent, "next", vendor.id(), 1, HOUR_NS).await?;
    assert_eq!(rejection_code(&r).as_deref(), Some("INSUFFICIENT_BUDGET"));

    worker.fast_forward(500).await?;
    let r = env.execute(&agent, id).await?;
    assert_eq!(rejection_code(&r).as_deref(), Some("RESERVATION_EXPIRED"));
    let released: Vec<String> = stranger
        .call(env.contract.id(), "release_expired")
        .args_json(json!({ "reservation_ids": [id.to_string()] }))
        .transact()
        .await?
        .json()?;
    assert_eq!(released, vec![id.to_string()]);
    assert_eq!(env.reservation(id).await?["release_reason"], "Expired");
    env.reserve(&agent, "next", vendor.id(), NEAR, HOUR_NS).await?.into_result()?;
    env.check_invariants().await?;
    Ok(())
}
