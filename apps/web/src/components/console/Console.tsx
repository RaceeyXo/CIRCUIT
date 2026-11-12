"use client";

import type { AgentView, ReservationView, TreasuryView } from "@circuit/shared/types";
import { useCallback, useEffect, useRef, useState } from "react";

import { NETWORKS, shortId } from "@/lib/format";
import { ViewClient } from "@/lib/rpc";

import { AgentTree, ReportCard, ReservationsTable, Swatch, TreasuryPanel, type Report } from "./views";

const POLL_MS = 4000;
const H2 = "mb-4 text-[13px] font-medium tracking-[0.1em] text-ink-2 uppercase";
const CARD = "mb-4 min-w-0 rounded-card border border-line bg-surface p-[18px]";
const TAB = "cursor-pointer rounded-full px-4 py-1.5 text-muted aria-selected:bg-accent aria-selected:font-semibold aria-selected:text-accent-ink";

interface Config {
  network: string;
  rpcUrl: string;
  explorer: string | null;
  contract: string;
  reports: string[];
  tab: "live" | "evidence";
}

/** URL params override build-time defaults (NEXT_PUBLIC_*). Read only in the browser. */
function readConfig(): Config {
  const q = new URLSearchParams(window.location.search);
  const network = q.get("network") ?? process.env.NEXT_PUBLIC_NETWORK ?? "testnet";
  const net = NETWORKS[network] ?? NETWORKS.testnet!;
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const defaults = (process.env.NEXT_PUBLIC_REPORTS ?? "").split(",").filter(Boolean).map((p) => `${base}/${p}`);
  return {
    network,
    rpcUrl: q.get("rpc") ?? net.rpc,
    explorer: net.explorer,
    contract: q.get("contract") ?? process.env.NEXT_PUBLIC_CONTRACT_ID ?? "",
    reports: q.getAll("report").length ? q.getAll("report") : defaults,
    tab: q.get("tab") === "evidence" ? "evidence" : "live",
  };
}

type Status = { kind: "ok" | "bad" | "idle"; text: string };

