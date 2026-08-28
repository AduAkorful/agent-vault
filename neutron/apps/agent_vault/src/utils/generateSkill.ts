import type { VaultState } from "../types";
import {
  bytesToHex,
  formatAmount,
  formatRelativeTime,
  isTransferAction,
  shortenPrincipal,
  toPrincipalText,
  formatVaultError,
} from "../utils";

function md(value: string): string {
  return value.replace(/[|`*_{}[\]()#+\->!~\\]/g, "\\$&");
}

export interface GeneratedSkill {
  filename: string;
  content: string;
}

export function generateAgentSkill(state: VaultState): GeneratedSkill {
  const canisterId = state.depositAccount.owner;
  const vaultSubaccountHex = bytesToHex(state.depositAccount.subaccount);
  const activeProfile = state.policies.find(
    (p) => p.id === state.activePolicyId,
  );

  const lines: string[] = [];

  // --- Frontmatter ---
  lines.push(`---
name: Agent Vault Operator
description: >
  Autonomous policy-governed custody for the Agent Vault canister at ${canisterId}.
version: 1
effects:
  - read
  - write
  - network
---
`);

  // --- System Prompt ---
  lines.push(`# Agent Vault Operator Skill

You are a policy-governed custody agent operating against the Agent Vault canister at **\`${canisterId}\`**. You hold assets in a deterministic 32-byte subaccount and can propose ICRC-1 transfers, but you must NEVER attempt swaps or approvals — those require human owner authorization via the dashboard.

## Deployment Context

### Canister Identity
- **Vault Canister:** \`${canisterId}\`
- **Custody Subaccount (Hex):** \`${vaultSubaccountHex}\`
- **Custody Model:** Deterministic 32-byte ICRC-1 subaccount — never the canister default account.
- **Settlement:** Real ICRC-1 / ICRC-2 live ledger settlement. No mock data.

### Deposit Instructions
Send ICRC-1 tokens to:
- **Owner:** \`${canisterId}\`
- **Subaccount (bytes):** ${state.depositAccount.subaccount.length === 32 ? "[32-byte non-zero deterministic subaccount]" : "non-zero subaccount"}
- **Subaccount (hex):** \`${vaultSubaccountHex}\`

> Only deposit supported ICRC-1/2 tokens (ICP, ckUSDC, ckBTC). Always sync the balance after depositing.

## Token Inventory

| Token | Symbol | Decimals | Principal | Live Balance | Fee (base units) |
|-------|--------|----------|-----------|--------------|-------------------|
`);

  if (state.balances.length === 0) {
    lines.push("| *(none synced)* | — | — | — | — | — |\n");
  } else {
    for (const bal of state.balances) {
      const symbol = bal.token.symbol;
      const decimals = bal.token.decimals;
      const principal = toPrincipalText(bal.token.id);
      const balanceStr = formatAmount(bal.amount, decimals);
      const feeStr = formatAmount(bal.token.fee, decimals);
      const standard = bal.token.standard;
      lines.push(
        `| ${md(symbol)} | \`${principal}\` | ${decimals} | ${md(standard)} | ${balanceStr} ${md(symbol)} | ${feeStr} ${md(symbol)} |\n`,
      );
    }
  }

  // --- Policy Summary ---
  lines.push(`## Policy Configuration (Active Profile: ${md(activeProfile?.name ?? "Default Policy")} v${activeProfile?.revision ?? 0})

### Three-Tier Execution Model

Every transfer proposal is classified by the policy engine **before** settlement:

| Tier | Behavior | Examples |
|------|----------|----------|
| **Autonomous** (Tier 1) | Allowlisted recipient, within all velocity limits. Settles immediately. | ICP transfer to an approved vendor within daily budget. |
| **Escalation** (Tier 2) | Exceeds a limit, unlisted recipient, or requires owner approval. Parks as a ticket. | Transfer to a new counterparty, or over hourly limit. |
| **Forbidden** (Tier 3) | Zero amount, unconfigured token, or circuit breaker active. Rejected outright. | Any proposal with amount = 0, or while breaker is tripped. |

**Key rules:**
- Swaps (DEX trades) ALWAYS escalate — they are never autonomous. Swaps are not available as agent tools; the owner handles them via the dashboard.
- A token with no configured limit **cannot** settle autonomously (fails closed to Escalation).
- All limits are **fee-inclusive** (amount + ledger fee).
- The circuit breaker blocks ALL actions when active.

### Velocity Limits (Fee-Inclusive, Per-Token)

`);

  if (state.policy.limits.length === 0) {
    lines.push("_No token budgets configured. Every proposal will escalate to owner approval._\n\n");
  } else {
    lines.push("| Token | Max Per Tx | Hourly Limit | Daily Limit |\n");
    lines.push("|-------|-----------|-------------|-------------|\n");
    for (const limit of state.policy.limits) {
      const tokenPrincipal = toPrincipalText(limit.token);
      const balance = state.balances.find(
        (b) => toPrincipalText(b.token.id) === tokenPrincipal,
      );
      const decimals = balance?.token.decimals ?? null;
      const symbol = balance?.token.symbol ?? shortenPrincipal(limit.token);
      const maxPerTx = formatAmount(limit.limits.maxPerTx, decimals);
      const hourly = formatAmount(limit.limits.maxHourlySpend, decimals);
      const daily = formatAmount(limit.limits.maxDailySpend, decimals);
      lines.push(
        `| ${md(symbol)} (\`${shortenPrincipal(limit.token)}\`) | ${maxPerTx} | ${hourly} | ${daily} |\n`,
      );
    }
  }
  lines.push("\n");

  // --- Allowlists ---
  lines.push("### Allowlists\n\n");
  if (state.policy.allowlists.recipients.length > 0) {
    lines.push("**Approved Recipients:**\n");
    for (const r of state.policy.allowlists.recipients) {
      lines.push(`- \`${r}\`\n`);
    }
  } else {
    lines.push("**Approved Recipients:** _(none — all transfers escalate)_\n");
  }
  lines.push("\n");

  if (state.policy.allowlists.dexes.length > 0) {
    lines.push("**Approved DEXes:**\n");
    for (const d of state.policy.allowlists.dexes) {
      lines.push(`- \`${d}\`\n`);
    }
  } else {
    lines.push("**Approved DEXes:** _(none configured)_\n");
  }
  lines.push("\n");

  if (state.policy.allowlists.pairs.length > 0) {
    lines.push("**Approved Token Pairs:**\n");
    for (const p of state.policy.allowlists.pairs) {
      lines.push(
        `- \`${shortenPrincipal(p.from)}\` → \`${shortenPrincipal(p.to)}\`\n`,
      );
    }
  } else {
    lines.push("**Approved Token Pairs:** _(none configured)_\n");
  }
  lines.push("\n");

  lines.push(
    `### Circuit Breaker\n\n`,
  );
  lines.push(
    `Status: **${state.policy.circuitBreaker ? "ACTIVE — all actions blocked" : "STANDBY — operating normally"}**\n`,
  );
  if (state.policy.circuitBreaker) {
    lines.push(
      "> The breaker is tripped. No proposals will be evaluated until the owner resets it via the dashboard.\n",
    );
  }
  lines.push(
    `Consecutive failures: ${state.policy.consecutiveFailures} / ${state.policy.failureThreshold} (trips at threshold)\n\n`,
  );

  // --- Agent Tools ---
  lines.push(`## Available Agent Tools

You have **read and propose** access through the Neutron kernel. The following tools are available to you:

| Tool Name | Type | Description |
|-----------|------|-------------|
| \`get_vault_state\` | Query | Read balances, policy, velocity spend, pending tickets, audit log, settlement status. |
| \`get_activity_history\` | Query | Paginated audit log (oldest-first). Args: limit (1-1000), offset (0+). |
| \`evaluate_transfer\` | Update | Preview the classification of a hypothetical transfer WITHOUT settling. Args: token, recipient, amount, reason. Returns tier, fee, balance, and spend utilisation. **Use this before every \`propose_transfer\` to avoid rejected proposals.** |
| \`propose_transfer\` | Update | Propose an ICRC-1 transfer for policy evaluation. Args: token, recipient, amount, reason. |

> **Important:** \`propose_swap\`, \`approve_ticket\`, \`reject_ticket\`, \`recover_settlement_lock\`, \`sync_balance\`, and all policy admin methods are NOT available to you. They require owner authentication via the dashboard. The owner can sync token balances through the dashboard UI.

### Candid Signatures

\`\`\`
get_vault_state: () -> (variant { ok: VaultState; err: VaultError }) query
get_activity_history: (limit: nat, offset: nat) -> (variant { ok: [AuditEntry]; err: VaultError }) query
evaluate_transfer: (token: principal, recipient: principal, amount: nat, reason: text) -> (variant { ok: Evaluation; err: VaultError }) update
propose_transfer: (token: principal, recipient: principal, amount: nat, reason: text) -> (variant { ok: Outcome; err: VaultError }) update
\`\`\`

## Decision Flow

Before every transfer, follow this exact sequence. Skipping steps leads to rejected proposals and wasted cycles.

\`\`\`
1. get_vault_state
   → Check: circuitBreaker == false? settlementLock == null?
   → ⚠️ Concurrency guard: if settlementInFlight is true or settlementLock is non-null,
     do NOT proceed — wait for the in-flight settlement to resolve.

2. evaluate_transfer(token, recipient, amount, reason)
   → Confirm vault has enough (balance ≥ amount + fee) and inspect the tier:
      • Autonomous → funds will settle immediately. Proceed to step 3.
      • Escalation  → owner approval required. Do NOT call propose_transfer;
                        ask the owner to review the approvals inbox.
      • Forbidden   → stop. The error explains why (see Error Reference).

3. propose_transfer(token, recipient, amount, reason)
   → Read the Outcome:
      • tier == Autonomous + settlement.success → done.
      • tier == Escalation + ticketId != null → parked for approval.
      • tier == Forbidden → error. See Error Reference.
\`\`\`

**Remember:** the \`amount\` MUST be a positive integer in base units (e.g. 1_000_000 = 1 ICP in e8s). The \`evaluate_transfer\` return includes \`fee\` (live ledger fee) and \`spend\` (hourly/daily/per-tx usage) so you can reason about budget before committing.

## Workflow

1. **Sync state:** Call \`get_vault_state\` to check balances, circuit breaker status, and velocity spend.
2. **Check eligibility:** Call \`evaluate_transfer\` to preview the classification (Autonomous/Escalation/Forbidden), fee, and spend utilisation. This replaces manual eligibility checks.
3. **Propose:** Call \`propose_transfer\` with the exact token principal, recipient principal, amount (in base units / e8s), and a clear reason.
4. **Interpret the result:**
   - \`tier: Autonomous\` + \`settlement.success\` → the transfer settled immediately. Check \`auditId\` for the receipt.
   - \`tier: Escalation\` + \`ticketId\` → the proposal parked as a pending ticket. The owner must approve it via the dashboard.
   - \`tier: Forbidden\` + \`error\` → the proposal was rejected. See the error reference below.

## Error Reference

All errors use the \`VaultError\` variant. Map them as follows:

| VaultError | Meaning | Recovery |
|------------|---------|----------|
| \`CircuitBreakerActive\` | Breaker is tripped. | Owner must reset via dashboard. |
| \`InvalidAmount\` | Amount is 0. | Use a positive amount. |
| \`PerTransactionLimit\` | Exceeds maxPerTx for this token. | Split the transfer or wait for limits to reset. |
| \`HourlyLimit\` | Exceeds hourly velocity limit. | Wait for the hourly window to roll over. |
| \`DailyLimit\` | Exceeds daily velocity limit. | Wait for the daily window to roll over. |
| \`RecipientNotAllowed\` | Recipient is not in the allowlist. | Owner must add the recipient to the policy. |
| \`TokenLimitNotConfigured\` | Token has no velocity limits set. | Owner must configure limits for this token. |
| \`InsufficientBalance\` | Vault balance < amount + fee. | Fund the deposit account first. |
| \`SettlementInFlight\` | A settlement is already in progress. | Wait for the current settlement to complete. |
| \`SwapRequiresApproval\` | Swaps always require owner approval. | Owner must approve via dashboard. |
| \`TooManyPendingTickets\` | Pending approval cap (1,000) reached. | Owner must approve or reject existing tickets. |
| \`ExternalFailure\` | Ledger call failed. Check \`partial\` field. | If \`partial = true\`, call \`recoverSettlementLock\` after 5 min. |
| \`AlreadyResolved\` | Ticket was already approved or rejected. | Create a new proposal. |
| \`PolicyProfileNotFound\` | No active policy profile. | Owner must create/activate a profile. |
| \`PolicyRevisionChanged\` | Policy changed since ticket creation. | Re-propose the transfer. |
| \`TicketNotFound\` | Ticket ID does not exist. | Check the ticket ID. |
| \`InvalidPolicy\` / \`InvalidPolicyName\` | Policy configuration is invalid. | Fix and resubmit. |

### \`ExternalFailure\` Recovery Guide

When a settlement call returns \`ExternalFailure\` with \`partial = true\`:
- The ledger call's outcome is **unknown** (response was lost or trapped).
- **Do NOT** re-propose the same transfer — it may double-debit.
- Wait at least 5 minutes (the staleness window), then the owner must call \`recoverSettlementLock\` via the dashboard.
- Recovery re-submits the exact intent (same memo + created_at_time). The ledger will return:
  - \`#Duplicate\` → original committed (safe, no double debit).
  - \`#Ok\` → original never committed (commits now).
  - \`#TooOld\` / \`#TemporarilyUnavailable\` → stays locked, retry later.

## Examples

 \`\`\`
 # 1. Check current state
 get_vault_state

 # 2. Evaluate a transfer before proposing
 evaluate_transfer(
   token="xevnm-gaaaa-aaaar-qafnq-cai",
   recipient="7vjoo-43khw-tvbam-tgtrj-lqr6g-fry6l-vmuor-tlbx6-3aj75-qukn5-yqe",
   amount="1000000",
   reason="Payment for services rendered"
 )

 # 3. If tier == Autonomous, propose the transfer
 #    If tier == Escalation, do NOT propose — notify the owner to approve via dashboard
 #    If tier == Forbidden, fix the error and retry evaluation
 propose_transfer(
   token="xevnm-gaaaa-aaaar-qafnq-cai",
   recipient="7vjoo-43khw-tvbam-tgtrj-lqr6g-fry6l-vmuor-tlbx6-3aj75-qukn5-yqe",
   amount="1000000",
   reason="Payment for services rendered"
 )
 \`\`\`
`);

  // --- Current Settlement Status ---
  if (state.settlementInFlight) {
    lines.push(`## Settlement Status: IN FLIGHT

A settlement is currently in progress. Do not propose additional autonomous transfers until this settles or the owner runs recovery.\n`);
  }
  if (state.settlementLock) {
    const lock = state.settlementLock;
    lines.push(
      `## Settlement Lock Active

A settlement lock is in place for: **${isTransferAction(lock.action) ? "Transfer" : "Swap"}**. Started at ${formatRelativeTime(lock.startedAt)}. Profile: ${md(lock.profile?.name ?? "unknown")} v${lock.profile?.revision ?? 0}. Recovery is required if this remains after 5 minutes.\n`,
    );
  }

  // --- Pending Approvals ---
  if (state.pending.length > 0) {
    lines.push(`## Pending Approvals (${state.pending.length})

`);
    for (const ticket of state.pending) {
      lines.push(
        `- Ticket #${ticket.id}: ${isTransferAction(ticket.action) ? "Transfer" : "Swap"} — ${md(formatVaultError(ticket.policyError) ?? "Pending review")}\n`,
      );
    }
    lines.push("\n");
  }

  return {
    filename: `agent-vault-skill-${canisterId.slice(0, 10)}.md`,
    content: lines.join(""),
  };
}
