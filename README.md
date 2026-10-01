# Agent Vault

**Autonomous On-Chain Custody & Policy Guardrails for AI Agents on the Internet Computer**

Agent Vault is a self-custodial Web3 application built for the Neutron platform on the Internet Computer (ICP). It empowers resident AI agents to sign, hold, and settle ICRC transactions within strict, deterministic velocity allowances — backed by segregated 32-byte subaccounts, real-time circuit breakers, and zero-compromise human approval escalations.

---

## 1. Core Architecture

Agent Vault operates on a deterministic **Three-Tier Execution Architecture**:

```
                                    ┌──────────────────────────────────────────────┐
                                    │          RESIDENT AI AGENT PROPOSAL          │
                                    └──────────────────────┬───────────────────────┘
                                                           │
                                            Is Breaker Active / Bad Args?
                                            ┌──────────────┴──────────────┐
                                           YES                            NO
                                             │                              │
                                    ┌────────▼────────┐            Is Recipient Listed
                                    │ TIER 3: FORBIDDEN│           & Within Velocity Budget?
                                    │ (Instant Reject)│            ┌────────┴────────┐
                                    └─────────────────┘           YES                NO
                                                                          │                  │
                                                            ┌──────────────────────────▼───┐  ┌───────────▼──────────────────┐
                                                            │       TIER 1: AUTONOMOUS         │  │     TIER 2: ESCALATION       │
                                                            │ Instant On-Chain Transfer Settle │  │ (DEX Swaps & Over-Budget Txs)│
                                                            └──────────────────────────────────┘  └───────────┬──────────────────┘
                                                                                                                        │
                                                                                                          ┌───────────▼──────────────────┐
                                                                                                          │    DURABLE APPROVAL TICKET   │
                                                                                                          │ Displays Agent Reason & Math │
                                                                                                          └───────────┬──────────────────┘
                                                                                                                    │
                                                                                                    Owner Signs in Dashboard
                                                                                                    ┌─────────┴─────────┐
                                                                                                 APPROVE             REJECT
                                                                                                    │                   │
                                                                    ┌───────▼───────┐   ┌───────▼───────┐
                                                                    │ On-Chain Debit│   │ Pruned/Logged │
                                                                    └───────────────┘   └───────────────┘
```

### Execution Tiers

- **Tier 1: Autonomous**: Transfers targeting allowlisted recipients within configured per-token velocity limits settle immediately on-chain with dynamic ledger fee deduction.
- **Tier 2: Escalation**: Non-allowlisted recipients, velocity budget overruns, and **all non-zero DEX swaps** generate durable approval tickets requiring explicit human owner sign-off.
- **Tier 3: Forbidden**: Zero-value transfers, missing token configurations, invalid parameters, and tripped circuit breaker operations are rejected immediately without moving funds.

---

## 2. Key Product Features

### Isolated Subaccount Custody
Assets are held in a deterministic, non-zero 32-byte vault subaccount (`{ owner: canister, subaccount: vaultSubaccount }`). The shared canister default account is never used for custody storage, guaranteeing total isolation from pooled balances.

### Token-Aware Velocity Budgets
Granular spending limits track hourly, daily, and per-transaction capacity. Live network ledger fees and token decimals are queried dynamically from each token canister (ICP, ckUSDC, ckBTC), ensuring fee-inclusive accounting with zero token balance bleeding.

### Command Center Dashboard
A four-workspace responsive operator console with:
- **Custody balance** surface: live ledger balances with per-token sync and a batch "Sync all" action.
- **Velocity budgets** surface: per-token gauges showing hourly/daily spend vs. limits, with zero-spend initialized for all configured tokens.
- **Isolated custody** surface: deterministic subaccount address with copy buttons.
- **Swap proposal form**: owner-initiated ICPSwap proposals that land as escalation tickets.

### Settlement Lock Recovery
When a settlement outcome is uncertain (response lost mid-flight), the vault enters a reconciliation lock. The Command Center shows a live countdown timer; after 5 minutes the "Recover Lock" button becomes active. Multi-stage swap recovery automatically polls until the lock clears.

### Interactive Policy Editor
A visual allowlist manager with:
- Real-time Internet Computer principal format validation.
- Quick presets for canonical IC ledgers (ICP, ckBTC, ckUSDC) and ICPSwap factory.
- Swap pair builder with guided and bulk-text modes.
- Policy profile lifecycle: create, edit, set active, delete.

### Transparent Approvals Inbox
When an agent operation escalates, the dashboard displays:
- **Agent Stated Purpose & Rationale**: exact justification and context from the AI agent.
- **Human-Readable Policy Badges**: e.g., *Mandatory DEX Swap Approval*, *Recipient Not in Allowlist*.
- **Financial Parameters**: sell amounts, minimum expected return, slippage, destination addresses.
- **Custom Rejection Reasons**: owner can type a reason before rejecting a ticket.
- **1-Click Actions**: *Approve & Settle* or *Reject*.

### Tactical Emergency Circuit Breaker
A dual-mode safety killswitch:
- **Automatic**: trips if sequential settlement errors reach the configured consecutive failure threshold.
- **Manual**: 1-click owner lockdown halts all autonomous and agent-initiated operations instantly.
- **1-Click Reset**: resumes normal operations once risks are cleared.

