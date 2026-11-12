// Minimal read-only NEAR RPC client for the browser: view calls only. The dashboard holds no keys
// and cannot submit transactions.

import type { AgentView, ReservationView, TreasuryView } from "@circuit/shared/types";

export class ViewClient {
  constructor(readonly rpcUrl: string, readonly contractId: string) {}

  async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "circuit",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: this.contractId,
          method_name: method,
          args_base64: btoa(JSON.stringify(args)),
        },
      }),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const body = (await res.json()) as { result?: { result?: number[]; error?: string }; error?: { message?: string; data?: unknown } };
    if (body.error) throw new Error(`RPC: ${body.error.message ?? "error"} ${JSON.stringify(body.error.data ?? "")}`);
    if (body.result?.error) throw new Error(`view ${method}: ${body.result.error}`);
    const bytes = new Uint8Array(body.result?.result ?? []);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }

  treasury() {
    return this.view<TreasuryView>("get_treasury");
  }

  async agents(): Promise<AgentView[]> {
    const out: AgentView[] = [];
    for (let from = 0; ; from += 100) {
      const page = await this.view<AgentView[]>("get_agents", { from_index: from, limit: 100 });
      out.push(...page);
      if (page.length < 100) return out;
    }
  }

  /** The most recent `max` reservations (ids are dense and ascending). */
  async recentReservations(count: number, max = 200): Promise<ReservationView[]> {
    const start = Math.max(0, count - max);
    const out: ReservationView[] = [];
    for (let from = start; from < count; from += 100) {
      out.push(...(await this.view<ReservationView[]>("get_reservations", { from_id: String(from), limit: 100 })));
    }
    return out.reverse();
  }
}
