import "./tailwind.css";

import type { AgentView, ReservationView, TreasuryView } from "@circuit/shared/types";
import { formatNear } from "@circuit/shared/units";

import { ViewClient } from "./rpc";

// ── Config (URL params override build-time defaults) ─────────────────────────
const params = new URLSearchParams(location.search);
const NETWORKS: Record<string, { rpc: string; explorer: string | null }> = {
  testnet: { rpc: "https://test.rpc.fastnear.com", explorer: "https://testnet.nearblocks.io/txns/" },
  mainnet: { rpc: "https://free.rpc.fastnear.com", explorer: "https://nearblocks.io/txns/" },
  local: { rpc: "http://localhost:3030", explorer: null },
};
const network = params.get("network") ?? import.meta.env.VITE_NETWORK ?? "testnet";
const rpcUrl = params.get("rpc") ?? NETWORKS[network]?.rpc ?? NETWORKS.testnet!.rpc;
const explorer = NETWORKS[network]?.explorer ?? null;
let contractId = params.get("contract") ?? import.meta.env.VITE_CONTRACT_ID ?? "";

// ── Helpers ─────────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const big = (s: string) => BigInt(s);
const near = (y: bigint | string, d = 3) => formatNear(y, d);
const pct = (part: bigint, whole: bigint) => (whole === 0n ? 0 : Number((part * 100_000n) / whole) / 1000);
/** Shortens `name.<common suffix>` ids so the tree stays readable. */
function short(id: string): string {
  const suffix = contractId.includes(".") ? contractId.slice(contractId.indexOf(".")) : "";
  return suffix && id.endsWith(suffix) ? id.slice(0, -suffix.length) : id;
}
const nsToDate = (ns: string) => new Date(Number(big(ns) / 1_000_000n));
function rel(ns: string): string {
  const s = Math.round((nsToDate(ns).getTime() - Date.now()) / 1000);
  const a = Math.abs(s);
  const t = a < 90 ? `${a}s` : a < 5400 ? `${Math.round(a / 60)}m` : `${Math.round(a / 3600)}h`;
  return s >= 0 ? `in ${t}` : `${t} ago`;
}

// ── Live view ───────────────────────────────────────────────────────────────
/** Full class strings (Tailwind only generates classes it can see whole in the source). */
const SEG = {
  spent: "bg-spent",
  reserved: "bg-reserved",
  idle: "bg-idle",
  free: "bg-free ring-1 ring-inset ring-dash",
  delegated: "bg-delegated",
} as const;
const STATUS_PILL: Record<string, string> = {
  Reserved: "text-reserved",
  Executing: "text-flight",
  Settled: "text-ok",
  Released: "text-muted",
};

function segBar(parts: { cls: keyof typeof SEG; v: bigint; label: string }[], whole: bigint, height = "h-2.5"): string {
  return `<div class="bar ${height}" role="img" aria-label="${esc(parts.map((p) => `${p.label} ${near(p.v)}`).join(", "))}">${parts
    .filter((p) => p.v > 0n)
    .map((p) => `<span class="seg ${SEG[p.cls]}" style="width:${pct(p.v, whole)}%" title="${esc(p.label)}: ${near(p.v, 6)} NEAR"></span>`)
    .join("")}</div>`;
}

function renderTreasury(t: TreasuryView): string {
  const budget = big(t.total_budget);
  const spent = big(t.total_spent);
  const reserved = big(t.total_reserved);
  const allocated = big(t.allocated);
  const idle = allocated - spent - reserved;
  const stat = (label: string, v: string, border = "border-line") =>
    `<div class="border-l-3 ${border} pl-2.5"><div class="text-[11px] tracking-[0.08em] text-muted uppercase">${label}</div><div class="mt-0.5 font-mono text-[26px] font-semibold tracking-[-0.03em] tabular-nums">${near(v)}</div></div>`;
  return `
    <div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-6">
      ${stat("Budget", t.total_budget)}
      ${stat("Allocated", t.allocated)}
      ${stat("Reserved", t.total_reserved, "border-reserved")}
      ${stat("In flight", t.in_flight, "border-flight")}
      ${stat("Spent", t.total_spent, "border-spent")}
      ${stat("Remaining", t.remaining, "border-ok")}
    </div>
    ${segBar(
      [
        { cls: "spent", v: spent, label: "Spent" },
        { cls: "reserved", v: reserved, label: "Reserved" },
        { cls: "idle", v: idle > 0n ? idle : 0n, label: "Allocated, not committed" },
        { cls: "free", v: budget - allocated, label: "Unallocated" },
      ],
      budget,
    )}
    <div class="mt-2.5 flex flex-wrap gap-3.5 text-xs text-muted">
      <span><i class="sw bg-spent"></i>Spent</span><span><i class="sw bg-reserved"></i>Reserved</span>
      <span><i class="sw bg-idle"></i>Allocated, uncommitted</span><span><i class="sw bg-free ring-1 ring-inset ring-dash"></i>Unallocated</span>
      <span>${t.agent_count} agents · ${t.reservation_count} reservations${t.paused ? ' · <b class="pill text-bad">PAUSED</b>' : ""}</span>
    </div>`;
}

