// Mirrors of the contract's JSON views. All amounts are yoctoNEAR decimal strings on the wire;
// use `units.ts` to convert to bigint. Never parse them as JS numbers.

export type Yocto = string;

export interface PolicyJson {
  max_tx_amount: Yocto;
  max_pending_amount: Yocto;
  max_pending_count: number;
  max_counterparty_exposure: Yocto;
  max_delegated: Yocto;
  max_reservation_ttl_ns: string;
}

export interface TreasuryView {
  owner: string;
  total_budget: Yocto;
  allocated: Yocto;
  unallocated: Yocto;
  total_spent: Yocto;
  total_reserved: Yocto;
  in_flight: Yocto;
  remaining: Yocto;
  paused: boolean;
  agent_count: number;
  reservation_count: number;
}

export type AgentStatus = "Active" | "Revoked";

export interface AgentView {
  id: string;
  parent: string | null;
  depth: number;
  allocation: Yocto;
  spent: Yocto;
  reserved: Yocto;
  delegated: Yocto;
  available: Yocto;
  pending_count: number;
  status: AgentStatus;
  policy: PolicyJson;
  created_at: string;
  revoked_at: string | null;
}

export type ReservationStatus = "Reserved" | "Executing" | "Settled" | "Released";
export type ReleaseReason = "Agent" | "Ancestor" | "Owner" | "Expired";

export interface ReservationView {
  id: string;
  request_id: string;
  agent: string;
  counterparty: string;
  amount: Yocto;
  created_at: string;
  expires_at: string;
  status: ReservationStatus;
  closed_at: string | null;
  release_reason: ReleaseReason | null;
  failed_attempts: number;
}

export interface ReserveResult {
  reservation: ReservationView;
  duplicate: boolean;
}

/** Rejection codes emitted by the contract as `CIRCUIT:<CODE>:<detail>`. */
export const REJECTION_CODES = [
  "NOT_OWNER", "UNAUTHORIZED", "PAUSED", "AGENT_NOT_FOUND", "AGENT_EXISTS", "INVALID_AGENT_ID",
  "AGENT_REVOKED", "ANCESTOR_REVOKED", "ALREADY_REVOKED", "DEPTH_EXCEEDED", "INVALID_POLICY",
  "POLICY_EXCEEDS_PARENT", "DELEGATION_LIMIT", "INSUFFICIENT_BUDGET", "EXCEEDS_UNALLOCATED",
  "ZERO_AMOUNT", "EXCEEDS_TX_LIMIT", "PENDING_AMOUNT_LIMIT", "PENDING_COUNT_LIMIT",
  "COUNTERPARTY_LIMIT", "INVALID_TTL", "INVALID_COUNTERPARTY", "INVALID_REQUEST_ID",
  "REQUEST_ID_CONFLICT", "RESERVATION_NOT_FOUND", "INVALID_TRANSITION", "RESERVATION_EXPIRED",
  "INSUFFICIENT_GAS", "BATCH_TOO_LARGE", "INSUFFICIENT_STORAGE_DEPOSIT", "CUSTODY_VIOLATION",
  "ARITHMETIC_OVERFLOW",
] as const;
export type RejectionCode = (typeof REJECTION_CODES)[number];

/** A NEP-297 event emitted by the contract (`EVENT_JSON:` log line). */
export interface CircuitEvent {
  standard: "circuit";
  version: string;
  event: string;
  data: Record<string, unknown>[];
}
