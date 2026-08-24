// Agent Vault — resident agent tool surface.
//
// Registers 5 tools that map 1:1 to the manifest's `agent_entrypoints`.
// Read tools use querySelf; write tools use updateSelf and publish a state
// change so the dashboard tile auto-refreshes.
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
const principalPattern = "^[a-z0-9][a-z0-9-]{3,62}$";

const activityInputSchema: JsonObject = {
  type: "object",
  required: ["limit", "offset"],
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 1000 },
    offset: { type: "integer", minimum: 0 },
  },
  additionalProperties: false,
};

const syncBalanceInputSchema: JsonObject = {
  type: "object",
  required: ["token"],
  properties: {
    token: {
      type: "string",
      pattern: principalPattern,
      description: "The ICRC-1 token ledger canister principal to sync.",
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

const activityOutputSchema: JsonObject = {
  type: "array",
  description: "Array of AuditEntry records (oldest-first storage order).",
  items: { type: "object" },
};

const pendingOutputSchema: JsonObject = {
  type: "array",
  description: "Array of pending Ticket records awaiting owner approval.",
  items: { type: "object" },
};

const balanceOutputSchema: JsonObject = {
  type: "object",
  description: "Synced balance with token metadata: { token: Token, amount: Nat, syncedAt: Int }.",
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
    const obj = value as Record<string, JsonValue>;
    if ("ok" in obj) return obj.ok as JsonObject;
    if ("err" in obj) {
      const err = obj.err;
      const message =
        typeof err === "object" && err !== null && "message" in (err as Record<string, unknown>)
          ? String((err as Record<string, unknown>).message)
          : JSON.stringify(err);
      throw new Error(message);
    }
  }
  // If the response isn't a variant wrapper, return it as-is.
  return value as JsonObject;
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

// 2. get_activity_history — paginated audit feed.
exposeTool(
  "get_activity_history",
  {
    title: "Read Agent Vault Activity History",
    description:
      "Read paginated audit entries (oldest-first). Returns up to `limit` records starting at `offset`.",
    inputSchema: activityInputSchema,
    outputSchema: activityOutputSchema,
    annotations: { "neutron:effects": ["read"] },
  },
  async (args) => {
    const limit = requirePositiveInt(args.limit, "limit", 1000);
    const offset = requireNonNegativeInt(args.offset, "offset");
    return unwrapResult(
      // Nat args must cross the kernel as decimal strings (icblast encoding),
      // else AJV rejects the self-call before the backend runs.
      await querySelf("getActivityHistory", [String(limit), String(offset)]),
    );
  },
);

// get_pending_approvals is not an agent entrypoint (Neutron limits to 4),
// but it remains accessible to the dashboard tile via preapproved_self_calls.

// 3. sync_balance — refresh one token's balance from its ledger.
exposeTool(
  "sync_balance",
  {
    title: "Sync Token Balance",
    description:
      "Query one ICRC-1 token ledger for its symbol, decimals, fee, and the vault's current balance. Updates the vault's cached state.",
    inputSchema: syncBalanceInputSchema,
    outputSchema: balanceOutputSchema,
    annotations: { "neutron:effects": ["write", "network"] },
  },
  async (args) => {
    const token = requirePrincipalString(args.token, "token");
    const result = unwrapResult(await updateSelf("syncBalance", [token]));
    await publishChange();
    return result;
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
      await updateSelf("proposeTransfer", [token, recipient, amount, reason]),
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
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{3,62}$/.test(value)) {
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

function requirePositiveInt(
  value: JsonValue | undefined,
  label: string,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${label} must be an integer between 1 and ${max}`);
  }
  return value;
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
