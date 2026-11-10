// Interprets a raw NEAR RPC transaction response (`FinalExecutionOutcome` JSON) without relying
// on library-specific error classes. This is what the simulator and the API record as evidence.

import type { CircuitEvent, RejectionCode } from "./types.js";
import { REJECTION_CODES } from "./types.js";

export interface TxOutcome<T = unknown> {
  ok: boolean;
  txHash: string;
  /** Block in which the transaction itself was included. */
  blockHash: string;
  /** Decoded return value of the transaction (the last receipt's SuccessValue), if any. */
  value?: T;
  /** Structured rejection, if the contract rejected the call. */
  rejection?: { code: RejectionCode | string; detail: string };
  /** Any other failure (e.g. a runtime/action error) as raw text. */
  error?: string;
  gasBurnt: bigint;
  logs: string[];
  events: CircuitEvent[];
}

interface RawOutcome {
  status?: unknown;
  transaction?: { hash?: string };
  transaction_outcome?: { id?: string; block_hash?: string; outcome?: { gas_burnt?: number | string; logs?: string[] } };
  receipts_outcome?: { outcome?: { gas_burnt?: number | string; logs?: string[] } }[];
}

const REJECTION_RE = /CIRCUIT:([A-Z_]+):([^"\\]*)/;

export function parseRejection(text: string): { code: RejectionCode | string; detail: string } | undefined {
  const m = REJECTION_RE.exec(text);
  if (!m) return undefined;
  const code = m[1]!;
  return { code: (REJECTION_CODES as readonly string[]).includes(code) ? (code as RejectionCode) : code, detail: m[2]! };
}

export function parseEvents(logs: string[]): CircuitEvent[] {
  const out: CircuitEvent[] = [];
  for (const line of logs) {
    if (!line.startsWith("EVENT_JSON:")) continue;
    try {
      const ev = JSON.parse(line.slice("EVENT_JSON:".length)) as CircuitEvent;
      if (ev.standard === "circuit") out.push(ev);
    } catch {
      // not ours / malformed: ignore
    }
  }
  return out;
}

export function interpretOutcome<T = unknown>(raw: unknown): TxOutcome<T> {
  const r = raw as RawOutcome;
  const status = r.status as Record<string, unknown> | undefined;
  const all = [r.transaction_outcome?.outcome, ...(r.receipts_outcome ?? []).map((x) => x.outcome)];
  const logs = all.flatMap((o) => o?.logs ?? []);
  const gasBurnt = all.reduce((sum, o) => sum + BigInt(o?.gas_burnt ?? 0), 0n);
  const base = {
    txHash: r.transaction?.hash ?? r.transaction_outcome?.id ?? "",
    blockHash: r.transaction_outcome?.block_hash ?? "",
    gasBurnt,
    logs,
    events: parseEvents(logs),
  };

  if (status && "SuccessValue" in status) {
    const b64 = String(status.SuccessValue ?? "");
    let value: T | undefined;
    if (b64.length > 0) {
      const text = Buffer.from(b64, "base64").toString("utf8");
      try {
        value = JSON.parse(text) as T;
      } catch {
        value = text as unknown as T;
      }
    }
    return { ok: true, value, ...base };
  }
  const failure = JSON.stringify(status?.Failure ?? status ?? raw);
  const rejection = parseRejection(failure);
  return rejection ? { ok: false, rejection, ...base } : { ok: false, error: failure, ...base };
}
