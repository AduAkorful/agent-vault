// Agent Vault — resident agent tool surface.
//
// Registers 4 tools that map 1:1 to the manifest's `agent_entrypoints`.
// Read-like tools (get_*, evaluate_*) return values directly; write tools
// (propose_*) call publishChange so the dashboard tile auto-refreshes.
//
// Modeled on apps/wallet/src/service.ts and apps/kitchensink/src/service.ts.

import {
  exposeTool,
  publishAppStateChange,
  querySelf,
  updateSelf,
  type JsonObject,
  type JsonValue,
} from "neutron-tools/app";
import { PRINCIPAL_PATTERN, extractErrorMessage } from "./utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOPIC = "agent_vault_state";
let revision = 0;

// ---------------------------------------------------------------------------
// Input / output schemas (JSON Schema)
// ---------------------------------------------------------------------------

const emptyInputSchema: JsonObject = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

// Principal inputs: validated raw strings (kernel handles Candid encoding).
const principalPattern = PRINCIPAL_PATTERN.source;

const proposeSwapInputSchema: JsonObject = {
  type: "object",
  required: ["fromToken", "toToken", "dex", "amount", "minReturn", "slippageBps", "quoteExpiresAt", "reason"],
  properties: {
    fromToken: {
      type: "string",
      pattern: principalPattern,
      description: "The ICRC-2 token ledger to swap from.",
    },
    toToken: {
      type: "string",
      pattern: principalPattern,
      description: "The ICRC-1 token ledger to swap to.",
    },
    dex: {
      type: "string",
      pattern: principalPattern,
      description: "The DEX factory principal (must be allowlisted).",
    },
    amount: {
      type: "string",
      pattern: "^[1-9][0-9]*$",
      description: "Swap input amount in base units of the from-token. Passed as a decimal string for large values.",
    },
    minReturn: {
      type: "string",
      pattern: "^[0-9]+$",
      description: "Minimum output amount in base units of the to-token. Passed as a decimal string.",
    },
    slippageBps: {
      type: "integer",
      minimum: 0,
      maximum: 10000,
      description: "Slippage tolerance in basis points (0–10000).",
    },
    quoteExpiresAt: {
      type: "integer",
      minimum: 0,
      description: "Unix nanosecond timestamp when the quote expires.",
    },
    reason: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description: "Free-text justification for the swap proposal.",
    },
  },
  additionalProperties: false,
};

const proposeTransferInputSchema: JsonObject = {
  type: "object",
  required: ["token", "recipient", "amount", "reason"],
  properties: {
    token: {
      type: "string",
      pattern: principalPattern,
      description: "The ICRC-1 token ledger canister principal.",
    },
    recipient: {
      type: "string",
      pattern: principalPattern,
      description: "The recipient's principal.",
    },
    amount: {
      type: "string",
      pattern: "^[1-9][0-9]*$",
      description:
        "Transfer amount in base units (e.g. e8s for ICP). Passed as a decimal string to support values above Number.MAX_SAFE_INTEGER.",
    },
    reason: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description: "Free-text justification for the transfer proposal.",
    },
  },
  additionalProperties: false,
};

// Output schemas are intentionally permissive — the kernel returns
// Candid-decoded JSON whose exact shape depends on the backend types.
// Constraining too tightly here would break on schema evolution.
const vaultStateOutputSchema: JsonObject = {
  type: "object",
  description: "Full vault state snapshot: balances, policy, spend windows, pending tickets, audit log, settlement status.",
};

const evaluationOutputSchema: JsonObject = {
  type: "object",
  description:
    "Classification preview: tier (Autonomous/Escalation/Forbidden), policyError, fee, balance, and per-token spend utilisation. No state is modified.",
};

const outcomeOutputSchema: JsonObject = {
  type: "object",
  description:
    "Proposal outcome: tier classification, optional error, ticket id (if Tier 2), audit id, and optional settlement receipt.",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unwrap a { ok: T } | { err: E } Candid result variant. */
function unwrapResult(value: JsonValue): JsonObject {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    const obj = value as Record<string, unknown>;
    if ("ok" in obj) return obj.ok as JsonObject;
    if ("err" in obj) {
      throw new Error(extractErrorMessage(obj.err));
    }
    throw new Error(`malformed result envelope: ${JSON.stringify(value)}`);
  }
  // Neutron self-calls return the unwrapped success value; direct Candid calls
  // return the Result variant handled above.
  throw new Error(`malformed result envelope: ${JSON.stringify(value)}`);
}

async function publishChange(): Promise<void> {
  revision = revision >= 999_999_999_999_999 ? 1 : revision + 1;
  try {
    await publishAppStateChange(TOPIC, revision);
  } catch {
    // Dashboard consumers also refetch on mount and focus.
  }
}

// ---------------------------------------------------------------------------
// Tool registrations
// ---------------------------------------------------------------------------

