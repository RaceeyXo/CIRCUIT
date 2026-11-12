// All landing-page copy and numbers live here. Every number comes from a recorded run; the
// source is noted next to it. Update this file (not the components) when new evidence lands.

export const REPO = "https://github.com/RaceeyXo/CIRCUIT";

export const hero = {
  lines: ["One treasury.", "Many agents.", "One enforceable limit."],
  accentLine: 1,
  lede: [
    "On-chain spending control for autonomous agent networks on NEAR.",
    "Agents reserve. The contract decides. Every limit holds, even under concurrency.",
  ],
  // Spec example, sandbox run (docs/benchmarks.md): 1.0 NEAR budget, concurrent 0.6 / 0.5 / 0.3.
  card: {
    remaining: "0.200",
    spentPct: 80,
    spent: "0.800",
    budget: "1.000",
    rows: [
      { who: "worker-1", status: "SETTLED", amount: "0.500", ok: true },
      { who: "worker-2", status: "SETTLED", amount: "0.300", ok: true },
      { who: "worker-0", status: "INSUFFICIENT_BUDGET", amount: "0.600", ok: false },
    ],
  },
  // Illustrative event chips (the kinds of events the contract emits).
  chips: [
    { ok: true, title: "Reserved", sub: "agent-07 · 0.3 s ago", amount: "+0.300", pos: "lg:top-10 lg:left-[2%]", delay: "0s" },
    { ok: false, title: "Rejected", sub: "COUNTERPARTY_LIMIT", amount: "0.850", pos: "lg:top-[118px] lg:left-0", delay: "-2s" },
    { ok: true, title: "Settled to vendor", sub: "callback confirmed", amount: "0.572", pos: "lg:top-[250px] lg:right-[1%]", delay: "-1s" },
    { ok: false, title: "Blocked", sub: "ANCESTOR_REVOKED", amount: "—", pos: "lg:top-[328px] lg:right-[4%]", delay: "-3s" },
  ],
};

export const proof = [
  "38 unit tests",
  "256 random-sequence property cases",
  "9 invariants after every step",
  "7 sandbox tests on real receipts",
  "36/36 simulator checks",
  "NEAR testnet evidence",
  "planted bug: caught",
];

// Baseline vs CIRCUIT, CI run 43198136717 (sandbox, scale 1).
export const versus = {
  caption: "Same three requests (0.6 · 0.5 · 0.3) against a 1.0 NEAR budget",
  budgetPct: 71.4, // 1.0 of 1.4
  rows: [
    { name: "Shared hot wallet", paid: "1.400", fillPct: 100, over: true, note: "All three approved against a stale balance.", emphasis: "+40% over budget." },
    { name: "CIRCUIT", paid: "0.800", fillPct: 57.1, over: false, note: "0.5 and 0.3 settled. 0.6 rejected with INSUFFICIENT_BUDGET.", emphasis: "" },
  ],
  source: "Recorded simulator runs on a NEAR node · CI run 43198136717",
};

export const route = {
  requests: [
    { who: "agent-02", what: "0.420 → vendor" },
    { who: "agent-05", what: "0.610 → vendor" },
    { who: "agent-05", what: "0.610 → vendor", tag: "retry" },
    { who: "agent-09", what: "0.330 → sink" },
    { who: "revoked-b", what: "0.100 → vendor" },
  ],
  decisions: [
    { code: "RESERVED", ok: true, note: "#41" },
    { code: "INSUFFICIENT_BUDGET", ok: false },
    { code: "DUPLICATE → #40", ok: null },
    { code: "COUNTERPARTY_LIMIT", ok: false },
    { code: "AGENT_REVOKED", ok: false },
  ],
};

export const caps = [
  { label: "Per transaction", value: "≤ 1.0" },
  { label: "Pending total", value: "≤ 10.0" },
  { label: "Per counterparty, whole branch", value: "≤ 6.0" },
  { label: "Reservation lifetime", value: "≤ 24 h" },
];

// Outcomes asserted by the attack scenario (sandbox CI; testnet run pending).
export const attacks = [
  { title: "Delegate more than you have", result: "INSUFFICIENT_BUDGET", ok: false },
  { title: "Give a child looser limits than yours", result: "POLICY_EXCEEDS_PARENT", ok: false },
  { title: "Same invoice, five times at once", result: "1 reservation", ok: true },
  { title: "Forge the payout callback", result: "method is private", ok: false },
  { title: "Split spend across four children", result: "COUNTERPARTY_LIMIT", ok: false },
  { title: "Keep paying after your parent is revoked", result: "ANCESTOR_REVOKED", ok: false },
  { title: "Hoard budget, then pay late", result: "RESERVATION_EXPIRED", ok: false },
  { title: "Pay an account that doesn't exist", result: "refunded, reopened", ok: true },
];

// Testnet concurrency run, CI run 43208727340 (evidence/testnet/concurrency-*.json).
export const evidence = [
  { k: "Requested", v: "1.3815", note: "NEAR, 24 concurrent requests" },
  { k: "Accepted", v: "0.5728", note: "NEAR, 11 requests, all settled" },
  { k: "Rejected", v: "13", note: "5 over budget · 8 over vendor cap" },
  { k: "Limit breaches", v: "0", note: "invariants rechecked vs. real balance", good: true },
  { k: "reserve gas", v: "~4.0", note: "Tgas on testnet (rejection ~2.6)" },
  { k: "Time to final", v: "~4.5 s", note: "reserve, p50 on testnet" },
];
