import "./style.css";

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
function segBar(parts: { cls: string; v: bigint; label: string }[], whole: bigint): string {
  return `<div class="bar" role="img" aria-label="${esc(parts.map((p) => `${p.label} ${near(p.v)}`).join(", "))}">${parts
    .filter((p) => p.v > 0n)
    .map((p) => `<span class="seg ${p.cls}" style="width:${pct(p.v, whole)}%" title="${esc(p.label)}: ${near(p.v, 6)} NEAR"></span>`)
    .join("")}</div>`;
}

function renderTreasury(t: TreasuryView): string {
  const budget = big(t.total_budget);
  const spent = big(t.total_spent);
  const reserved = big(t.total_reserved);
  const allocated = big(t.allocated);
  const idle = allocated - spent - reserved;
  const stat = (label: string, v: string, cls = "") =>
    `<div class="stat ${cls}"><div class="k">${label}</div><div class="v num">${near(v)}</div></div>`;
  return `
    <div class="stats">
      ${stat("Budget", t.total_budget)}
      ${stat("Allocated", t.allocated)}
      ${stat("Reserved", t.total_reserved, "c-reserved")}
      ${stat("In flight", t.in_flight, "c-flight")}
      ${stat("Spent", t.total_spent, "c-spent")}
      ${stat("Remaining", t.remaining, "c-remaining")}
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
    <div class="legend">
      <span><i class="sw spent"></i>Spent</span><span><i class="sw reserved"></i>Reserved</span>
      <span><i class="sw idle"></i>Allocated, uncommitted</span><span><i class="sw free"></i>Unallocated</span>
      <span class="muted">${t.agent_count} agents · ${t.reservation_count} reservations${t.paused ? ' · <b class="pill bad">PAUSED</b>' : ""}</span>
    </div>`;
}

const open = new Set<string>();

function renderAgents(agents: AgentView[]): string {
  if (agents.length === 0) return `<p class="empty">No agents registered yet.</p>`;
  const children = new Map<string | null, AgentView[]>();
  for (const a of agents) children.set(a.parent, [...(children.get(a.parent) ?? []), a]);
  const rows: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const a of children.get(parent) ?? []) {
      const alloc = big(a.allocation);
      const kids = children.get(a.id)?.length ?? 0;
      rows.push(`
        <li class="agent ${a.status === "Revoked" ? "revoked" : ""}" style="--depth:${depth}">
          <button class="row" data-agent="${esc(a.id)}" aria-expanded="${open.has(a.id)}">
            <span class="name" title="${esc(a.id)}">${esc(short(a.id))}${kids ? ` <span class="muted">· ${kids}</span>` : ""}</span>
            <span class="pill ${a.status === "Revoked" ? "bad" : "ok"}">${a.status}</span>
            <span class="num avail">${near(a.available)} <span class="muted">/ ${near(a.allocation)}</span></span>
            ${segBar(
              [
                { cls: "spent", v: big(a.spent), label: "Spent" },
                { cls: "reserved", v: big(a.reserved), label: "Reserved" },
                { cls: "delegated", v: big(a.delegated), label: "Delegated to children" },
              ],
              alloc,
            )}
          </button>
          ${
            open.has(a.id)
              ? `<dl class="policy">
                  <div><dt>Spent</dt><dd class="num">${near(a.spent, 6)}</dd></div>
                  <div><dt>Reserved</dt><dd class="num">${near(a.reserved, 6)} (${a.pending_count} live)</dd></div>
                  <div><dt>Delegated</dt><dd class="num">${near(a.delegated, 6)}</dd></div>
                  <div><dt>Max per tx</dt><dd class="num">${near(a.policy.max_tx_amount)}</dd></div>
                  <div><dt>Max pending</dt><dd class="num">${near(a.policy.max_pending_amount)} · ${a.policy.max_pending_count} req</dd></div>
                  <div><dt>Max per counterparty</dt><dd class="num">${near(a.policy.max_counterparty_exposure)}</dd></div>
                  <div><dt>Max delegated</dt><dd class="num">${near(a.policy.max_delegated)}</dd></div>
                  <div><dt>Max TTL</dt><dd class="num">${Number(big(a.policy.max_reservation_ttl_ns) / 1_000_000_000n)} s</dd></div>
                </dl>`
              : ""
          }
        </li>`);
      walk(a.id, depth + 1);
    }
  };
  walk(null, 0);
  return `<ul class="tree">${rows.join("")}</ul>`;
}