const open = new Set<string>();

function renderAgents(agents: AgentView[]): string {
  if (agents.length === 0) return `<p class="py-3 text-muted">No agents registered yet.</p>`;
  const children = new Map<string | null, AgentView[]>();
  for (const a of agents) children.set(a.parent, [...(children.get(a.parent) ?? []), a]);
  const rows: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const a of children.get(parent) ?? []) {
      const alloc = big(a.allocation);
      const kids = children.get(a.id)?.length ?? 0;
      rows.push(`
        <li class="relative ${depth > 0 ? "border-l border-dashed border-line pl-2" : ""} ${a.status === "Revoked" ? "[&_.bar]:opacity-45" : ""}" style="margin-left:${Math.max(0, depth - 1) * 18 + (depth > 0 ? 8 : 0)}px">
          <button class="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2.5 gap-y-1.5 border-b border-line px-1 py-2.5 text-left hover:bg-accent/5 [&>.bar]:col-span-3" data-agent="${esc(a.id)}" aria-expanded="${open.has(a.id)}">
            <span class="truncate font-mono text-[13px] ${a.status === "Revoked" ? "text-muted line-through" : ""}" title="${esc(a.id)}">${esc(short(a.id))}${kids ? ` <span class="text-muted">· ${kids}</span>` : ""}</span>
            <span class="pill ${a.status === "Revoked" ? "text-bad" : "text-ok"}">${a.status}</span>
            <span class="font-mono text-[13px] tabular-nums">${near(a.available)} <span class="text-muted">/ ${near(a.allocation)}</span></span>
            ${segBar(
              [
                { cls: "spent", v: big(a.spent), label: "Spent" },
                { cls: "reserved", v: big(a.reserved), label: "Reserved" },
                { cls: "delegated", v: big(a.delegated), label: "Delegated to children" },
              ],
              alloc,
              "h-1.5",
            )}
          </button>
          ${
            open.has(a.id)
              ? `<dl class="grid grid-cols-2 gap-x-4 gap-y-1.5 border-b border-line px-1.5 pt-2.5 pb-3.5 text-xs [&>div]:flex [&>div]:justify-between [&>div]:gap-2 [&_dt]:text-muted [&_dd]:font-mono">
                  <div><dt>Spent</dt><dd>${near(a.spent, 6)}</dd></div>
                  <div><dt>Reserved</dt><dd>${near(a.reserved, 6)} (${a.pending_count} live)</dd></div>
                  <div><dt>Delegated</dt><dd>${near(a.delegated, 6)}</dd></div>
                  <div><dt>Max per tx</dt><dd>${near(a.policy.max_tx_amount)}</dd></div>
                  <div><dt>Max pending</dt><dd>${near(a.policy.max_pending_amount)} · ${a.policy.max_pending_count} req</dd></div>
                  <div><dt>Max per counterparty</dt><dd>${near(a.policy.max_counterparty_exposure)}</dd></div>
                  <div><dt>Max delegated</dt><dd>${near(a.policy.max_delegated)}</dd></div>
                  <div><dt>Max TTL</dt><dd>${Number(big(a.policy.max_reservation_ttl_ns) / 1_000_000_000n)} s</dd></div>
                </dl>`
              : ""
          }
        </li>`);
      walk(a.id, depth + 1);
    }
  };
  walk(null, 0);
  return `<ul class="mt-2">${rows.join("")}</ul>`;
}