### Immutable Audit Activity Feed
Permanent on-chain chronological timeline recording every proposal, approval, rejection, and settlement. Filter pills (`All`, `Settled`, `Escalations`, `Forbidden`), timestamps, and a "Load more" button for paginated history beyond the 100-entry snapshot window.

### Agent Skill Export
Generates a CommandCode-compatible markdown skill file with the vault canister principal, deposit account, tracked token inventory, policy summary, agent entrypoint Candid signatures, a three-tier decision model, a VaultError reference table, and concrete usage examples.

---

## 3. Product Surfaces

Agent Vault provides two distinct surfaces communicating through the Neutron kernel:

1. **Human Owner Dashboard (`index.html`)**:
   - Four-workspace responsive dark-mode interface (Command Center, Policy, Activity, Approvals).
   - Settlement lock countdown and recovery controls.
   - Swap proposal form and batch balance sync.
   - Agent Skill download workspace.

2. **Resident AI Agent Surface (`service.ts`)**:
   - Four tool entrypoints: `get_vault_state`, `evaluate_transfer`, `propose_transfer`, `propose_swap`.
   - Owner-only methods (policy configuration, ticket approval/rejection, circuit breaker, recovery) are strictly excluded from agent authority.
   - `syncAllBalances` batch sync is available to the dashboard via preapproved self-calls.

---

## 4. Security & Protocol Invariants

| ID | Invariant | Description |
|---|---|---|
| **INV-01** | **Zero Hardcoded Values** | Token decimals, fees, and symbols are queried dynamically from live ledgers; never assumed or hardcoded. |
| **INV-02** | **Zero Mock / Demo Data** | Clean install defaults contain zero balances, zero tickets, and zero audit entries. Honest empty states are displayed. |
| **INV-03** | **Isolated Custody** | Funds live in the deterministic 32-byte subaccount. The shared default account balance is always verified to be 0. |
| **INV-04** | **Swaps Always Escalate** | Every non-zero DEX swap strictly creates an escalation ticket for owner review; swaps never settle autonomously. |
| **INV-05** | **Fee-Inclusive Accounting** | Spend windows sum `amount + fee`, ensuring limits are compared fee-inclusively against live ledger fees. |
| **INV-06** | **Durable Idempotency** | Every ledger transfer carries a unique `(memo, created_at_time)` key, promoting duplicate replies to verified successes without double debiting. |
| **INV-07** | **Safe by Default** | Unconfigured tokens fail closed and escalate to owner approval. |
| **INV-08** | **Concurrency Guard** | `settlementInFlight` and `settlementLock` prevent concurrent proposals from racing mid-settlement; the agent skill documents this pre-flight check. |

---

## 5. Repository Layout

```text
agent-vault/
├── AGENTS.md                          # Architectural boundaries and state register
├── README.md                          # Product documentation
├── plans/
│   ├── SPEC.md                       # Feature specifications
│   ├── E2E_TEST_PLAN.md             # Exhaustive end-to-end testing matrix
│   ├── HACKATHON.md                 # Hackathon submission notes
│   └── named_policies_plan.md        # Named profiles RFC
└── neutron/
    ├── apps/
    │   └── agent_vault/
    │       ├── backend/               # Motoko application logic
    │       │   ├── main.mo           # Kernel app entry & settlement state machine
    │       │   ├── memory/           # Managed-memory persistent storage (v1, v2, migration)
    │       │   ├── vault/            # Policy engine & spend-window tracking
    │       │   └── icrc1/            # ICRC-1/2 and ICPSwap protocol adapters
    │       ├── src/                  # React frontend application
    │       │   ├── components/       # UI components (ActivityPanel, ApprovalWorkspace, CommandCenter, PolicyPanel, SwapForm, SkillExport, etc.)
    │       │   ├── styles/           # Modular SCSS partials
    │       │   ├── utils/            # Skill generation and utilities
    │       │   ├── index.tsx         # Owner dashboard entry
    │       │   ├── service.ts        # Resident agent tool surface
    │       │   ├── types.ts          # Shared TypeScript types
    │       │   └── utils.ts          # Validation, decoding, and formatting utilities
    │       ├── neutron.json          # Application manifest & capability reservations
    │       └── test/                # Package tests and memory-release tests
    └── test/
        └── e2e/                     # Playwright & PocketIC integration test suites
```

---

## 6. Build and Verification

All build and verification commands run from the `neutron/` workspace root:

```bash
# Package the application (builds frontend, compiles Motoko, generates schemas)
npm --workspace neutron-agent-vault run package

# Run Motoko and TypeScript unit tests
npm --workspace neutron-agent-vault test

# Run frontend typechecking
cd apps/agent_vault && ../../node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

---

## 7. Verified Production Principals

- **ICP Ledger**: `ryjl3-tyaaa-aaaaa-aaaba-cai`
- **ckBTC Ledger**: `mxzaz-hqaaa-aaaar-qaada-cai`
- **ckUSDC Ledger**: `xevnm-gaaaa-aaaar-qafnq-cai`
- **ICPSwap Factory**: `4mmnk-kiaaa-aaaag-qbllq-cai`

*(All liquidity pools are discovered dynamically from the factory at runtime and never hardcoded.)*
