// Money is bigint yoctoNEAR end to end. No floating point is used for accounting; `formatNear`
// is for display only and works on bigint digits.

export const YOCTO_PER_NEAR = 10n ** 24n;

/** Parses a decimal NEAR string ("1.25") into yoctoNEAR without floating point. */
export function parseNear(near: string): bigint {
  const m = /^(\d+)(?:\.(\d{0,24}))?$/.exec(near.trim());
  if (!m) throw new Error(`invalid NEAR amount: ${near}`);
  const whole = BigInt(m[1]!);
  const frac = BigInt((m[2] ?? "").padEnd(24, "0"));
  return whole * YOCTO_PER_NEAR + frac;
}

/** Formats yoctoNEAR as a NEAR decimal string, truncated (not rounded) to `decimals`. */
export function formatNear(yocto: bigint | string, decimals = 4): string {
  const v = typeof yocto === "string" ? BigInt(yocto) : yocto;
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / YOCTO_PER_NEAR;
  const frac = (abs % YOCTO_PER_NEAR).toString().padStart(24, "0").slice(0, decimals);
  const s = decimals > 0 ? `${whole}.${frac}` : `${whole}`;
  return neg ? `-${s}` : s;
}

export function yocto(v: string | bigint): bigint {
  return typeof v === "bigint" ? v : BigInt(v);
}

export const TGAS = 10n ** 12n;
