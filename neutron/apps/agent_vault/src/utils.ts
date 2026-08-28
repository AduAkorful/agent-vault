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

export function formatAmount(value: unknown, decimals: number | null): string {
  let bi: bigint;
  try {
    bi = toBigInt(value);
  } catch {
    return "—";
  }
  if (decimals === null || decimals === undefined || decimals < 0) {
    return bi.toString();
  }
  const safeDecimals = Math.min(decimals, 18);
  const divisor = 10n ** BigInt(safeDecimals);
  const integerPart = bi / divisor;
  const fractionPart = bi % divisor;
  if (fractionPart === 0n) return integerPart.toString();
  const fracStr = fractionPart.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${integerPart}.${fracStr}`;
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
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    const rec = result as Record<string, unknown>;
    if ("ok" in rec) return rec.ok as T;
    if ("err" in rec) throw new Error(extractErrorMessage(rec.err));
    if ("Ok" in rec) return rec.Ok as T;
    if ("Err" in rec) throw new Error(extractErrorMessage(rec.Err));
    throw new Error(`malformed result envelope: ${JSON.stringify(result)}`);
  }
  throw new Error(`malformed result envelope: ${JSON.stringify(result)}`);
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

export function parseActionDetails(action: JsonValue, balances: Balance[] = []): ActionDetails {
  const tokenDecimals = new Map(balances.map((b) => [toPrincipalText(b.token.id), b.token.decimals]));
  const tokenSymbols = new Map(balances.map((b) => [toPrincipalText(b.token.id), b.token.symbol]));

  if (typeof action === "object" && action !== null) {
    const rec = action as Record<string, JsonValue>;
    if ("transfer" in rec && typeof rec.transfer === "object" && rec.transfer !== null) {
      const t = rec.transfer as Record<string, JsonValue>;
      const token = toPrincipalText(t.token ?? "");
      const recipient = toPrincipalText(t.recipient ?? t.to ?? "");
      const rawAmount = String(t.amount ?? "");
      const reason = t.reason ? String(t.reason) : undefined;
      const decimals = tokenDecimals.get(token) ?? null;
      const amount = formatAmount(rawAmount, decimals);
      const tokenLabel = tokenSymbols.get(token) || getPrincipalLabel(token) || shortenPrincipal(token);
      const recipientLabel = getPrincipalLabel(recipient) || shortenPrincipal(recipient);

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

      const fromDecimals = tokenDecimals.get(fromToken) ?? null;
      const toDecimals = tokenDecimals.get(toToken) ?? null;
      const amount = formatAmount(rawAmount, fromDecimals);
      const minReturn = formatAmount(rawMinReturn, toDecimals);

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
    amount: "—",
  };
}

export function describeAction(action: JsonValue, balances: Balance[] = []): string {
  const details = parseActionDetails(action, balances);
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
  if (decimals === null || decimals === undefined || decimals < 0) {
    try {
      return toBigInt(trimmed);
    } catch {
      return 0n;
    }
  }
  const parts = trimmed.split(".");
  if (parts.length > 2) return 0n;
  const integerPart = parts[0] || "0";
  let fractionPart = parts[1] || "";
  if (fractionPart.length > decimals) {
    fractionPart = fractionPart.slice(0, decimals);
  } else {
    fractionPart = fractionPart.padEnd(decimals, "0");
  }
  const combined = `${integerPart}${fractionPart}`.replace(/^0+/, "");
  if (combined === "" || !/^[0-9]+$/.test(combined)) return 0n;
  return BigInt(combined);
}

export function makePolicyDraft(policy: Policy, balances: Balance[] = []): PolicyDraft {
  const tokenDecimals = new Map(balances.map((b) => [toPrincipalText(b.token.id), b.token.decimals]));
  return {
    limits: policy.limits.map((l) => {
      const decimals = tokenDecimals.get(toPrincipalText(l.token)) ?? null;
      return {
        token: toPrincipalText(l.token),
        maxPerTx: formatAmount(l.limits.maxPerTx, decimals),
        maxHourlySpend: formatAmount(l.limits.maxHourlySpend, decimals),
        maxDailySpend: formatAmount(l.limits.maxDailySpend, decimals),
      };
    }),
    recipients: policy.allowlists.recipients.join("\n"),
    dexes: policy.allowlists.dexes.join("\n"),
    pairs: formatPairs(policy.allowlists.pairs),
    failureThreshold: policy.failureThreshold.toString(),
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

export const PRINCIPAL_PATTERN: RegExp = /^[a-z0-9]{3,8}(-[a-z0-9]{3,8}){0,15}$/;

export function isValidPrincipal(p: string): boolean {
    const s = p.trim();
    if (!s || s.length < 5 || s.length > 64) return false;
    return PRINCIPAL_PATTERN.test(s);
}

export function policyArg(policy: Policy, draft: PolicyDraft, balances: Balance[] = []): JsonValue {
  const tokenDecimals = new Map(balances.map((b) => [b.token.id, b.token.decimals]));
  const limits = draft.limits
    .filter((l) => l.token.trim().length > 0)
    .map((l) => {
      const decimals = tokenDecimals.get(l.token.trim()) ?? null;
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
    },
    circuitBreaker: policy.circuitBreaker,
    failureThreshold: toBigInt(draft.failureThreshold).toString(),
    consecutiveFailures: policy.consecutiveFailures.toString(),
  } as unknown as JsonValue;
}

export function validatePolicyDraft(draft: PolicyDraft, balances: Balance[] = []): string[] {
  const errors: string[] = [];
  const tokens = new Set<string>();
  const tokenDecimals = new Map(balances.map((b) => [b.token.id, b.token.decimals]));

  draft.limits.forEach((limit, index) => {
    const label = `Token budget ${index + 1}`;
    const token = limit.token.trim();
    if (!isValidPrincipal(token)) errors.push(`${label} needs a valid token principal.`);
    if (tokens.has(token)) errors.push(`${label} duplicates another token budget.`);
    tokens.add(token);

    const decimals = tokenDecimals.get(token) ?? null;
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

export function exportAuditToCsv(audit: AuditEntry[], balances: Balance[] = []): string {
  const headers = ["ID", "Timestamp", "Action Type", "Tier", "Policy Error", "Ticket ID", "Note", "Settlement Status", "Block Index/AmountOut"];
  const rows = audit.map((entry) => {
    const details = parseActionDetails(entry.action, balances);
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