// 1. get_vault_state — read the full dashboard snapshot.
exposeTool(
  "get_vault_state",
  {
    title: "Read Agent Vault State",
    description:
      "Read token balances, policy configuration, rolling spend windows, pending approval tickets, audit log, and settlement status. No state is modified.",
    inputSchema: emptyInputSchema,
    outputSchema: vaultStateOutputSchema,
    annotations: { "neutron:effects": ["read"] },
  },
  async () => unwrapResult(await querySelf("getVaultState", [null])),
);

// 2. propose_swap — submit a swap proposal (always escalates to owner approval).
exposeTool(
  "propose_swap",
  {
    title: "Propose Token Swap",
    description:
      "Propose an ICRC-1 token swap on an allowlisted DEX and pair. Swaps always escalate to owner approval — they never settle autonomously. The result includes the classification tier, a durable ticket ID for the approvals inbox, and the audit entry ID.",
    inputSchema: proposeSwapInputSchema,
    outputSchema: outcomeOutputSchema,
    annotations: { "neutron:effects": ["write", "network"] },
  },
  async (args) => {
    const fromToken = requirePrincipalString(args.fromToken, "fromToken");
    const toToken = requirePrincipalString(args.toToken, "toToken");
    const dex = requirePrincipalString(args.dex, "dex");
    const amount = requireAmountString(args.amount, "amount");
    const minReturn = requireNonNegativeAmountString(args.minReturn, "minReturn");
    const slippageBps = requireNonNegativeInt(args.slippageBps, "slippageBps");
    const quoteExpiresAt = requireNonNegativeInt(args.quoteExpiresAt, "quoteExpiresAt");
    const reason = requireBoundedText(args.reason, "reason", 500);
    const result = unwrapResult(
      await updateSelf("proposeSwap", [[
        fromToken, toToken, dex,
        amount, minReturn, String(slippageBps),
        String(quoteExpiresAt), reason,
      ]]),
    );
    await publishChange();
    return result;
  },
);

// get_pending_approvals is not an agent entrypoint (Neutron limits to 4),
// but it remains accessible to the dashboard tile via preapproved_self_calls.

// 3. evaluate_transfer — preview classification without settling.
exposeTool(
  "evaluate_transfer",
  {
    title: "Evaluate Transfer Against Policy",
    description:
      "Check whether a proposed transfer would settle autonomously or escalate to owner approval — WITHOUT sending any funds. Returns the classification tier (Autonomous/Escalation/Forbidden), the policy error (if any), the live ledger fee, the vault's current balance for the token, and per-token spend utilisation (hourly, daily, per-tx limits). Use this before propose_transfer to avoid failed settlements.",
    inputSchema: proposeTransferInputSchema,
    outputSchema: evaluationOutputSchema,
    annotations: { "neutron:effects": ["network"] },
  },
  async (args) => {
    const token = requirePrincipalString(args.token, "token");
    const recipient = requirePrincipalString(args.recipient, "recipient");
    const amount = requireNonNegativeAmountString(args.amount, "amount");
    const reason = requireBoundedText(args.reason, "reason", 500);
    return unwrapResult(
      await updateSelf("evaluateTransfer", [[token, recipient, amount, reason]]),
    );
  },
);

// 4. propose_transfer — submit a transfer proposal for policy evaluation.
exposeTool(
  "propose_transfer",
  {
    title: "Propose Token Transfer",
    description:
      "Propose an ICRC-1 token transfer for policy evaluation. If the proposal is Tier 1 (within velocity limits and allowlisted), it settles immediately and returns a block-index receipt. If Tier 2 (exceeds limits), it parks a ticket for owner approval. If Tier 3 (forbidden), it is rejected with a structured error.",
    inputSchema: proposeTransferInputSchema,
    outputSchema: outcomeOutputSchema,
    annotations: { "neutron:effects": ["write", "network"] },
  },
  async (args) => {
    const token = requirePrincipalString(args.token, "token");
    const recipient = requirePrincipalString(args.recipient, "recipient");
    const amount = requireAmountString(args.amount, "amount");
    const reason = requireBoundedText(args.reason, "reason", 500);
    const result = unwrapResult(
      await updateSelf("proposeTransfer", [[token, recipient, amount, reason]]),
    );
    await publishChange();
    return result;
  },
);

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

function requirePrincipalString(
  value: JsonValue | undefined,
  label: string,
): string {
  if (typeof value !== "string" || !PRINCIPAL_PATTERN.test(value)) {
    throw new Error(`${label} must be a valid canister principal`);
  }
  return value;
}

function requireAmountString(
  value: JsonValue | undefined,
  label: string,
): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(
      `${label} must be a positive integer string in base units`,
    );
  }
  return value;
}

function requireNonNegativeAmountString(
  value: JsonValue | undefined,
  label: string,
): string {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new Error(
      `${label} must be a non-negative integer string in base units`,
    );
  }
  return value;
}

function requireBoundedText(
  value: JsonValue | undefined,
  label: string,
  maxLen: number,
): string {
  if (typeof value !== "string") throw new Error(`Expected ${label}`);
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > maxLen) {
    throw new Error(`${label} must be 1-${maxLen} characters`);
  }
  return trimmed;
}

function requireNonNegativeInt(
  value: JsonValue | undefined,
  label: string,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}
