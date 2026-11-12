#!/usr/bin/env node
// circuit-sim <baseline|spec|concurrency|attacks|all> [--network sandbox|external] [--wasm path] [--out dir] [--seed n] [--scale f]
//
// Exit code 0 only if every check of every scenario passed. Reports are written as JSON.

import { parseArgs } from "node:util";

import type { Evidence } from "./evidence.js";
import { connect } from "./network.js";
import { attackScenario, baselineScenario, concurrencyScenario, setScale, specScenario } from "./scenarios.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    network: { type: "string", default: "sandbox" },
    wasm: { type: "string", default: process.env.CIRCUIT_WASM ?? "../../target/near/circuit/circuit.wasm" },
    out: { type: "string", default: "reports" },
    seed: { type: "string", default: "24301" },
    scale: { type: "string", default: "1" },
  },
});

const which = positionals[0] ?? "all";
const network = values.network === "external" ? "external" : "sandbox";
const runs: Record<string, (net: Awaited<ReturnType<typeof connect>>) => Promise<Evidence>> = {
  baseline: (net) => baselineScenario(net),
  spec: (net) => specScenario(net, values.wasm!),
  concurrency: (net) => concurrencyScenario(net, values.wasm!, Number(values.seed)),
  attacks: (net) => attackScenario(net, values.wasm!),
};
const selected = which === "all" ? Object.keys(runs) : [which];
if (!selected.every((s) => s in runs)) {
  console.error(`unknown scenario ${which}; expected one of ${Object.keys(runs).join(", ")}, all`);
  process.exit(2);
}

setScale(Number(values.scale));
const net = await connect(network);
let ok = true;
try {
  for (const name of selected) {
    console.log(`\n=== ${name} (${network}, ${net.rpcUrl}) ===`);
    try {
      const ev = await runs[name]!(net);
      const file = await ev.save(values.out!);
      console.log(`${ev.passed ? "PASSED" : "FAILED"}: ${ev.checks.filter((c) => c.pass).length}/${ev.checks.length} checks, report ${file}`);
      ok &&= ev.passed;
    } catch (err) {
      console.error(`scenario ${name} aborted:`, err);
      ok = false;
    }
  }
} finally {
  await net.stop();
}
process.exit(ok ? 0 : 1);
