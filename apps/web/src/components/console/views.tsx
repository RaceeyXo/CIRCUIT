import type { AgentView, ReservationView, TreasuryView } from "@circuit/shared/types";

import { big, near, pct, relTime } from "@/lib/format";

/** Full class strings (Tailwind only generates classes it can see whole in the source). */
const SEG = {
  spent: "bg-spent",
  reserved: "bg-reserved",
  idle: "bg-idle",
  free: "bg-free ring-1 ring-inset ring-dash",
  delegated: "bg-delegated",
} as const;
type Seg = keyof typeof SEG;

const STATUS_PILL: Record<string, string> = {
  Reserved: "text-reserved",
  Executing: "text-flight",
  Settled: "text-ok",
  Released: "text-muted",
};

export const TABLE =
  "w-full border-collapse text-[13px] [&_th]:border-b [&_th]:border-line [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-[11px] [&_th]:font-medium [&_th]:tracking-[0.06em] [&_th]:text-muted [&_th]:uppercase [&_td]:border-b [&_td]:border-line [&_td]:p-2 [&_td]:align-top";

export function SegBar({ parts, whole, className = "h-2.5" }: { parts: { seg: Seg; v: bigint; label: string }[]; whole: bigint; className?: string }) {
  return (
    <div className={`bar ${className}`} role="img" aria-label={parts.map((p) => `${p.label} ${near(p.v)}`).join(", ")}>
      {parts
        .filter((p) => p.v > 0n)
        .map((p) => (
          <span key={p.label} className={`seg ${SEG[p.seg]}`} style={{ width: `${pct(p.v, whole)}%` }} title={`${p.label}: ${near(p.v, 6)} NEAR`} />
        ))}
    </div>
  );
}

export function Swatch({ seg, label }: { seg: Seg; label: string }) {
  return (
    <span>
      <i className={`sw ${SEG[seg]}`} />
      {label}
    </span>
  );
}

export function TreasuryPanel({ t }: { t: TreasuryView }) {
  const budget = big(t.total_budget);
  const spent = big(t.total_spent);
  const reserved = big(t.total_reserved);
  const allocated = big(t.allocated);
  const idle = allocated - spent - reserved;
  const stats: [string, string, string][] = [
    ["Budget", t.total_budget, "border-line"],
    ["Allocated", t.allocated, "border-line"],
    ["Reserved", t.total_reserved, "border-reserved"],
    ["In flight", t.in_flight, "border-flight"],
    ["Spent", t.total_spent, "border-spent"],
    ["Remaining", t.remaining, "border-ok"],
  ];
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-6">
        {stats.map(([label, v, border]) => (
          <div key={label} className={`border-l-3 pl-2.5 ${border}`}>
            <div className="text-[11px] tracking-[0.08em] text-muted uppercase">{label}</div>
            <div className="mt-0.5 font-mono text-[26px] font-semibold tracking-[-0.03em] tabular-nums">{near(v)}</div>
          </div>
        ))}
      </div>
      <SegBar
        whole={budget}
        parts={[
          { seg: "spent", v: spent, label: "Spent" },
          { seg: "reserved", v: reserved, label: "Reserved" },
          { seg: "idle", v: idle > 0n ? idle : 0n, label: "Allocated, not committed" },
          { seg: "free", v: budget - allocated, label: "Unallocated" },
        ]}
      />
      <div className="mt-2.5 flex flex-wrap gap-3.5 text-xs text-muted">
        <Swatch seg="spent" label="Spent" />
        <Swatch seg="reserved" label="Reserved" />
        <Swatch seg="idle" label="Allocated, uncommitted" />
        <Swatch seg="free" label="Unallocated" />
        <span>
          {t.agent_count} agents · {t.reservation_count} reservations
          {t.paused && <b className="pill ml-1.5 text-bad">PAUSED</b>}
        </span>
      </div>
    </>
  );
}

