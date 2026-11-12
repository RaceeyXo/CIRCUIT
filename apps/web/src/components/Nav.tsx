"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg className="text-accent" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <path d="M3 16h8l3-8 4 16 3-8h8" stroke="currentColor" strokeWidth="2.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const REPO = "https://github.com/RaceeyXo/CIRCUIT";

/** Capsule navigation: full width at the top of the landing page, a floating pill once scrolled. */
export function Nav({ page }: { page: "landing" | "console" }) {
  const [floating, setFloating] = useState(page === "console");

  useEffect(() => {
    if (page === "console") return;
    const onScroll = () => setFloating(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [page]);

  const link = "no-underline hover:text-ink";
  return (
    <div className="pointer-events-none sticky top-4 z-50 flex justify-center px-4">
      <nav className={`nav ${floating ? "floating" : ""}`} aria-label="Main">
        <Link className="flex items-center gap-2.5 text-[15px] font-semibold tracking-[0.14em] no-underline" href="/">
          <Logo />
          CIRCUIT
        </Link>
        {page === "landing" ? (
          <>
            <div className="ml-auto hidden gap-[22px] text-[15px] text-ink-2 md:flex">
              <a className={link} href="#problem">Problem</a>
              <a className={link} href="#how">How it works</a>
              <a className={link} href="#attacks">Attacks</a>
              <a className={link} href="#evidence">Evidence</a>
              <a className={link} href={REPO} target="_blank" rel="noopener">GitHub</a>
            </div>
            <Link className="btn btn-sm ml-auto md:ml-0" href="/console/">
              Open console
            </Link>
          </>
        ) : (
          <div className="ml-auto flex gap-[22px] text-[15px] text-ink-2">
            <Link className={link} href="/">Overview</Link>
            <Link className={`${link} text-ink`} href="/console/" aria-current="page">Console</Link>
            <a className={link} href={REPO} target="_blank" rel="noopener">GitHub</a>
          </div>
        )}
      </nav>
    </div>
  );
}