function renderReservations(rs: ReservationView[]): string {
  if (rs.length === 0) return `<p class="py-3 text-muted">No reservations yet.</p>`;
  return `<div class="overflow-x-auto"><table class="${TABLE}">
    <thead><tr><th>#</th><th>Status</th><th>Agent → counterparty</th><th class="text-right">Amount</th><th>When</th></tr></thead>
    <tbody>${rs
      .map(
        (r) => `<tr>
        <td class="font-mono text-muted">${esc(r.id)}</td>
        <td><span class="pill ${STATUS_PILL[r.status] ?? "text-muted"}">${r.status}${r.release_reason ? ` · ${r.release_reason}` : ""}</span>${r.failed_attempts ? ` <span class="pill text-bad" title="failed payout attempts">${r.failed_attempts}× failed</span>` : ""}</td>
        <td class="font-mono text-xs break-all"><span title="${esc(r.agent)}">${esc(short(r.agent))}</span> → <span title="${esc(r.counterparty)}">${esc(short(r.counterparty))}</span><div class="text-muted">${esc(r.request_id)}</div></td>
        <td class="text-right font-mono tabular-nums">${near(r.amount)}</td>
        <td class="text-xs text-muted">${r.closed_at ? `closed ${rel(r.closed_at)}` : `expires ${rel(r.expires_at)}`}</td>
      </tr>`,
      )
      .join("")}</tbody></table></div>`;
}

const TABLE =
  "w-full border-collapse text-[13px] [&_th]:border-b [&_th]:border-line [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-[11px] [&_th]:font-medium [&_th]:tracking-[0.06em] [&_th]:text-muted [&_th]:uppercase [&_td]:border-b [&_td]:border-line [&_td]:p-2 [&_td]:align-top";
const STATUS_BASE =
  "ml-auto flex max-w-[60%] items-center gap-1.5 truncate font-mono text-xs before:size-[7px] before:shrink-0 before:rounded-full before:content-['']";
const STATUS_KIND = { ok: "text-muted before:bg-ok", bad: "text-bad before:bg-bad", idle: "text-muted before:bg-muted" } as const;

let timer: number | undefined;
let inFlight = false;