export function AgentTree({ agents, open, onToggle, short }: { agents: AgentView[]; open: Set<string>; onToggle: (id: string) => void; short: (id: string) => string }) {
  if (agents.length === 0) return <p className="py-3 text-muted">No agents registered yet.</p>;
  const children = new Map<string | null, AgentView[]>();
  for (const a of agents) children.set(a.parent, [...(children.get(a.parent) ?? []), a]);

  const rows: React.ReactNode[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const a of children.get(parent) ?? []) {
      const kids = children.get(a.id)?.length ?? 0;
      const revoked = a.status === "Revoked";
      const isOpen = open.has(a.id);
      rows.push(
        <li
          key={a.id}
          className={`relative ${depth > 0 ? "border-l border-dashed border-line pl-2" : ""} ${revoked ? "[&_.bar]:opacity-45" : ""}`}
          style={{ marginLeft: Math.max(0, depth - 1) * 18 + (depth > 0 ? 8 : 0) }}
        >
          <button
            className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2.5 gap-y-1.5 border-b border-line px-1 py-2.5 text-left hover:bg-accent/5 [&>.bar]:col-span-3"
            onClick={() => onToggle(a.id)}
            aria-expanded={isOpen}
          >
            <span className={`truncate font-mono text-[13px] ${revoked ? "text-muted line-through" : ""}`} title={a.id}>
              {short(a.id)}
              {kids > 0 && <span className="text-muted"> · {kids}</span>}
            </span>
            <span className={`pill ${revoked ? "text-bad" : "text-ok"}`}>{a.status}</span>
            <span className="font-mono text-[13px] tabular-nums">
              {near(a.available)} <span className="text-muted">/ {near(a.allocation)}</span>
            </span>
            <SegBar
              className="h-1.5"
              whole={big(a.allocation)}
              parts={[
                { seg: "spent", v: big(a.spent), label: "Spent" },
                { seg: "reserved", v: big(a.reserved), label: "Reserved" },
                { seg: "delegated", v: big(a.delegated), label: "Delegated to children" },
              ]}
            />
          </button>
          {isOpen && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 border-b border-line px-1.5 pt-2.5 pb-3.5 text-xs [&_dd]:font-mono [&_dt]:text-muted [&>div]:flex [&>div]:justify-between [&>div]:gap-2">
              <div><dt>Spent</dt><dd>{near(a.spent, 6)}</dd></div>
              <div><dt>Reserved</dt><dd>{near(a.reserved, 6)} ({a.pending_count} live)</dd></div>
              <div><dt>Delegated</dt><dd>{near(a.delegated, 6)}</dd></div>
              <div><dt>Max per tx</dt><dd>{near(a.policy.max_tx_amount)}</dd></div>
              <div><dt>Max pending</dt><dd>{near(a.policy.max_pending_amount)} · {a.policy.max_pending_count} req</dd></div>
              <div><dt>Max per counterparty</dt><dd>{near(a.policy.max_counterparty_exposure)}</dd></div>
              <div><dt>Max delegated</dt><dd>{near(a.policy.max_delegated)}</dd></div>
              <div><dt>Max TTL</dt><dd>{Number(big(a.policy.max_reservation_ttl_ns) / 1_000_000_000n)} s</dd></div>
            </dl>
          )}
        </li>,
      );
      walk(a.id, depth + 1);
    }
  };
  walk(null, 0);
  return <ul className="mt-2">{rows}</ul>;
}

