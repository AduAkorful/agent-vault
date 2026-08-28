# Agent Vault — Neutron Application Package

This directory contains the production implementation of the **Agent Vault** Neutron package.

---

## 1. Components

- **`backend/main.mo`**: Neutron application backend, settlement state machine, ICRC-1/2 transfers, ICPSwap settlement routing, and durable recovery logic.
- **`backend/memory/agentvault/v1.mo`**: Persistent state schema on managed memory with safe empty defaults.
- **`backend/vault/Policy.mo`**: Pure policy engine for 3-tier execution classification, spend-window gauges, and validation.
- **`backend/icrc1/`**: Typed client adapters for ICRC-1, ICRC-2, ICPSwap factory discovery, and dynamic pool interactions.
- **`src/index.tsx`**: Human owner dashboard with real-time telemetry, interactive allowlists, and approvals inbox.
- **`src/service.ts`**: Resident agent service exposing typed tools for on-chain telemetry and transfer/swap proposals.
- **`src/components/`**: Modular React components (`Sidebar`, `AllowlistManager`, `LandingPanel`, `PortfolioPanel`, `PolicyPanel`, `ApprovalsPanel`, `ActivityPanel`).
- **`src/styles/`**: Partial SCSS stylesheets structured under Claude stone dark aesthetic with terracotta accents.
- **`neutron.json`**: Application manifest, function signatures, and method-level capability call reservations.

---

## 2. Core Protocol Invariants

- **Isolated Custody**: All assets are held at `{ owner: canister, subaccount: vaultSubaccount }`. The shared default account is strictly transit-only for swap cycles and is asserted to remain at 0.
- **Three-Tier Policy**: Transfers classify as Autonomous (allowlisted + within limits), Escalation (over-limit or unlisted), or Forbidden (invalid params or breaker active).
- **Mandatory Swap Escalation**: Swaps never settle autonomously; every swap requires owner sign-off.
- **Fee-Inclusive Accounting**: Limits and spend windows dynamically sum transfer amount plus queried ledger fee.
- **Zero Mock / Demo State**: Clean deployment defaults contain no seeded balances, tickets, or receipts.

---

## 3. Development & Packaging

Run from the `neutron/` workspace root:

```bash
# Package application bundle
npm --workspace neutron-agent-vault run package

# Run test suite
npm --workspace neutron-agent-vault test

# Frontend typecheck
cd apps/agent_vault && ../../node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```
