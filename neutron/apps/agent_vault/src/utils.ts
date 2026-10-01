// Agent Vault — Formatting, conversion, and decoding utilities.

import type { JsonValue } from "neutron-tools/app";
import type { Policy, PolicyDraft, AuditEntry, Balance } from "./types";

export function toBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new RangeError("toBigInt: expected a non-negative safe integer");
    }
    return BigInt(v);
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!/^[0-9]+$/.test(s)) {
      throw new TypeError(`toBigInt: invalid natural-number string: ${v}`);
    }
    return BigInt(s);
  }
  throw new TypeError(`toBigInt: unsupported value type: ${typeof v}`);
}

// Thrown when a token-derived value (amount, fee, etc.) is asked to be
// formatted with a decimals value the dashboard does not know. Decimals must
// always come from a synced Balance (or the backend's TokenValuation fields);
// there is no fallback table.
export class MissingDecimalsError extends Error {
  constructor(token: string, field: string) {
    super(`Missing decimals for ${token} (${field})`);
    this.name = "MissingDecimalsError";
  }
}

// Format a token amount using its decimals. Throws MissingDecimalsError if
// decimals is null/undefined/<0 — the caller must resolve decimals from a
// synced Balance first. This intentionally has no "—" fallback: a missing
// decimals is a programming error or a UI input boundary, and the caller
// decides how to surface it (e.g. block the input, render a disabled row).
export function formatAmount(value: unknown, decimals: number | null | undefined, token?: string, field?: string): string {
  const bi = toBigInt(value);
  if (decimals === null || decimals === undefined) {
    throw new MissingDecimalsError(token ?? "<unknown>", field ?? "amount");
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new RangeError(`formatAmount: invalid decimals ${decimals}`);
  }
  if (decimals === 0) return bi.toString();
  const divisor = 10n ** BigInt(decimals);
  const integerPart = bi / divisor;
  const fractionPart = bi % divisor;
  if (fractionPart === 0n) return integerPart.toString();
  const fracStr = fractionPart.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${integerPart}.${fracStr}`;
}

// Format a ledger pointer that has no token-decimals interpretation: block
// indices, approval block indices, transaction ids, and similar opaque
// values. Returns the bigint as a decimal string — same as `toBigInt` followed
// by `.toString()`. Kept as a named function so call sites are explicit about
// the intent (no decimals, no formatting).
export function formatBaseUnit(value: unknown): string {
  return toBigInt(value).toString();
}

export function toPrincipalText(v: unknown): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    if ("toText" in v && typeof (v as any).toText === "function") {
      return (v as any).toText();
    }
    if ("__principal__" in v && typeof (v as any).__principal__ === "string") {
      return (v as any).__principal__;
    }
    if ("_isPrincipal" in v && typeof (v as any).toText === "function") {
      return (v as any).toText();
    }
  }
  return String(v);
}

export function shortenPrincipal(p: string): string {
  if (!p || p.length <= 16) return p || "—";
  return `${p.slice(0, 7)}…${p.slice(-5)}`;
}

export function bytesToHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function formatRelativeTime(nanos: bigint): string {
  if (nanos === 0n) return "—";
  const ms = Number(nanos / 1_000_000n);
  const now = Date.now();
  const diffSec = Math.floor((now - ms) / 1000);
  if (diffSec < 0) return "Just now";
  if (diffSec < 10) return "Just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || "Unknown error occurred");
}

export function unwrapOk<T>(result: unknown): T {
  if (Array.isArray(result) && result.length === 1) {
    return unwrapOk<T>(result[0]);
  }
  if (typeof result === "object" && result !== null) {
    const rec = result as Record<string, unknown>;
    if ("ok" in rec) return rec.ok as T;
    if ("err" in rec) throw new Error(extractErrorMessage(rec.err));
    if ("Ok" in rec) return rec.Ok as T;
    if ("Err" in rec) throw new Error(extractErrorMessage(rec.Err));
    return result as T;
  }
  throw new Error(`malformed result envelope: ${JSON.stringify(result)}`);
}

export function safeUnwrap<T>(result: unknown): T | null {
  try {
    return unwrapOk<T>(result);
  } catch {
    return null;
  }
}

export function extractErrorMessage(err: unknown, depth: number = 0): string {
  if (depth > 20) return JSON.stringify(err);
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const rec = err as Record<string, unknown>;
    if ("message" in rec && typeof rec.message === "string") return rec.message;
    for (const value of Object.values(rec)) {
      if (typeof value === "object" && value !== null) {
        const msg = extractErrorMessage(value, depth + 1);
        if (msg) return msg;
      }
    }
  }
  return JSON.stringify(err);
}

export function getTier(tier: JsonValue): "autonomous" | "escalation" | "forbidden" | "unknown" {
  if (typeof tier === "object" && tier !== null) {
    const key = Object.keys(tier)[0];
    if (key === "Autonomous") return "autonomous";
    if (key === "Escalation") return "escalation";
    if (key === "Forbidden") return "forbidden";
  }
  return "unknown";
}

export function isSettlementSuccess(settlement: JsonValue): boolean {
  if (typeof settlement === "object" && settlement !== null) {
    const key = Object.keys(settlement)[0];
    return key === "success";
  }
  return false;
}

// Resolve a token's decimals from a synced Balance. There is no fallback
// table — decimals are read live from the ledger and live on the Balance
// record that `syncBalance`/`syncAllBalances` populates. If the token has
// not been synced, this returns `null` and the caller must block the input
// or render an honest "sync required" state.
export function getTokenDecimals(tokenPrincipal: string, balances: Balance[] = []): number | null {
  if (!tokenPrincipal) return null;
  const norm = tokenPrincipal.toLowerCase().trim();
  const found = balances.find((b) => toPrincipalText(b.token.id).toLowerCase() === norm);
  if (found) return found.token.decimals;
  return null;
}

export interface ActionDetails {
  type: "transfer" | "swap" | "unknown";
  summary: string;
  amount: string;
  actionLabel?: string | undefined;
  token?: string | undefined;
  recipient?: string | undefined;
  fromToken?: string | undefined;
  toToken?: string | undefined;
  dex?: string | undefined;
  minReturn?: string | undefined;
  slippageBps?: string | undefined;
  slippagePercent?: string | undefined;
  reason?: string | undefined;
}

export function formatVaultError(error: JsonValue): string {
  if (!error) return "Requires Approval";
  if (Array.isArray(error)) return error.length === 0 ? "Requires Approval" : formatVaultError(error[0] as JsonValue);
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const keys = Object.keys(error);
    if (keys.length > 0 && keys[0] !== undefined) {
      const key = keys[0];
      switch (key) {
        case "SwapRequiresApproval":
          return "Mandatory DEX Swap Approval";
        case "TooManyPendingTickets":
          return "Pending Approval Cap Reached";
        case "OutsideAllowedHours":
          return "Outside Allowed Time Window";
        case "TimelockInProgress":
          return "Approval Timelock In Progress";
        case "RecipientNotAllowed":
          return "Recipient Not in Allowlist";
        case "TokenLimitNotConfigured":
          return "Token Budget Not Configured";
        case "PerTransactionLimit":
          return "Per-Transaction Limit Exceeded";
        case "HourlyLimit":
          return "Hourly Velocity Limit Exceeded";
        case "DailyLimit":
          return "Daily Velocity Limit Exceeded";
        case "CircuitBreakerActive":
          return "Circuit Breaker Active";
        case "DexNotAllowed":
          return "DEX Canister Not Allowed";
        case "TokenPairNotAllowed":
          return "Token Pair Not Allowed";
        case "InsufficientBalance":
          return "Insufficient Vault Balance";
        case "QuoteExpired":
          return "DEX Quote Expired";
        case "InvalidSlippage":
          return "Invalid Slippage Parameter";
        case "InvalidAmount":
          return "Invalid Transfer Amount";
        case "AlreadyResolved":
          return "Ticket Already Resolved";
        case "InvalidPolicyName":
          return "Invalid Policy Profile Name";
        case "PolicyProfileNotFound":
          return "Policy Profile Not Found";
        case "PolicyProfileNotActive":
          return "Policy Profile Is No Longer Active";
        case "PolicyRevisionChanged":
          return "Policy Profile Changed Since Proposal";
        case "ActivePolicyDeletion":
          return "Cannot Delete Active Policy Profile";
        case "TicketNotFound":
          return "Ticket Not Found";
        case "ExternalFailure": {
          const val = (error as Record<string, JsonValue>)[key] as Record<string, JsonValue> | undefined;
          return val?.message ? String(val.message) : "External Ledger Failure";
        }
        default:
          return key.replace(/([A-Z])/g, " $1").trim();
      }
    }
  }
  return "Policy Escalation";
}

export function getErrorGuidance(error: JsonValue): string | null {
  if (!error) return null;
  if (Array.isArray(error)) return error.length === 0 ? null : getErrorGuidance(error[0] as JsonValue);
  if (typeof error === "object" && error !== null) {
    const key = Object.keys(error)[0];
    switch (key) {
      case "RecipientNotAllowed":
        return "Add the recipient to the allowlist in Policy → Recipients, or approve this ticket for one-time authorization.";
      case "TokenLimitNotConfigured":
        return "Configure velocity limits for this token in Policy → Token Budgets.";
      case "PerTransactionLimit":
        return "Reduce the amount to stay within the per-transaction limit, or get owner approval.";
      case "HourlyLimit":
        return "Wait for the hourly window to roll over, split the transfer, or get owner approval.";
      case "DailyLimit":
        return "Wait for the daily window to reset, or get owner approval.";
      case "InsufficientBalance":
        return "Fund the vault deposit account: deposit to owner + subaccount shown in the portfolio.";
      case "CircuitBreakerActive":
        return "The circuit breaker is tripped. Owner must reset it in the Command Center.";
      case "TooManyPendingTickets":
        return "Pending approval cap (1,000) reached. Owner must approve or reject existing tickets first.";
      case "OutsideAllowedHours":
        return "This recipient has time-based restrictions. Transfer is allowed only during configured UTC hours and otherwise escalates.";
      case "TimelockInProgress":
        return "The owner approved this ticket but the approval timelock has not yet expired. Wait or cancel via the approvals inbox.";
      case "SettlementInFlight":
        return "A settlement is already in progress. Wait for it to complete.";
      case "ExternalFailure": {
        const val = (error as Record<string, JsonValue>)[key] as Record<string, JsonValue>;
        if (val?.partial === true) return "Ledger response was lost. Wait 5 minutes, then owner clicks 'Recover Lock' in the Command Center.";
        return "Ledger call failed. Sync the token balance and retry.";
      }
      case "SwapRequiresApproval":
        return "Swaps always require owner approval. Review in the approvals inbox.";
      case "InvalidAmount":
        return "The amount must be a positive integer in base units.";
      case "InvalidPolicy":
        return "Policy validation failed. Check that all limits are positive, per-tx ≤ hourly ≤ daily, and the failure threshold is positive.";
      case "TokenPairNotAllowed":
        return "This token pair is not in the DEX allowlist. Add it in Policy → Approved counterparties.";
      case "DexNotAllowed":
        return "Only the ICPSwap factory is permitted. This DEX canister is not allowlisted.";
      case "SettlementLockNotStale":
        return "The settlement lock is not yet stale (5-minute recovery window). Wait before retrying recovery.";
      case "UnsupportedTokenStandard":
        return "The token ledger does not implement the required ICRC-1/ICRC-2 interface.";
      case "InvalidPolicyName":
        return "Profile name must be 1–64 characters and unique.";
      case "PolicyProfileNotFound":
        return "The active policy profile was deleted or is unavailable.";
      case "PolicyProfileNotActive":
        return "The policy profile that created this ticket is no longer active.";
      case "PolicyRevisionChanged":
        return "The policy profile was modified since this ticket was created. Re-propose or approve the original.";
      case "ActivePolicyDeletion":
        return "Cannot delete the active policy profile. Switch to another profile first.";
      case "AlreadyResolved":
        return "This ticket has already been approved or rejected.";
      case "TicketNotFound":
        return "The ticket no longer exists.";
      case "InvalidSlippage":
        return "Slippage tolerance must be between 0 and 10,000 bps.";
      case "InvalidQuote":
        return "The DEX quote is invalid. Sync balances and retry.";
      case "QuoteExpired":
        return "The DEX quote has expired. The owner must create a new swap proposal.";
      default:
        return null;
    }
  }
  return null;
}

// Format a token amount when decimals may be missing. If the token has not
// been synced, return the raw base-unit string with a ` (unsynced)` marker so
// the operator can see why no formatting was applied — never an em-dash, which
// would hide a real value. Throws are caught and rendered as a placeholder
// with the error name.
export function formatAmountSafe(value: unknown, decimals: number | null | undefined, token?: string, field?: string): string {
  if (decimals === null || decimals === undefined) {
    try {
      return `${toBigInt(value).toString()} (sync ${token ?? "token"})`;
    } catch {
      return "unreadable";
    }
  }
  try {
    return formatAmount(value, decimals, token, field);
  } catch (error) {
    if (error instanceof MissingDecimalsError) return `sync ${token ?? "token"}`;
    throw error;
  }
}

export function parseActionDetails(action: JsonValue, balances: Balance[] = [], labels: [string, string][] = []): ActionDetails {
  const tokenSymbols = new Map(balances.map((b) => [toPrincipalText(b.token.id), b.token.symbol]));

  if (typeof action === "object" && action !== null) {
    const rec = action as Record<string, JsonValue>;
    if ("transfer" in rec && typeof rec.transfer === "object" && rec.transfer !== null) {
      const t = rec.transfer as Record<string, JsonValue>;
      const token = toPrincipalText(t.token ?? "");
      const recipient = toPrincipalText(t.recipient ?? t.to ?? "");
      const rawAmount = String(t.amount ?? "");
      const reason = t.reason ? String(t.reason) : undefined;
      const decimals = getTokenDecimals(token, balances);
      const amount = formatAmountSafe(rawAmount, decimals, token, "transfer.amount");
      const tokenLabel = tokenSymbols.get(token) || getPrincipalLabel(token) || shortenPrincipal(token);
      const recipientLabel = resolveRecipientLabel(recipient, labels) || getPrincipalLabel(recipient) || shortenPrincipal(recipient);

      return {
        type: "transfer",
        summary: `Transfer ${amount} ${tokenLabel} ➔ ${recipientLabel}`,
        actionLabel: `ICRC transfer for ${tokenLabel}`,
        amount,
        token,
        recipient,
        reason,
      };
    }

    if ("swap" in rec && typeof rec.swap === "object" && rec.swap !== null) {
      const s = rec.swap as Record<string, JsonValue>;
      const fromToken = toPrincipalText(s.fromToken ?? s.tokenIn ?? "");
      const toToken = toPrincipalText(s.toToken ?? s.tokenOut ?? "");
      const dex = toPrincipalText(s.dex ?? "");
      const rawAmount = String(s.amount ?? s.amountIn ?? "");
      const rawMinReturn = String(s.minReturn ?? s.minAmountOut ?? "");
      const slippageBps = String(s.slippageBps ?? "");
      const reason = s.reason ? String(s.reason) : undefined;

      const fromDecimals = getTokenDecimals(fromToken, balances);
      const toDecimals = getTokenDecimals(toToken, balances);
      const amount = formatAmountSafe(rawAmount, fromDecimals, fromToken, "swap.amount");
      const minReturn = formatAmountSafe(rawMinReturn, toDecimals, toToken, "swap.minReturn");

      const fromLabel = tokenSymbols.get(fromToken) || getPrincipalLabel(fromToken) || shortenPrincipal(fromToken);
      const toLabel = tokenSymbols.get(toToken) || getPrincipalLabel(toToken) || shortenPrincipal(toToken);
      const slippagePercent = slippageBps ? `${(Number(slippageBps) / 100).toFixed(2)}%` : undefined;

      return {
        type: "swap",
        summary: `Swap ${amount} ${fromLabel} ➔ min ${minReturn} ${toLabel}`,
        actionLabel: `Token swap (${fromLabel} ➔ ${toLabel})`,
        amount,
        fromToken,
        toToken,
        dex,
        minReturn,
        slippageBps,
        slippagePercent,
        reason,
      };
    }
  }

  return {
    type: "unknown",
    summary: typeof action === "string" ? action : JSON.stringify(action),
    amount: "unreadable",
  };
}

export function describeAction(action: JsonValue, balances: Balance[] = [], labels: [string, string][] = []): string {
  const details = parseActionDetails(action, balances, labels);
  return details.summary;
}

export function isTransferAction(action: JsonValue): boolean {
  return (
    typeof action === "object" &&
    action !== null &&
    "transfer" in (action as Record<string, unknown>)
  );
}

export function parseLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function parsePairs(raw: string): { from: string; to: string }[] {
  const result: { from: string; to: string }[] = [];
  for (const line of parseLines(raw)) {
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length === 2 && parts[0] && parts[1]) {
      result.push({ from: parts[0], to: parts[1] });
    }
  }
  return result;
}

export function formatPairs(pairs: { from: string; to: string }[]): string {
  return pairs.map((p) => `${p.from},${p.to}`).join("\n");
}

export function isAllowedPair(from: string, to: string): boolean {
  return isValidPrincipal(from) && isValidPrincipal(to) && from !== to;
}

export function parseFriendlyAmount(value: string, decimals: number | null): bigint {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("-") || /[eE]/.test(trimmed)) return 0n;
  if (trimmed.length > 40) return 0n;
  const safeDecimals = decimals === null || decimals === undefined || decimals < 0 ? 8 : decimals;
  const parts = trimmed.split(".");
  if (parts.length > 2) return 0n;
  const integerPart = parts[0] || "0";
  let fractionPart = parts[1] || "";
  if (fractionPart.length > safeDecimals) {
    fractionPart = fractionPart.slice(0, safeDecimals);
  } else {
    fractionPart = fractionPart.padEnd(safeDecimals, "0");
  }
  const combined = `${integerPart}${fractionPart}`.replace(/^0+/, "");
  if (combined === "" || !/^[0-9]+$/.test(combined)) return 0n;
  return BigInt(combined);
}

export function makePolicyDraft(policy: Policy, balances: Balance[] = []): PolicyDraft {
  return {
    limits: policy.limits.map((l) => {
      const decimals = getTokenDecimals(toPrincipalText(l.token), balances);
      const token = toPrincipalText(l.token);
      return {
        token,
        maxPerTx: formatAmountSafe(l.limits.maxPerTx, decimals, token, "limit.maxPerTx"),
        maxHourlySpend: formatAmountSafe(l.limits.maxHourlySpend, decimals, token, "limit.maxHourlySpend"),
        maxDailySpend: formatAmountSafe(l.limits.maxDailySpend, decimals, token, "limit.maxDailySpend"),
      };
    }),
    recipients: policy.allowlists.recipients.join("\n"),
    dexes: policy.allowlists.dexes.join("\n"),
    pairs: formatPairs(policy.allowlists.pairs),
    tokenRecipients: (policy.allowlists.tokenRecipients ?? []).map(([token, recipients]) => [
      toPrincipalText(token),
      recipients.map(toPrincipalText),
    ]) as [string, string[]][],
    allowedHours: (policy.allowedHours ?? []).map(([principal, window]) => [
      toPrincipalText(principal),
      { start: Number(window.start), end: Number(window.end), days: (window.days ?? []).map((d) => Number(d)) },
    ]) as [string, { start: number; end: number; days: number[] }][],
    failureThreshold: policy.failureThreshold.toString(),
    approvalTimelock: (policy.approvalTimelock ?? 0n).toString(),
  };
}

export function isPolicyDraftDirty(original: Policy, draft: PolicyDraft, balances: Balance[] = []): boolean {
  const originalDraft = makePolicyDraft(original, balances);
  return JSON.stringify(originalDraft) !== JSON.stringify(draft);
}

export const KNOWN_PRINCIPALS: Record<string, string> = {
  "ryjl3-tyaaa-aaaaa-aaaba-cai": "ICP Ledger",
  "mxzaz-hqaaa-aaaar-qaada-cai": "ckBTC Ledger",
  "xevnm-gaaaa-aaaar-qafnq-cai": "ckUSDC Ledger",
  "4mmnk-kiaaa-aaaag-qbllq-cai": "ICPSwap Factory",
};

export function isPolicyNameValid(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= 64;
}

export const KNOWN_PAIRS = [
  { from: "ryjl3-tyaaa-aaaaa-aaaba-cai", to: "xevnm-gaaaa-aaaar-qafnq-cai", label: "ICP ➔ ckUSDC" },
  { from: "xevnm-gaaaa-aaaar-qafnq-cai", to: "ryjl3-tyaaa-aaaaa-aaaba-cai", label: "ckUSDC ➔ ICP" },
  { from: "mxzaz-hqaaa-aaaar-qaada-cai", to: "xevnm-gaaaa-aaaar-qafnq-cai", label: "ckBTC ➔ ckUSDC" },
  { from: "xevnm-gaaaa-aaaar-qafnq-cai", to: "mxzaz-hqaaa-aaaar-qaada-cai", label: "ckUSDC ➔ ckBTC" },
];

export function getPrincipalLabel(p: string): string | null {
  const clean = p.trim().toLowerCase();
  return KNOWN_PRINCIPALS[clean] || null;
}

export function resolveRecipientLabel(principal: string, labels: [string, string][] = []): string | null {
  const norm = principal.trim().toLowerCase();
  for (const [p, label] of labels) {
    if (p.trim().toLowerCase() === norm) return label;
  }
  return null;
}

export const PRINCIPAL_PATTERN: RegExp = /^[a-z0-9]{3,8}(-[a-z0-9]{3,8}){0,15}$/;

export function isValidPrincipal(p: string): boolean {
    const s = p.trim();
    if (!s || s.length < 5 || s.length > 64) return false;
    return PRINCIPAL_PATTERN.test(s);
}

export function policyArg(policy: Policy, draft: PolicyDraft, balances: Balance[] = []): JsonValue {
  const limits = draft.limits
    .filter((l) => l.token.trim().length > 0)
    .map((l) => {
      const decimals = getTokenDecimals(l.token.trim(), balances);
      return {
        token: l.token.trim(),
        limits: {
          maxPerTx: parseFriendlyAmount(l.maxPerTx, decimals).toString(),
          maxHourlySpend: parseFriendlyAmount(l.maxHourlySpend, decimals).toString(),
          maxDailySpend: parseFriendlyAmount(l.maxDailySpend, decimals).toString(),
        },
      };
    });
  return {
    limits,
    allowlists: {
      recipients: parseLines(draft.recipients),
      dexes: parseLines(draft.dexes),
      pairs: parsePairs(draft.pairs),
      tokenRecipients: (draft.tokenRecipients ?? []).map(([token, recipients]) => [
        token,
        recipients.filter((r) => r.trim().length > 0),
      ]),
    },
    circuitBreaker: policy.circuitBreaker,
    failureThreshold: toBigInt(draft.failureThreshold).toString(),
    consecutiveFailures: policy.consecutiveFailures.toString(),
    allowedHours: (draft.allowedHours ?? []).map(([principal, window]) => [
      principal,
      { start: window.start, end: window.end, days: (window.days ?? []).map((d) => String(d)) },
    ]),
    approvalTimelock: toBigInt(draft.approvalTimelock || "0").toString(),
  } as unknown as JsonValue;
}

export function validatePolicyDraft(draft: PolicyDraft, balances: Balance[] = []): string[] {
  const errors: string[] = [];
  const tokens = new Set<string>();

  draft.limits.forEach((limit, index) => {
    const label = `Token budget ${index + 1}`;
    const token = limit.token.trim();
    if (!isValidPrincipal(token)) errors.push(`${label} needs a valid token principal.`);
    if (tokens.has(token)) errors.push(`${label} duplicates another token budget.`);
    tokens.add(token);

    const decimals = getTokenDecimals(token, balances);
    const values = [limit.maxPerTx.trim(), limit.maxHourlySpend.trim(), limit.maxDailySpend.trim()];
    
    const decimalRegex = /^[0-9]+(\.[0-9]+)?$/;
    if (values.some((v) => !decimalRegex.test(v) || parseFriendlyAmount(v, decimals) <= 0n)) {
      errors.push(`${label} limits must be positive numbers.`);
      return;
    }

    const perTx = parseFriendlyAmount(limit.maxPerTx, decimals);
    const hourly = parseFriendlyAmount(limit.maxHourlySpend, decimals);
    const daily = parseFriendlyAmount(limit.maxDailySpend, decimals);
    if (perTx > hourly) errors.push(`${label} per-transaction limit cannot exceed its hourly limit.`);
    if (hourly > daily) errors.push(`${label} hourly limit cannot exceed its daily limit.`);
  });

  const recipients = parseLines(draft.recipients);
  const dexes = parseLines(draft.dexes);
  const pairLines = parseLines(draft.pairs);
  recipients.forEach((principal) => {
    if (!isValidPrincipal(principal)) errors.push(`Recipient ${principal} is not a valid principal.`);
  });
  dexes.forEach((principal) => {
    if (!isValidPrincipal(principal)) errors.push(`DEX ${principal} is not a valid principal.`);
  });
  pairLines.forEach((line) => {
    const parts = line.split(",").map((part) => part.trim());
    if (parts.length !== 2 || !parts[0] || !parts[1] || !isValidPrincipal(parts[0]) || !isValidPrincipal(parts[1])) {
      errors.push(`Token pair "${line}" must contain two valid principals separated by a comma.`);
    } else if (parts[0] === parts[1]) {
      errors.push(`Token pair "${line}" cannot swap a token to itself.`);
    }
  });

  const threshold = draft.failureThreshold.trim();
  if (!/^[0-9]+$/.test(threshold) || BigInt(threshold) <= 0n) {
    errors.push("Failure threshold must be a positive whole number.");
  }

  const timelock = (draft.approvalTimelock || "0").trim();
  if (!/^[0-9]+$/.test(timelock) || BigInt(timelock) < 0n) {
    errors.push("Approval timelock must be a non-negative whole number of seconds.");
  }

  (draft.allowedHours ?? []).forEach(([principal, window], index) => {
    if (!isValidPrincipal(principal)) {
      errors.push(`Allowed hours ${index + 1}: recipient principal is not valid.`);
    }
    if (window.start < 0 || window.start > 23) {
      errors.push(`Allowed hours ${index + 1}: start hour must be 0–23.`);
    }
    if (window.end < 0 || window.end > 23) {
      errors.push(`Allowed hours ${index + 1}: end hour must be 0–23.`);
    }
    (window.days ?? []).forEach((d) => {
      if (!Number.isInteger(d) || d < 0 || d > 6) {
        errors.push(`Allowed hours ${index + 1}: weekday ${d} is invalid (must be 0–6, Sun–Sat).`);
      }
    });
    const dayList = window.days ?? [];
    if (new Set(dayList).size !== dayList.length) {
      errors.push(`Allowed hours ${index + 1}: weekday list contains duplicates.`);
    }
  });

  (draft.tokenRecipients ?? []).forEach(([token, recipients], index) => {
    if (!isValidPrincipal(token)) {
      errors.push(`Per-token recipient list ${index + 1}: token principal is not valid.`);
    }
    recipients.forEach((r) => {
      if (!isValidPrincipal(r)) {
        errors.push(`Per-token recipient list ${index + 1}: recipient ${r} is not a valid principal.`);
      }
    });
  });

  return [...new Set(errors)];
}

export interface ReceiptDetails {
  type: "transfer" | "swap";
  blockIndex?: string | undefined;
  approvalBlockIndex?: string | undefined;
  transactionId?: string | undefined;
  fee?: string | undefined;
  amountOut?: string | undefined;
  token?: string | undefined;
  pool?: string | undefined;
}

export function parseReceipt(settlement: JsonValue): ReceiptDetails | null {
  if (!settlement || typeof settlement !== "object") return null;
  if (Array.isArray(settlement)) return settlement.length === 0 ? null : parseReceipt(settlement[0] as JsonValue);
  const s = settlement as Record<string, unknown>;
  const succ = (s.success || (s.Ok ?? (s as Record<string, unknown>).ok)) as Record<string, unknown> | undefined;
  if (!succ || typeof succ !== "object") return null;

  if ("transfer" in succ && succ.transfer) {
    const t = succ.transfer as Record<string, unknown>;
    const tokenVal = t.token;
    const tokenStr = typeof tokenVal === "string" ? tokenVal : tokenVal && typeof tokenVal === "object" && "toText" in tokenVal && typeof (tokenVal as { toText: () => string }).toText === "function" ? (tokenVal as { toText: () => string }).toText() : String(tokenVal || "");
    return {
      type: "transfer",
      blockIndex: t.blockIndex != null ? String(t.blockIndex) : undefined,
      fee: t.fee != null ? String(t.fee) : undefined,
      token: tokenStr || undefined,
    };
  }

  if ("swap" in succ && succ.swap) {
    const sw = succ.swap as Record<string, unknown>;
    const poolVal = sw.pool;
    const poolStr = typeof poolVal === "string" ? poolVal : poolVal && typeof poolVal === "object" && "toText" in poolVal && typeof (poolVal as { toText: () => string }).toText === "function" ? (poolVal as { toText: () => string }).toText() : String(poolVal || "");
    return {
      type: "swap",
      approvalBlockIndex: sw.approvalBlockIndex != null ? String(sw.approvalBlockIndex) : undefined,
      transactionId: sw.transactionId != null ? String(sw.transactionId) : undefined,
      amountOut: sw.amountOut != null ? String(sw.amountOut) : undefined,
      fee: sw.fee != null ? String(sw.fee) : undefined,
      pool: poolStr || undefined,
    };
  }

  return null;
}

function csvEscape(value: string): string {
  if (/^[=+\-@]/.test(value)) {
    return `'${value.replace(/"/g, '""')}`;
  }
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function exportAuditToCsv(audit: AuditEntry[], balances: Balance[] = [], labels: [string, string][] = []): string {
  const headers = ["ID", "Timestamp", "Action Type", "Tier", "Policy Error", "Ticket ID", "Note", "Settlement Status", "Block Index/AmountOut"];
  const rows = audit.map((entry) => {
    const details = parseActionDetails(entry.action, balances, labels);
    const receipt = parseReceipt(entry.settlement);
    const tierName = getTier(entry.tier) === "autonomous" ? "Autonomous" : getTier(entry.tier) === "escalation" ? "Escalation" : "Forbidden";
    const settlementStatus = entry.settlement === null ? "unsettled" : receipt ? `settled (${receipt.type === "transfer" ? receipt.blockIndex : receipt.amountOut})` : "settled";
    return [
      String(entry.id),
      String(entry.timestamp),
      details.type === "swap" ? "swap" : details.type === "transfer" ? "transfer" : "other",
      tierName,
      formatVaultError(entry.policyError),
      entry.ticketId ? String(entry.ticketId) : "",
      entry.note ?? "",
      settlementStatus,
      receipt?.type === "transfer" && receipt.blockIndex ? receipt.blockIndex : receipt?.type === "swap" && receipt.amountOut ? receipt.amountOut : "",
    ];
  });
  const allRows = [headers, ...rows];
  return allRows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

export function downloadFile(filename: string, content: string, mimeType: string = "text/plain"): boolean {
  if (typeof window === "undefined" || !document) {
    throw new Error("Download environment unavailable");
  }

  const payload = {
    type: "neutron:download",
    filename,
    content,
    mimeType,
  };

  let sent = false;
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(payload, "*");
      sent = true;
    }
  } catch {}

  try {
    if (window.top && window.top !== window.parent && window.top !== window) {
      window.top.postMessage(payload, "*");
      sent = true;
    }
  } catch {}

  if (!sent) {
    try {
      const blob = new Blob([content], { type: mimeType || "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        if (document.body.contains(a)) document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 2000);
    } catch (err) {
      console.error("downloadFile error:", err);
    }
  }
  return true;
}