export function ReservationsTable({ rs, short }: { rs: ReservationView[]; short: (id: string) => string }) {
  if (rs.length === 0) return <p className="py-3 text-muted">No reservations yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className={TABLE}>
        <thead>
          <tr><th>#</th><th>Status</th><th>Agent → counterparty</th><th className="text-right">Amount</th><th>When</th></tr>
        </thead>
        <tbody>
          {rs.map((r) => (
            <tr key={r.id}>
              <td className="font-mono text-muted">{r.id}</td>
              <td>
                <span className={`pill ${STATUS_PILL[r.status] ?? "text-muted"}`}>
                  {r.status}
                  {r.release_reason ? ` · ${r.release_reason}` : ""}
                </span>
                {r.failed_attempts > 0 && <span className="pill ml-1 text-bad" title="failed payout attempts">{r.failed_attempts}× failed</span>}
              </td>
              <td className="font-mono text-xs break-all">
                <span title={r.agent}>{short(r.agent)}</span> → <span title={r.counterparty}>{short(r.counterparty)}</span>
                <div className="text-muted">{r.request_id}</div>
              </td>
              <td className="text-right font-mono tabular-nums">{near(r.amount)}</td>
              <td className="text-xs text-muted">{r.closed_at ? `closed ${relTime(r.closed_at)}` : `expires ${relTime(r.expires_at)}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface Report {
  scenario: string;
  network: string;
  contract: string;
  started_at: string;
  passed: boolean;
  checks: { name: string; pass: boolean; detail: string }[];
  metrics: Record<string, unknown>;
  transactions: { step: string; actor: string; method: string; ok: boolean; code?: string; txHash: string; gasBurnt: string }[];
}

export function ReportCard({ r, networkName, explorer, short, onWatch }: { r: Report; networkName: string; explorer: string | null; short: (id: string) => string; onWatch: (contract: string) => void }) {
  const passed = r.checks.filter((c) => c.pass).length;
  return (
    <article className="mb-4 rounded-card border border-line bg-surface p-[18px]">
      <header className="mb-3 flex flex-wrap items-center gap-2.5">
        <h3 className="text-base font-semibold capitalize">{r.scenario}</h3>
        <span className={`pill ${r.passed ? "text-ok" : "text-bad"}`}>{r.passed ? "PASSED" : "FAILED"} {passed}/{r.checks.length}</span>
        <span className="text-xs text-muted">
          {r.network === "external" ? networkName : "sandbox"} · {r.contract} · {new Date(r.started_at).toLocaleString()}
        </span>
        <button className="ml-auto cursor-pointer text-accent" onClick={() => onWatch(r.contract)}>Watch this contract live →</button>
      </header>
      <ol className="mb-3 list-decimal pl-5 [&>li]:py-0.5">
        {r.checks.map((c) => (
          <li key={c.name}>
            <b className={`font-mono text-[11px] ${c.pass ? "text-ok" : "text-bad"}`}>{c.pass ? "PASS" : "FAIL"}</b> {c.name} <span className="text-muted">— {c.detail}</span>
          </li>
        ))}
      </ol>
      {Object.keys(r.metrics).length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-muted">Metrics</summary>
          <pre className="overflow-x-auto rounded-md bg-bg p-3 font-mono text-xs">{JSON.stringify(r.metrics, null, 2)}</pre>
        </details>
      )}
      <details className="mt-2">
        <summary className="cursor-pointer text-muted">{r.transactions.length} transactions</summary>
        <div className="overflow-x-auto">
          <table className={TABLE}>
            <thead>
              <tr><th>Step</th><th>Actor</th><th>Method</th><th>Result</th><th className="text-right">Gas (Tgas)</th><th>Tx</th></tr>
            </thead>
            <tbody>
              {r.transactions.map((t, i) => (
                <tr key={`${t.txHash}-${i}`}>
                  <td>{t.step}</td>
                  <td className="font-mono text-xs break-all">{short(t.actor)}</td>
                  <td>{t.method}</td>
                  <td>{t.ok ? <span className="pill text-ok">ok</span> : <span className="pill text-bad">{t.code ?? "failed"}</span>}</td>
                  <td className="text-right font-mono tabular-nums">{(Number(big(t.gasBurnt) / 1_000_000_000n) / 1000).toFixed(3)}</td>
                  <td className="font-mono">
                    {explorer && r.network === "external" && t.txHash ? (
                      <a className="text-accent" href={`${explorer}${t.txHash}`} target="_blank" rel="noopener">{t.txHash.slice(0, 10)}…</a>
                    ) : (
                      `${t.txHash.slice(0, 10)}…`
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </article>
  );
}
