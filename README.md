# Agent Vault

> **Sovereign Financial Execution & Policy Guardrail Environment for Autonomous AI Agents on Neutron (Internet Computer)**

---

## ◈ Overview

**Agent Vault** is a self-custodial financial execution environment and policy guardrail engine that allows autonomous AI agents to manage funds safely under user-defined on-chain rules.

By eliminating the binary trade-off between total agent autonomy (dangerous) and constant human prompting (inefficient), Agent Vault introduces a **3-tier execution model**:

1. **Tier 1 (Autonomous Execution)**: Instant settlement for low-risk transactions within velocity limits and allowlisted targets.
2. **Tier 2 (Human Escalation)**: Over-limit or unverified operations automatically park in a pending inbox for 1-click human approval.
3. **Tier 3 (Forbidden)**: Forbidden operations (circuit breaker active, unauthorized targets, invalid slippage) are immediately blocked on-chain with detailed audit logs.

---

## ⛨ Dual-Surface Architecture

Agent Vault strictly decouples the **Human Surface** (Web Dashboard) and the **Agent Surface** (Resident Tool Interface), both operating on a shared Motoko policy core with immutable managed memory.

```
                  ┌─────────────────────────────────┐
                  │          VAULT OWNER            │
                  │    (Internet Identity / Web)    │
                  └───────────────┬─────────────────┘
                                  │
                       [ Human Surface: React 19 ]
                                  │
    ┌─────────────────────────────┼─────────────────────────────┐
    │                             ▼                             │
    │                   ┌───────────────────┐                   │
    │                   │   POLICY ENGINE   │                   │
    │                   │   (Motoko Core)   │                   │
    │                   └─────────┬─────────┘                   │
    │                             │                             │
    │   [ Execution Tiers: Autonomous | Escalation | Blocked ]   │
    │                             │                             │
    │                             ▼                             │
    │                   ┌───────────────────┐                   │
    │                   │  ICRC SETTLEMENT  │                   │
    │                   └─────────┬─────────┘                   │
    │                             │                             │
    └─────────────────────────────┼─────────────────────────────┘
                                  ▲
                       [ Agent Surface: Tools ]
                                  │
                  ┌───────────────┴─────────────────┐
                  │       AUTONOMOUS AI AGENT       │
                  │  (Typed Tool Interface / RPC)   │
                  └─────────────────────────────────┘
```

---

## ✦ Dual Surface Features

### 1. Human Surface (4-Panel Dashboard)
- **◈ Portfolio Overview**: Real-time token balances (ICP, ckBTC, ckETH, ckUSDC), hourly/daily velocity budget gauges, and live per-token synchronization.
- **⛨ Policy Control Matrix**: Velocity caps (per-transaction, hourly, daily limits), allowlist management, and an interactive on-chain **Circuit Breaker** toggle.
- **◷ Live Agent Audit Feed**: Chronological execution logs tagged with execution tiers (<span style="color:#89e0aa">Autonomous</span>, <span style="color:#e5c07b">Escalation</span>, <span style="color:#e06c75">Forbidden</span>), transaction hashes, and agent notes.
- **✓ Pending Approvals Inbox**: Dedicated queue for Tier-2 escalation tickets with 1-click **Approve** and **Reject** actions.

### 2. Agent Surface (Resident Neutron Tools)
Exposes 4 strictly-typed JSON/Candid tool endpoints conforming to the Neutron app entrypoint standard:
1. `get_vault_state`: Query live balances, spend budget utilization, policy limits, and circuit breaker status.
2. `get_activity_history`: Chronological audit trail of past agent proposals and settlement receipts.
3. `sync_balance`: Sync on-chain balance from authorized ICRC-1/ICRC-2 token ledgers.
4. `propose_transfer`: Propose a token transfer evaluated deterministically by the policy engine.

---

## 🛠 Project Structure

```
agent-vault/
├── neutron/                         # Neutron OS environment
│   ├── apps/
│   │   └── agent_vault/             # Agent Vault deliverable
│   │       ├── backend/             # Motoko managed-memory core & ICRC client
│   │       │   ├── memory/          # Immutable versioned memory schema (v1.mo)
│   │       │   ├── icrc1/           # ICRC-1/2 client via backend_calls
│   │       │   └── main.mo          # Neutron App Backend class
│   │       ├── src/
│   │       │   ├── index.tsx        # 4-panel React 19 dashboard tile
│   │       │   ├── service.ts       # Resident agent tool surface
│   │       │   └── style.scss       # NDS dark-theme stylesheet
│   │       ├── public/              # Tile & service host bundles & icon
│   │       ├── test/                # Unit, schema, & memory release tests
│   │       ├── build.ts             # Multi-entry esbuild configuration
│   │       ├── neutron.json         # Manifest (entrypoints, permissions, memory)
│   │       └── agent_vault.v0.1.0.neutron  # Packaged 310 KB deliverable
│   ├── test/e2e/agent-vault.spec.ts # Playwright E2E test on PocketIC
│   └── local.ndeploy.json           # Local PocketIC deployment config
├── src/                             # Standalone Motoko policy engine reference
├── test/                            # M3 settlement integration test suite
├── AGENTS.md                        # State register, development log, and ADRs
└── README.md                        # Project documentation
```

---

## 🚀 Building & Testing

### Prerequisites
- Node.js & npm (v20+)
- [Bun](https://bun.sh) (v1.1+)
- [Mops](https://mops.one/) (Motoko package manager)

### Build the Package
```bash
cd neutron
npm --workspace neutron-agent-vault run package
```

### Run Automated Tests
```bash
# Package, unit, schema, and Motoko memory release tests
npm --workspace neutron-agent-vault test

# Standalone M3 reference policy tests
mops test
```

### Run Locally on PocketIC
```bash
cd neutron

# 1. Start the PocketIC supervisor in the background
npm run local:start

# 2. Deploy and install Agent Vault into the local user canister
npm run local:deploy

# 3. Check deployment status and open the printed URL
npm run local:status
```

### Run End-to-End Playwright Simulation
```bash
cd neutron
npx playwright test test/e2e/agent-vault.spec.ts
```

---


