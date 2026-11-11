// Publishes simulator reports as public annotations: one line per check, plus metrics.
import { readdirSync, readFileSync } from "node:fs";
const dir = process.argv[2] ?? "packages/agent-simulator/reports";
let files = [];
try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { console.log(`::warning::no reports in ${dir}`); }
for (const f of files) {
  const r = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
  const lines = r.checks.map((c) => `${c.pass ? "PASS" : "FAIL"} ${c.name} — ${c.detail}`);
  const msg = [`${r.passed ? "PASSED" : "FAILED"} ${r.checks.filter((c) => c.pass).length}/${r.checks.length} checks, ${r.transactions.length} transactions`, ...lines].join("%0A");
  console.log(`::${r.passed ? "notice" : "error"} title=simulator ${r.scenario}::${msg.replace(/\r?\n/g, " ")}`);
  if (Object.keys(r.metrics).length) console.log(`::notice title=simulator ${r.scenario} metrics::${JSON.stringify(r.metrics)}`);
}
