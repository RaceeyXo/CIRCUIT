import Link from "next/link";

import { Logo, Nav } from "@/components/Nav";
import { REPO, attacks, caps, evidence, hero, proof, route, versus } from "@/content";

const h2Band = "mt-[22px] mb-[18px] text-[clamp(32px,4.4vw,52px)] leading-[1.08] font-normal tracking-[-0.035em]";
const h2Big = "mt-6 mb-[18px] text-[clamp(38px,6vw,72px)] leading-[1.06] font-normal tracking-[-0.04em]";
const band = "mx-auto grid max-w-[1220px] items-center gap-14 rounded-band bg-surface px-6 py-10 lg:px-[72px] lg:py-16";

export default function Landing() {
  return (
    <>
      <Nav page="landing" />
      <main className="overflow-x-clip px-4">
        <Hero />
        <Proof />
        <Problem />
        <HowItWorks />
        <Features />
        <Attacks />
        <Evidence />
        <section className="pt-40 pb-[120px] text-center">
          <h2 className={h2Big}>
            Give your agents a budget
            <br />
            they can&apos;t overspend.
          </h2>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link className="btn" href="/console/">Open the console</Link>
            <a className="btn btn-ghost" href={REPO} target="_blank" rel="noopener">Read the code</a>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}

function Hero() {
  return (
    <section className="pt-[72px] text-center">
      <h1 className="mx-auto flex flex-col items-center gap-2 text-[clamp(38px,7vw,76px)] leading-[1.08] font-medium tracking-[-0.035em]">
        {hero.lines.map((line, i) => (
          <span key={line} className={`rounded-lg px-5 pt-0.5 pb-2 ${i === hero.accentLine ? "bg-accent text-accent-ink" : "bg-surface"}`}>
            {line}
          </span>
        ))}
      </h1>
      <p className="mx-auto mt-7 max-w-[640px] text-[clamp(16px,2vw,19px)] leading-relaxed text-ink-2">
        {hero.lede[0]}
        <br />
        {hero.lede[1]}
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link className="btn" href="/console/">Open the console</Link>
        <a className="btn btn-ghost" href="#evidence">See the evidence</a>
      </div>

      <div className="relative mx-auto mt-16 grid max-w-[1060px] gap-2.5 lg:block lg:h-[470px]" aria-label="Example: three agents share a 1 NEAR budget">
        <div className="relative mx-auto flex h-[420px] w-full max-w-[540px] justify-center overflow-hidden rounded-card bg-accent pt-14 lg:absolute lg:left-1/2 lg:h-full lg:-translate-x-1/2">
          <TreasuryCard />
        </div>
        {hero.chips.map((c) => (
          <div key={c.title} className={`chip mx-auto w-full max-w-[420px] lg:absolute lg:mx-0 lg:w-auto ${c.pos}`} style={{ animationDelay: c.delay }}>
            <span className={c.ok ? "dot-ok" : "dot-bad"} />
            <div>
              <b className="block text-[15px] font-semibold">{c.title}</b>
              <small className="font-mono text-xs text-muted">{c.sub}</small>
            </div>
            <span className={`ml-2.5 font-mono font-semibold ${c.ok ? "text-accent" : "text-muted"}`}>{c.amount}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function TreasuryCard() {
  const c = hero.card;
  return (
    <div className="w-[min(400px,88%)] rounded-t-[22px] border border-[#2a2a2a] bg-well px-[22px] pt-[22px] text-left shadow-[0_30px_80px_rgb(0_0_0/0.35)]">
      <div className="flex items-center justify-between text-xs">
        <span className="font-mono text-muted">circuit · treasury</span>
        <span className="inline-flex items-center gap-1.5 font-mono text-xs font-medium text-ok">
          <i className="size-[7px] animate-pulse-dot rounded-full bg-ok" />
          final
        </span>
      </div>
      <div className="mt-5 text-[13px] text-muted">Budget remaining</div>
      <div className="font-mono text-[40px] font-semibold tracking-[-0.03em] tabular-nums">
        {c.remaining} <small className="text-[15px] font-medium text-muted">NEAR</small>
      </div>
      <div className="mt-2.5 h-2 overflow-hidden rounded bg-free" aria-hidden="true">
        <span className="block h-full bg-spent" style={{ width: `${c.spentPct}%` }} />
      </div>
      <div className="mt-2 flex gap-4 font-mono text-xs text-muted">
        <span><i className="sw size-2 bg-spent" />spent {c.spent}</span>
        <span><i className="sw size-2 bg-free ring-1 ring-dash ring-inset" />of {c.budget}</span>
      </div>
      <div className="mt-5 text-[13px] text-muted">Concurrent requests</div>
      <ul className="mt-2.5 grid gap-2">
        {c.rows.map((r) => (
          <li key={r.who} className="grid grid-cols-[1fr_auto_auto] items-center gap-2.5 rounded-[10px] bg-surface px-3 py-[11px] text-[13px]">
            <span className="font-mono">{r.who}</span>
            <span className={`pill ${r.ok ? "text-ok" : "text-bad"}`}>{r.status}</span>
            <b className={`font-mono font-medium ${r.ok ? "" : "text-muted line-through"}`}>{r.amount}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Proof() {
  const items = [...proof, ...proof];
  return (
    <section className="pt-[120px] text-center" aria-label="What is verified">
      <p className="mb-7 text-[15px] tracking-[0.12em] text-ink-2 uppercase">Verified on every push</p>
      <div className="overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_12%,#000_88%,transparent)]">
        <div className="flex w-max animate-marquee gap-14 font-mono text-[clamp(18px,2.4vw,26px)] font-medium tracking-[-0.02em] whitespace-nowrap text-[#8d8a84]">
          {items.map((p, i) => (
            <span key={i} aria-hidden={i >= proof.length} className="before:mr-4 before:align-[0.25em] before:text-[0.55em] before:text-accent before:content-['◆']">
              {p}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function Problem() {
  return (
    <section id="problem" className={`${band} mt-[120px] scroll-mt-24 lg:grid-cols-[1fr_1.1fr]`}>
      <div>
        <span className="label">The problem</span>
        <h2 className={h2Band}>Shared budgets break when agents act at once</h2>
        <p className="text-lg leading-relaxed text-ink-2">
          Each agent checks the balance, sees room, and pays. Run them concurrently and they all see the same balance. Delegation
          makes it worse: sub-agents hand out more than they got, revoked agents keep paying, spend is split to dodge vendor caps.
        </p>
      </div>
      <div className="grid gap-[26px] rounded-card border border-dashed border-dash bg-well p-7">
        <p className="font-mono text-[13px] text-muted">{versus.caption}</p>
        {versus.rows.map((r) => (
          <div key={r.name}>
            <div className="mb-2.5 flex justify-between font-semibold">
              <span>{r.name}</span>
              <span className={`font-mono ${r.over ? "text-bad" : "text-ok"}`}>{r.paid} paid</span>
            </div>
            <div className="relative h-3.5 rounded-[7px] bg-free">
              <span
                className={`absolute inset-y-0 left-0 rounded-[7px] ${r.over ? "" : "bg-ok"}`}
                style={{
                  width: `${r.fillPct}%`,
                  background: r.over
                    ? `linear-gradient(90deg, var(--color-spent) 0 ${versus.budgetPct}%, var(--color-bad) ${versus.budgetPct}%)`
                    : undefined,
                }}
              />
              <span
                className="absolute -inset-y-1.5 w-0.5 bg-ink after:absolute after:-top-[18px] after:-left-[18px] after:font-mono after:text-[11px] after:text-muted after:content-['budget']"
                style={{ left: `${versus.budgetPct}%` }}
              />
            </div>
            <small className="mt-2.5 block text-sm text-muted">
              {r.note} {r.emphasis && <b className="text-bad">{r.emphasis}</b>}
            </small>
          </div>
        ))}
        <p className="font-mono text-xs text-muted">{versus.source}</p>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <>
      <section id="how" className="mx-auto max-w-[900px] scroll-mt-24 pt-[140px] text-center">
        <span className="label">How it works</span>
        <h2 className={h2Big}>
          Agents reserve.
          <br />
          The contract decides.
        </h2>
        <p className="mx-auto max-w-[640px] text-[19px] leading-relaxed text-ink-2">
          Every request is checked against the agent&apos;s budget and every ancestor&apos;s policy in one atomic step. Payouts only
          settle through the contract&apos;s own callback.
        </p>
      </section>
      <section className={`${band} mt-14 gap-10 lg:grid-cols-[1fr_auto_1fr]`}>
        <div className="grid gap-2.5">
          <p className="mb-1 text-sm text-ink-2">Requests in</p>
          {route.requests.map((r, i) => (
            <div key={i} className="row-d">
              <span className="font-mono">{r.who}</span>
              <span className="font-mono text-muted">{r.what}</span>
              {r.tag && <span className="font-mono text-[11px] text-accent">{r.tag}</span>}
            </div>
          ))}
        </div>
        <div className="flex rotate-90 items-center justify-center text-accent lg:rotate-0" aria-hidden="true">
          <span className="block h-px w-11 bg-dash" />
          <Logo size={64} />
          <span className="block h-px w-11 bg-dash" />
        </div>
        <div className="grid gap-2.5">
          <p className="mb-1 text-sm text-ink-2">Decisions out</p>
          {route.decisions.map((d) => (
            <div key={d.code} className="row-d">
              <span className={`pill ${d.ok === null ? "text-muted" : d.ok ? "text-ok" : "text-bad"}`}>{d.code}</span>
              {d.note && <span className="font-mono text-muted">{d.note}</span>}
            </div>
          ))}
          <p className="mt-1.5 text-[13px] text-muted">32 structured rejection codes. A rejected call leaves no state.</p>
        </div>
      </section>
    </>
  );
}

function Node({ name, value, wide = true, off = false }: { name: string; value: string; wide?: boolean; off?: boolean }) {
  return (
    <div
      className={`flex justify-between gap-[18px] rounded-xl border border-dashed border-dash bg-surface-2 px-3.5 py-2.5 ${wide ? "min-w-[150px]" : "min-w-24"} ${off ? "line-through opacity-50" : ""}`}
    >
      <span>{name}</span>
      <b className={`font-medium ${off ? "text-bad" : "text-accent"}`}>{value}</b>
    </div>
  );
}

function Features() {
  return (
    <section className="mx-auto mt-6 grid max-w-[1220px] gap-6 lg:grid-cols-2">
      <article className="rounded-band bg-surface p-8">
        <div className="flex min-h-[260px] flex-col items-center justify-center gap-3.5 rounded-card bg-well p-7 font-mono text-sm" aria-hidden="true">
          <Node name="treasury" value="10.0" />
          <div className="flex gap-3.5"><Node name="root" value="6.0" /><Node name="ops" value="4.0" /></div>
          <div className="flex gap-3.5"><Node name="a" value="1.0" wide={false} /><Node name="b" value="1.0" wide={false} /><Node name="c" value="revoked" wide={false} off /></div>
        </div>
        <h3 className="mt-7 mb-2.5 text-3xl font-medium tracking-[-0.03em]">Budgets that nest</h3>
        <p className="text-[17px] leading-relaxed text-ink-2">
          Delegation carves budget out of the parent, so nothing is counted twice. Up to four levels; a parent&apos;s limits bind its
          whole branch.
        </p>
      </article>
      <article className="rounded-band bg-surface p-8">
        <div className="flex min-h-[260px] flex-col justify-center gap-3.5 rounded-card bg-accent p-7" aria-hidden="true">
          {caps.map((c) => (
            <div key={c.label} className="flex justify-between gap-3 rounded-xl bg-black/85 px-4 py-3 text-[15px]">
              <span>{c.label}</span>
              <b className="font-mono font-medium text-accent">{c.value}</b>
            </div>
          ))}
        </div>
        <h3 className="mt-7 mb-2.5 text-3xl font-medium tracking-[-0.03em]">Limits that can&apos;t be split around</h3>
        <p className="text-[17px] leading-relaxed text-ink-2">
          Counterparty exposure is tracked for every ancestor, so spreading payments across children never gets past a branch cap.
        </p>
      </article>
    </section>
  );
}

function Attacks() {
  return (
    <>
      <section id="attacks" className="mx-auto max-w-[900px] scroll-mt-24 pt-[140px] text-center">
        <span className="label">Under attack</span>
        <h2 className={h2Big}>We tried to break it</h2>
        <p className="mx-auto max-w-[640px] text-[19px] leading-relaxed text-ink-2">
          Each attack runs as real signed transactions against the contract on a NEAR node. These are the outcomes the chain returned.
        </p>
      </section>
      <section className="mx-auto mt-14 grid max-w-[1220px] gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        {attacks.map((a) => (
          <div key={a.title} className="flex min-h-[150px] flex-col justify-between gap-[18px] rounded-[18px] border border-dashed border-dash bg-surface p-[22px]">
            <b className="text-lg leading-snug font-medium">{a.title}</b>
            <span className={`pill self-start ${a.ok ? "text-ok" : "text-bad"}`}>{a.result}</span>
          </div>
        ))}
      </section>
    </>
  );
}

function Evidence() {
  return (
    <section id="evidence" className={`${band} mt-[120px] scroll-mt-24 lg:grid-cols-[1fr_1.1fr]`}>
      <div>
        <span className="label">Evidence</span>
        <h2 className={h2Band}>Numbers from real runs, not estimates</h2>
        <p className="mb-[26px] text-lg leading-relaxed text-ink-2">
          Ten agents fire 24 requests at once on NEAR testnet, against a treasury they over-subscribe. Every transaction hash is
          committed to the repository.
        </p>
        <a className="btn" href={`${REPO}/tree/main/evidence/testnet`} target="_blank" rel="noopener">Browse testnet evidence</a>
      </div>
      <dl className="grid grid-cols-2 gap-3">
        {evidence.map((e) => (
          <div key={e.k} className="rounded-2xl border border-dashed border-dash bg-well px-5 py-[18px]">
            <dt className="text-[13px] text-muted">{e.k}</dt>
            <dd className={`mt-1 mb-0.5 font-mono text-[34px] font-semibold tracking-[-0.03em] ${e.good ? "text-ok" : ""}`}>{e.v}</dd>
            <small className="text-[13px] text-muted">{e.note}</small>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Footer() {
  const link = "text-ink-2";
  return (
    <footer className="mx-auto flex max-w-[1220px] flex-wrap items-center justify-between gap-x-7 gap-y-4 border-t border-line px-4 pt-7 pb-12 text-sm">
      <span className="flex items-center gap-2.5 font-semibold tracking-[0.14em]"><Logo size={20} />CIRCUIT</span>
      <span className="text-muted">Built on NEAR · Testnet only · Not audited</span>
      <span className="text-muted">
        <a className={link} href={`${REPO}/blob/main/docs/architecture.md`}>Architecture</a> ·{" "}
        <a className={link} href={`${REPO}/blob/main/docs/threat-model.md`}>Threat model</a> ·{" "}
        <a className={link} href={`${REPO}/blob/main/docs/benchmarks.md`}>Benchmarks</a>
      </span>
    </footer>
  );
}
