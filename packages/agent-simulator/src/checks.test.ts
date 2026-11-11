import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { AgentView, TreasuryView } from "@circuit/shared";

import { checkAccounting } from "./invariants.js";
import { policy } from "./scenarios.js";

const agent = (id: string, parent: string | null, allocation: number, spent = 0, reserved = 0, delegated = 0): AgentView => ({
  id, parent, depth: parent ? 2 : 1,
  allocation: String(allocation), spent: String(spent), reserved: String(reserved), delegated: String(delegated),
  available: String(allocation - spent - reserved - delegated),
  pending_count: 0, status: "Active", policy: policy(), created_at: "0", revoked_at: null,
});
const treasury = (o: Partial<TreasuryView>): TreasuryView => ({
  owner: "o", total_budget: "1000", allocated: "0", unallocated: "1000", total_spent: "0", total_reserved: "0",
  in_flight: "0", remaining: "1000", paused: false, agent_count: 0, reservation_count: 0, ...o,
});

test("consistent state passes", () => {
  const agents = [agent("r", null, 1000, 100, 200, 300), agent("c", "r", 300, 0, 50)];
  assert.deepEqual(checkAccounting(treasury({ allocated: "1000", total_spent: "100", total_reserved: "250" }), agents), []);
});

test("each invariant violation is detected", () => {
  const over = [agent("r", null, 100, 60, 60)];
  assert.match(checkAccounting(treasury({ allocated: "100", total_spent: "60", total_reserved: "60" }), over).join(), /I1/);
  const orphan = [agent("r", null, 100, 0, 0, 50)];
  assert.match(checkAccounting(treasury({ allocated: "100" }), orphan).join(), /I2/);
  assert.match(checkAccounting(treasury({ allocated: "999" }), [agent("r", null, 100)]).join(), /I3/);
  assert.match(checkAccounting(treasury({ allocated: "100", total_spent: "1" }), [agent("r", null, 100)]).join(), /I4/);
});
