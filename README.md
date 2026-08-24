# Agent Vault

Agent Vault is a self-custodial Neutron application for policy-governed financial execution on the Internet Computer. Agents can propose and, within owner-defined limits, autonomously settle transfers. Every swap is parked for explicit owner approval and then executes a real ICRC-2 + ICPSwap round trip.

There is one production implementation: `neutron/apps/agent_vault/`. The old standalone Motoko actor and local fixture harness were removed so no reference implementation, demo path, or generated fallback can be mistaken for the product.

## Safety model

- Funds are held in a deterministic, non-zero 32-byte vault subaccount, not the shared canister default account.
- Transfer budgets are per token and fee-inclusive. Token decimals and fees are read from each ledger.
- Autonomous transfers require both a configured token limit and an allowlisted recipient.
- Swaps always require owner approval, even when the DEX and token pair are allowlisted.
- Swap settlement discovers the pool from the verified ICPSwap factory and performs: isolated vault → default transit → ICRC-2 approval → `depositFromAndSwap` → pool withdrawal → isolated vault.
- Every ICRC ledger leg has a durable `created_at_time` + memo key. Duplicate results are treated as authoritative success, not retried as new payments.
- Unknown pool outcomes are never blindly replayed. Recovery inspects exact default-account and pool balances, revokes live approval when necessary, and only moves uniquely identified funds.
- Backend-call authority is narrowed to exact ledger/factory methods plus the minimum dynamic pool method scopes.
- Policy defaults are empty and fail closed. There are no seeded balances, tickets, receipts, demo fixtures, or silent data fallbacks.

## Product surfaces

The React dashboard provides live token balances and the exact deposit owner/subaccount, per-token budget gauges, editable policy controls, bounded audit history, and pending-ticket approval/rejection.

The resident agent service exposes four typed tools: `get_vault_state`, `get_activity_history`, `sync_balance`, and `propose_transfer`. Owner-only policy, approval, swap, DEX configuration, and recovery methods are excluded from the agent surface.

## Repository layout

```text
agent-vault/
├── AGENTS.md
├── README.md
└── neutron/
    ├── apps/agent_vault/
    │   ├── backend/
    │   ├── public/
    │   ├── scripts/
    │   ├── src/
    │   ├── test/
    │   ├── neutron.json
    │   └── agent_vault.v0.1.0.neutron
    ├── local.ndeploy.json
    └── test/e2e/agent-vault.spec.ts
```

## Build and verify

Run from `neutron/`:

```bash
npm --workspace neutron-agent-vault run package
npm --workspace neutron-agent-vault test
cd apps/agent_vault
../../node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

The package command validates the manifest, builds both frontend entries, packages the Motoko roots, generates method schemas and metadata, and writes `agent_vault.v0.1.0.neutron`.

Current pre-release memory schema v1 hash:

```text
a48ed7297bd53e070f1cf06017ac0e70544403cb218b6d0c7519cee4b5e7689a
```

The schema is still being revised in place because no released package is installed live. After the first release, schema evolution must use a new version and migration rather than editing v1.

## Clean install

Deploy the package into a fresh managed-memory canister for a release or resubmission. Do not upgrade a canister that contains prior demo or test state. After installation, verify that the vault state has no balances, tickets, receipts, or audit entries, then fund only the displayed vault deposit subaccount.
