// Every transaction the simulator sends is recorded exactly as the chain reported it. Reports
// contain only observed facts: tx hashes, blocks, gas, outcomes and rejection codes.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { formatNear, type TxOutcome } from "@circuit/shared";

export interface TxRecord {
  step: string;
  actor: string;
  method: string;
  ok: boolean;
  code?: string;
  error?: string;
  txHash: string;
  blockHash: string;
  gasBurnt: string;
  events: string[];
}

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

export class Evidence {
  readonly txs: TxRecord[] = [];
  readonly checks: Check[] = [];
  readonly metrics: Record<string, unknown> = {};
  readonly startedAt = new Date().toISOString();

  constructor(readonly scenario: string, readonly network: string, readonly contractId: string) {}

  record<T>(step: string, actor: string, method: string, out: TxOutcome<T>): TxOutcome<T> {
    this.txs.push({
      step,
      actor,
      method,
      ok: out.ok,
      code: out.rejection?.code,
      error: out.error?.slice(0, 500),
      txHash: out.txHash,
      blockHash: out.blockHash,
      gasBurnt: out.gasBurnt.toString(),
      events: out.events.map((e) => e.event),
    });
    return out;
  }

  check(name: string, pass: boolean, detail: string): boolean {
    this.checks.push({ name, pass, detail });
    console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
    return pass;
  }

  get passed(): boolean {
    return this.checks.length > 0 && this.checks.every((c) => c.pass);
  }

  async save(dir: string): Promise<string> {
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${this.scenario}-${this.startedAt.replace(/[:.]/g, "-")}.json`);
    const report = {
      scenario: this.scenario,
      network: this.network,
      contract: this.contractId,
      started_at: this.startedAt,
      finished_at: new Date().toISOString(),
      passed: this.passed,
      checks: this.checks,
      metrics: this.metrics,
      transactions: this.txs,
    };
    await writeFile(file, JSON.stringify(report, null, 2));
    return file;
  }
}

export const near = (y: bigint) => `${formatNear(y, 6)} NEAR`;
