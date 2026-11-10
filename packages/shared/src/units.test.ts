import { strict as assert } from "node:assert";
import { test } from "node:test";

import { interpretOutcome, parseRejection } from "./outcome.js";
import { YOCTO_PER_NEAR, formatNear, parseNear } from "./units.js";

test("parseNear is exact and float-free", () => {
  assert.equal(parseNear("1"), YOCTO_PER_NEAR);
  assert.equal(parseNear("0.000000000000000000000001"), 1n);
  assert.equal(parseNear("0.1") + parseNear("0.2"), parseNear("0.3"));
  assert.equal(parseNear("123456789.5"), 123456789n * YOCTO_PER_NEAR + YOCTO_PER_NEAR / 2n);
  for (const bad of ["", "-1", "1e3", "1.0000000000000000000000001", "abc"]) {
    assert.throws(() => parseNear(bad));
  }
});

test("formatNear truncates without rounding", () => {
  assert.equal(formatNear(parseNear("1.99999")), "1.9999");
  assert.equal(formatNear(0n), "0.0000");
  assert.equal(formatNear(-YOCTO_PER_NEAR, 2), "-1.00");
});

test("rejection codes are extracted from failure payloads", () => {
  const r = parseRejection('{"ActionError":{"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: CIRCUIT:INSUFFICIENT_BUDGET:available 5, requested 6"}}}}');
  assert.deepEqual(r, { code: "INSUFFICIENT_BUDGET", detail: "available 5, requested 6" });
});

test("interpretOutcome decodes success values, gas and events", () => {
  const value = Buffer.from(JSON.stringify({ duplicate: false })).toString("base64");
  const out = interpretOutcome<{ duplicate: boolean }>({
    status: { SuccessValue: value },
    transaction: { hash: "TX" },
    transaction_outcome: { id: "TX", block_hash: "B1", outcome: { gas_burnt: 1_000, logs: [] } },
    receipts_outcome: [
      { outcome: { gas_burnt: 2_000, logs: ['EVENT_JSON:{"standard":"circuit","version":"1.0.0","event":"reservation_created","data":[{}]}', "other"] } },
    ],
  });
  assert.equal(out.ok, true);
  assert.equal(out.value?.duplicate, false);
  assert.equal(out.gasBurnt, 3_000n);
  assert.equal(out.events.length, 1);
  assert.equal(out.blockHash, "B1");
});

test("interpretOutcome reports structured rejections", () => {
  const out = interpretOutcome({
    status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: CIRCUIT:AGENT_REVOKED:a.test" } } } } },
    transaction_outcome: { outcome: { gas_burnt: 5 } },
  });
  assert.equal(out.ok, false);
  assert.equal(out.rejection?.code, "AGENT_REVOKED");
});