export function Console() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [tab, setTab] = useState<"live" | "evidence">("live");
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle", text: "idle" });
  const [data, setData] = useState<{ t: TreasuryView; agents: AgentView[]; rs: ReservationView[] } | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [reports, setReports] = useState<(Report | { error: string })[]>([]);
  const inFlight = useRef(false);

  useEffect(() => {
    const c = readConfig();
    setCfg(c);
    setInput(c.contract);
    setTab(c.tab);
  }, []);

  const refresh = useCallback(async () => {
    if (!cfg?.contract || inFlight.current) return;
    inFlight.current = true;
    try {
      const client = new ViewClient(cfg.rpcUrl, cfg.contract);
      const t = await client.treasury();
      const [agents, rs] = await Promise.all([client.agents(), client.recentReservations(t.reservation_count)]);
      setData({ t, agents, rs });
      setStatus({ kind: "ok", text: `live · final state · ${new Date().toLocaleTimeString()}` });
    } catch (err) {
      setStatus({ kind: "bad", text: (err as Error).message });
    } finally {
      inFlight.current = false;
    }
  }, [cfg]);

  useEffect(() => {
    if (!cfg) return;
    if (!cfg.contract) {
      setStatus({ kind: "idle", text: "enter a contract account to watch" });
      return;
    }
    setData(null);
    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, [cfg, refresh]);

  useEffect(() => {
    if (!cfg?.reports.length) return;
    let cancelled = false;
    void Promise.all(
      cfg.reports.map(async (u) => {
        try {
          return (await (await fetch(u)).json()) as Report;
        } catch (err) {
          return { error: `Could not load ${u}: ${(err as Error).message}` };
        }
      }),
    ).then((rs) => !cancelled && setReports(rs));
    return () => {
      cancelled = true;
    };
  }, [cfg]);

  const watch = (contract: string) => {
    if (!cfg) return;
    const u = new URL(window.location.href);
    u.searchParams.set("contract", contract);
    window.history.replaceState(null, "", u);
    setInput(contract);
    setCfg({ ...cfg, contract });
    setTab("live");
  };

  const short = (id: string) => shortId(id, cfg?.contract ?? "");
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const dot = status.kind === "ok" ? "before:bg-ok text-muted" : status.kind === "bad" ? "before:bg-bad text-bad" : "before:bg-muted text-muted";

  return (
    <div className="mx-auto max-w-[1240px] px-4 text-sm leading-[1.45]">
      <header className="flex flex-wrap items-end justify-between gap-4 pt-12 pb-5">
        <div>
          <h1 className="text-[34px] font-medium tracking-[-0.03em]">Treasury console</h1>
          <p className="mt-0.5 text-xs text-muted">Read-only. Every number is read from the contract at final finality.</p>
        </div>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            watch(input.trim());
          }}
        >
          <label htmlFor="contract" className="text-xs text-muted">Contract</label>
          <input
            id="contract"
            className="w-[min(360px,70vw)] rounded-full border border-dashed border-dash bg-surface px-3.5 py-2 font-mono text-[13px]"
            placeholder="circuit….testnet"
            spellCheck={false}
            autoComplete="off"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="submit" className="btn btn-sm">Watch</button>
          {cfg && <span className="text-xs text-muted">{cfg.network} · {new URL(cfg.rpcUrl).host}</span>}
        </form>
      </header>

      <nav className="flex items-center gap-1 py-3" role="tablist">
        <button role="tab" className={TAB} aria-selected={tab === "live"} onClick={() => setTab("live")}>Live state</button>
        <button role="tab" className={TAB} aria-selected={tab === "evidence"} onClick={() => setTab("evidence")}>Evidence</button>
        <span role="status" className={`ml-auto flex max-w-[60%] items-center gap-1.5 truncate font-mono text-xs before:size-[7px] before:shrink-0 before:rounded-full before:content-[''] ${dot}`}>
          {status.text}
        </span>
      </nav>

      <main className="pb-16">
        <section hidden={tab !== "live"}>
          <section className={CARD} aria-labelledby="h-treasury">
            <h2 id="h-treasury" className={H2}>Treasury</h2>
            {data ? <TreasuryPanel t={data.t} /> : <p className="py-3 text-muted">Enter a CIRCUIT contract account to watch its treasury.</p>}
          </section>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <section className={CARD} aria-labelledby="h-agents">
              <h2 id="h-agents" className={H2}>
                Agent hierarchy <span className="ml-1.5 text-xs font-normal tracking-normal text-muted normal-case">available / allocation · click for policy</span>
              </h2>
              <div className="my-2.5 flex flex-wrap gap-3.5 text-xs text-muted">
                <Swatch seg="spent" label="Spent" />
                <Swatch seg="reserved" label="Reserved" />
                <Swatch seg="delegated" label="Delegated" />
                <Swatch seg="free" label="Available" />
              </div>
              {data && <AgentTree agents={data.agents} open={open} onToggle={toggle} short={short} />}
            </section>
            <section className={CARD} aria-labelledby="h-res">
              <h2 id="h-res" className={H2}>
                Reservations <span className="ml-1.5 text-xs font-normal tracking-normal text-muted normal-case">newest first</span>
              </h2>
              {data && <ReservationsTable rs={data.rs} short={short} />}
            </section>
          </div>
          <p className="mt-2 text-xs text-muted">
            Read-only. Every number is read from the contract&apos;s view methods at final finality. The contract is the only authority; this
            page cannot move funds.
          </p>
        </section>

        <section hidden={tab !== "evidence"}>
          <section className={CARD}>
            <h2 className={H2}>Simulator evidence</h2>
            <p className="text-muted">
              Reports produced by <code className="font-mono">circuit-sim</code>. Each one lists every check and every transaction as the chain
              reported it.
            </p>
            <label className="mt-3 inline-flex items-center gap-2.5 text-[13px]">
              Load report JSON
              <input
                type="file"
                accept="application/json"
                multiple
                onChange={async (e) => {
                  const files = [...(e.target.files ?? [])];
                  setReports(await Promise.all(files.map(async (f) => JSON.parse(await f.text()) as Report)));
                }}
              />
            </label>
          </section>
          {reports.map((r, i) =>
            "error" in r ? (
              <p key={i} className="text-bad">{r.error}</p>
            ) : (
              <ReportCard key={i} r={r} networkName={cfg?.network ?? "testnet"} explorer={cfg?.explorer ?? null} short={short} onWatch={watch} />
            ),
          )}
        </section>
      </main>
    </div>
  );
}
