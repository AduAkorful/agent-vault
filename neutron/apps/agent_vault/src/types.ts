// Agent Vault — Wire Types & Interface Definitions
// Exact Candid representation of Motoko backend state and UI drafts.

import type { JsonValue } from "neutron-tools/app";

export interface Token {
  id: string;
  symbol: string;
  decimals: number;
  standard: string;
  fee: bigint;
}

export interface Balance {
  token: Token;
  amount: bigint;
  syncedAt: bigint;
}


export interface TokenLimits {
  maxPerTx: bigint;
  maxHourlySpend: bigint;
  maxDailySpend: bigint;
}

export interface TokenLimit {
  token: string;
  limits: TokenLimits;
}

export interface TimeWindow { start: number; end: number; days: number[] }

export interface Allowlists {
  recipients: string[];
  dexes: string[];
  pairs: { from: string; to: string }[];
  tokenRecipients: [string, string[]][];
}

export interface Policy {
  limits: TokenLimit[];
  allowlists: Allowlists;
  circuitBreaker: boolean;
  failureThreshold: bigint;
  consecutiveFailures: bigint;
  allowedHours: [string, TimeWindow][];
  approvalTimelock: bigint;
}

export interface PolicyProfile {
  id: bigint;
  name: string;
  revision: bigint;
  policy: Policy;
}

export interface PolicyEvaluation {
  profileId: bigint;
  profileName: string;
  revision: bigint;
  fee: bigint | null;
  hourlyBefore: bigint | null;
  dailyBefore: bigint | null;
  hourlyAfter: bigint | null;
  dailyAfter: bigint | null;
  tier: JsonValue;
  policyError: JsonValue;
}

export interface AuditEntry {
  id: bigint;
  action: JsonValue;
  tier: JsonValue;
  policyError: JsonValue;
  evaluation: PolicyEvaluation | null;
  settlement: JsonValue;
  timestamp: bigint;
  ticketId: JsonValue;
  note: string;
}

export interface Ticket {
  id: bigint;
  action: JsonValue;
  createdAt: bigint;
  policyError: JsonValue;
  evaluation: PolicyEvaluation | null;
  status: JsonValue;
  timelockUntil: bigint | null;
}

export interface TokenSpend {
  token: string;
  hourly: bigint;
  daily: bigint;
}

export interface VaultState {
  balances: Balance[];
  policies: PolicyProfile[];
  activePolicyId: bigint;
  policy: Policy;
  spend: TokenSpend[];
  pending: Ticket[];
  audit: AuditEntry[];
  settlementInFlight: boolean;
  settlementLock: { action: JsonValue; startedAt: bigint; profile: { id: bigint; name: string; revision: bigint } | null; stage: string | null } | null;
  dexConfig: JsonValue;
  depositAccount: { owner: string; subaccount: number[] };
  recipientLabels: [string, string][];
}

export interface TokenValuation {
  token: string;
  balance: bigint;
  usdValue: bigint;
  // Decimals of `usdValue`: the decimals of the anchor ledger the backend
  // quoted against (ckUSDC today). Read live via `icrc1_decimals` — never
  // hardcoded. `0` means the decimals could not be read; the dashboard
  // renders such rows as "price unavailable" rather than guessing.
  usdDecimals: number;
  // Decimals of the input token's `balance` so the dashboard can render
  // it in the same units the agent used to compute it.
  balanceDecimals: number;
}

export interface PolicyDraft {
  limits: { token: string; maxPerTx: string; maxHourlySpend: string; maxDailySpend: string }[];
  recipients: string;
  dexes: string;
  pairs: string;
  tokenRecipients: [string, string[]][];
  allowedHours: [string, TimeWindow][];
  failureThreshold: string;
  approvalTimelock: string;
}

export interface TileContext {
  instanceId?: string;
  tileType?: string;
  appTitle?: string;
  workspaceId?: string;
}