async function refresh() {
  if (!contractId || inFlight) return;
  inFlight = true;
  const client = new ViewClient(rpcUrl, contractId);
  try {
    const t = await client.treasury();
    const [agents, rs] = await Promise.all([client.agents(), client.recentReservations(t.reservation_count)]);
    $("#treasury").innerHTML = renderTreasury(t);
    $("#agents").innerHTML = renderAgents(agents);
    $("#reservations").innerHTML = renderReservations(rs);
    setStatus("ok", `live · final state · ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    setStatus("bad", (err as Error).message);
  } finally {
    inFlight = false;
  }
}

function setStatus(kind: "ok" | "bad" | "idle", text: string) {
  const el = $("#status");
  el.className = `${STATUS_BASE} ${STATUS_KIND[kind]}`;
  el.textContent = text;
}

function startLive() {
  window.clearInterval(timer);
  if (!contractId) {
    setStatus("idle", "enter a contract account to watch");
    return;
  }
  void refresh();
  timer = window.setInterval(() => void refresh(), 4000);
}

// ── Evidence view (simulator reports) ───────────────────────────────────────
interface Report {
  scenario: string;
  network: string;
  contract: string;
  started_at: string;
  passed: boolean;
  checks: { name: string; pass: boolean; detail: string }[];
  metrics: Record<string, unknown>;
  transactions: { step: string; actor: string; method: string; ok: boolean; code?: string; txHash: string; gasBurnt: string }[];
}

function renderReport(r: Report): string {
  const passed = r.checks.filter((c) => c.pass).length;
  const txLink = (h: string) =>
    explorer && r.network === "external"
      ? `<a class="text-accent" href="${explorer}${esc(h)}" target="_blank" rel="noopener">${esc(h.slice(0, 10))}…</a>`
      : esc(h.slice(0, 10)) + "…";
  return `<article class="mb-4 rounded-card border border-line bg-surface p-[18px]">
    <header class="mb-3 flex flex-wrap items-center gap-2.5">
      <h3 class="text-base font-semibold capitalize">${esc(r.scenario)}</h3>
      <span class="pill ${r.passed ? "text-ok" : "text-bad"}">${r.passed ? "PASSED" : "FAILED"} ${passed}/${r.checks.length}</span>
      <span class="text-xs text-muted">${esc(r.network === "external" ? network : "sandbox")} · ${esc(r.contract)} · ${esc(new Date(r.started_at).toLocaleString())}</span>
      <button class="ml-auto cursor-pointer text-accent" data-watch="${esc(r.contract)}">Watch this contract live →</button>
    </header>
    <ol class="mb-3 list-decimal pl-5 [&>li]:py-0.5">${r.checks
      .map(
        (c) =>
          `<li><b class="font-mono text-[11px] ${c.pass ? "text-ok" : "text-bad"}">${c.pass ? "PASS" : "FAIL"}</b> ${esc(c.name)} <span class="text-muted">— ${esc(c.detail)}</span></li>`,
      )
      .join("")}</ol>
    ${
      Object.keys(r.metrics).length
        ? `<details class="mt-2"><summary class="cursor-pointer text-muted">Metrics</summary><pre class="overflow-x-auto rounded-md bg-bg p-3 font-mono text-xs">${esc(JSON.stringify(r.metrics, null, 2))}</pre></details>`
        : ""
    }
    <details class="mt-2"><summary class="cursor-pointer text-muted">${r.transactions.length} transactions</summary><div class="overflow-x-auto"><table class="${TABLE}">
      <thead><tr><th>Step</th><th>Actor</th><th>Method</th><th>Result</th><th class="text-right">Gas (Tgas)</th><th>Tx</th></tr></thead>
      <tbody>${r.transactions
        .map(
          (t) => `<tr><td>${esc(t.step)}</td><td class="font-mono text-xs break-all">${esc(short(t.actor))}</td><td>${esc(t.method)}</td>
          <td>${t.ok ? '<span class="pill text-ok">ok</span>' : `<span class="pill text-bad">${esc(t.code ?? "failed")}</span>`}</td>
          <td class="text-right font-mono tabular-nums">${(Number(big(t.gasBurnt) / 1_000_000_000n) / 1000).toFixed(3)}</td><td class="font-mono">${txLink(t.txHash)}</td></tr>`,
        )
        .join("")}</tbody></table></div></details>
  </article>`;
}

async function loadReports(urls: string[]) {
  const out = $("#reports");
  out.innerHTML = `<p class="text-muted">Loading…</p>`;
  const html: string[] = [];
  for (const u of urls) {
    try {
      const r = (await (await fetch(u)).json()) as Report;
      html.push(renderReport(r));
    } catch (err) {
      html.push(`<p class="text-bad">Could not load ${esc(u)}: ${esc((err as Error).message)}</p>`);
    }
  }
  out.innerHTML = html.join("") || `<p class="py-3 text-muted">No reports.</p>`;
}

// ── Wiring ──────────────────────────────────────────────────────────────────
function showTab(tab: "live" | "evidence") {
  for (const el of document.querySelectorAll<HTMLElement>("[data-tab]")) el.setAttribute("aria-selected", String(el.dataset.tab === tab));
  $("#live").hidden = tab !== "live";
  $("#evidence").hidden = tab !== "evidence";
}

document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const row = target.closest<HTMLElement>("[data-agent]");
  if (row) {
    const id = row.dataset.agent!;
    open.has(id) ? open.delete(id) : open.add(id);
    void refresh();
  }
  const tab = target.closest<HTMLElement>("[data-tab]");
  if (tab) showTab(tab.dataset.tab as "live" | "evidence");
  const watch = target.closest<HTMLElement>("[data-watch]");
  if (watch) {
    contractId = watch.dataset.watch!;
    $<HTMLInputElement>("#contract").value = contractId;
    showTab("live");
    startLive();
  }
});

$("#contract-form").addEventListener("submit", (e) => {
  e.preventDefault();
  contractId = $<HTMLInputElement>("#contract").value.trim();
  const u = new URL(location.href);
  u.searchParams.set("contract", contractId);
  history.replaceState(null, "", u);
  startLive();
});

$<HTMLInputElement>("#report-file").addEventListener("change", async (e) => {
  const files = [...((e.target as HTMLInputElement).files ?? [])];
  const reports = await Promise.all(files.map(async (f) => JSON.parse(await f.text()) as Report));
  $("#reports").innerHTML = reports.map(renderReport).join("");
});

$<HTMLInputElement>("#contract").value = contractId;
$("#net").textContent = `${network} · ${new URL(rpcUrl).host}`;
const reportUrls = params.getAll("report");
const defaultReports = (import.meta.env.VITE_REPORTS ?? "").split(",").filter(Boolean);
if (reportUrls.length || defaultReports.length) void loadReports(reportUrls.length ? reportUrls : defaultReports);
showTab(params.get("tab") === "evidence" ? "evidence" : "live");
startLive();
