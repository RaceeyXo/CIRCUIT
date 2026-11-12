import Link from "next/link";

import { Nav } from "@/components/Nav";

// Exported as 404.html; GitHub Pages serves it for unknown paths.
export default function NotFound() {
  return (
    <>
      <Nav page="console" />
      <main className="mx-auto max-w-[640px] px-4 pt-32 text-center">
        <p className="font-mono text-sm text-muted">404</p>
        <h1 className="mt-3 text-[clamp(32px,5vw,52px)] leading-tight font-normal tracking-[-0.035em]">This page isn&apos;t on the ledger.</h1>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link className="btn" href="/">Back to overview</Link>
          <Link className="btn btn-ghost" href="/console/">Open the console</Link>
        </div>
      </main>
    </>
  );
}
