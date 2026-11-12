import { formatNear } from "@circuit/shared/units";

export const big = (s: string) => BigInt(s);
export const near = (y: bigint | string, d = 3) => formatNear(y, d);
export const pct = (part: bigint, whole: bigint) => (whole === 0n ? 0 : Number((part * 100_000n) / whole) / 1000);

/** Shortens `name.<suffix shared with the contract>` ids so the tree stays readable. */
export function shortId(id: string, contractId: string): string {
  const suffix = contractId.includes(".") ? contractId.slice(contractId.indexOf(".")) : "";
  return suffix && id.endsWith(suffix) ? id.slice(0, -suffix.length) : id;
}

/** Relative time for a nanosecond timestamp ("in 5m", "2h ago"). */
export function relTime(ns: string, now = Date.now()): string {
  const s = Math.round((Number(big(ns) / 1_000_000n) - now) / 1000);
  const a = Math.abs(s);
  const t = a < 90 ? `${a}s` : a < 5400 ? `${Math.round(a / 60)}m` : `${Math.round(a / 3600)}h`;
  return s >= 0 ? `in ${t}` : `${t} ago`;
}

export const NETWORKS: Record<string, { rpc: string; explorer: string | null }> = {
  testnet: { rpc: "https://test.rpc.fastnear.com", explorer: "https://testnet.nearblocks.io/txns/" },
  mainnet: { rpc: "https://free.rpc.fastnear.com", explorer: "https://nearblocks.io/txns/" },
  local: { rpc: "http://localhost:3030", explorer: null },
};