function renderReservations(rs: ReservationView[]): string {
  if (rs.length === 0) return `<p class="empty">No reservations yet.</p>`;
  return `<div class="scroll"><table>
    <thead><tr><th>#</th><th>Status</th><th>Agent → counterparty</th><th class="r">Amount</th><th>When</th></tr></thead>
    <tbody>${rs
      .map(
        (r) => `<tr>
        <td class="num muted">${esc(r.id)}</td>
        <td><span class="pill st-${r.status.toLowerCase()}">${r.status}${r.release_reason ? ` · ${r.release_reason}` : ""}</span>${r.failed_attempts ? ` <span class="pill bad" title="failed payout attempts">${r.failed_attempts}× failed</span>` : ""}</td>
        <td class="ids"><span title="${esc(r.agent)}">${esc(short(r.agent))}</span> → <span title="${esc(r.counterparty)}">${esc(short(r.counterparty))}</span><div class="muted small">${esc(r.request_id)}</div></td>
        <td class="num r">${near(r.amount)}</td>
        <td class="muted small">${r.closed_at ? `closed ${rel(r.closed_at)}` : `expires ${rel(r.expires_at)}`}</td>
      </tr>`,
      )
      .join("")}</tbody></table></div>`;
}

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
  el.className = `status ${kind}`;
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
  const txLink = (h: string) => (explorer && r.network === "external" ? `<a href="${explorer}${esc(h)}" target="_blank" rel="noopener">${esc(h.slice(0, 10))}…</a>` : esc(h.slice(0, 10)) + "…");
  return `<article class="report">
    <header><h3>${esc(r.scenario)}</h3>
      <span class="pill ${r.passed ? "ok" : "bad"}">${r.passed ? "PASSED" : "FAILED"} ${passed}/${r.checks.length}</span>
      <span class="muted small">${esc(r.network === "external" ? network : "sandbox")} · ${esc(r.contract)} · ${esc(new Date(r.started_at).toLocaleString())}</span>
      <button class="link" data-watch="${esc(r.contract)}">Watch this contract live →</button>
    </header>
    <ol class="checks">${r.checks.map((c) => `<li class="${c.pass ? "pass" : "fail"}"><b>${c.pass ? "PASS" : "FAIL"}</b> ${esc(c.name)} <span class="muted">— ${esc(c.detail)}</span></li>`).join("")}</ol>
    ${Object.keys(r.metrics).length ? `<details><summary>Metrics</summary><pre>${esc(JSON.stringify(r.metrics, null, 2))}</pre></details>` : ""}
    <details><summary>${r.transactions.length} transactions</summary><div class="scroll"><table>
      <thead><tr><th>Step</th><th>Actor</th><th>Method</th><th>Result</th><th class="r">Gas (Tgas)</th><th>Tx</th></tr></thead>
      <tbody>${r.transactions
        .map(
          (t) => `<tr><td>${esc(t.step)}</td><td class="ids">${esc(short(t.actor))}</td><td>${esc(t.method)}</td>
          <td>${t.ok ? '<span class="pill ok">ok</span>' : `<span class="pill bad">${esc(t.code ?? "failed")}</span>`}</td>
          <td class="num r">${(Number(big(t.gasBurnt) / 1_000_000_000n) / 1000).toFixed(3)}</td><td class="num">${txLink(t.txHash)}</td></tr>`,
        )
        .join("")}</tbody></table></div></details>
  </article>`;
}

async function loadReports(urls: string[]) {
  const out = $("#reports");
  out.innerHTML = `<p class="muted">Loading…</p>`;
  const html: string[] = [];
  for (const u of urls) {
    try {
      const r = (await (await fetch(u)).json()) as Report;
      html.push(renderReport(r));
    } catch (err) {
      html.push(`<p class="bad">Could not load ${esc(u)}: ${esc((err as Error).message)}</p>`);
    }
  }
  out.innerHTML = html.join("") || `<p class="empty">No reports.</p>`;
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
