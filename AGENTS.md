# AGENTS.md: Agent Vault state register

This file is the single source of truth for project state and architectural boundaries. Read it before editing and update it whenever a milestone or architecture decision changes.

## Project

- Product: Agent Vault
- Platform: Neutron on the Internet Computer
- Production root: `neutron/apps/agent_vault/`
- Participant: `AduAkorful`
- Product rule: agents may autonomously settle policy-compliant transfers; every swap requires explicit owner approval.

There is no standalone actor implementation, dfx configuration, or root Mops package. Those reference artifacts were removed on 2026-08-24 so the Neutron application is the only executable product. WS-K's local ledger harness is verification-only and uses real managed ICRC ledgers; it is not production mock data.

## Current milestone state

| Milestone | Status | Evidence |
|---|---|---|
| Neutron backend and managed memory | Complete | Package build succeeds |
| Human dashboard and resident agent service | Complete | Bundle contains dashboard and service entries |
| Token-aware policy and isolated custody | Complete | Per-token limits; deterministic 32-byte vault subaccount |
| Durable transfer reconciliation | Complete | Persisted ledger keys; `#Duplicate` promoted to success |
| Real ICPSwap settlement | Complete | ICRC-2 approval, live pool discovery, swap, withdraw, sweep |
| Permission narrowing | Complete | Exact ledger/factory reservations and minimum pool method scopes |
| Demo/reference removal | Complete | Root standalone source, tests, dfx, and Mops files deleted |
| Verification harness hardening | Partial | Package/Motoko/TypeScript green; live isolated-subaccount approval integration is green; duplicate recovery and full live swap verification remain |

## Architecture decisions

### ADR-001: Three execution tiers

Transfers classify as Autonomous, Escalation, or Forbidden. Autonomous execution requires an allowlisted recipient, a configured token limit, and fee-inclusive hourly/daily capacity. The circuit breaker forbids all actions.

### ADR-002: One Neutron canister, two surfaces

The owner dashboard and resident agent tools call the same Motoko backend through the kernel client. Owner-only methods are not exposed as agent tools.

### ADR-003: Managed-memory v1 is the state source

Persistent state lives in `backend/memory/agentvault/v1.mo`. This pre-release schema may be revised in place only until the first live release. Current hash: `a48ed7297bd53e070f1cf06017ac0e70544403cb218b6d0c7519cee4b5e7689a`.

### ADR-004: Isolated custody

Balances and ordinary debits use `{ owner = shared canister; subaccount = vaultSubaccount }`, where `vaultSubaccount` is a deterministic, non-zero 32-byte app namespace. The default account is not custody storage.

### ADR-005: Token-aware accounting

Spend entries include token principal, amount, and fee. Limits and gauges join by token principal. Decimals and fees are queried from each ledger. Missing token limits fail closed to Escalation.

### ADR-006: Durable staged reconciliation

Each ICRC leg persists a unique memo and `created_at_time` before the await. Recovery replays only the exact ledger intent; `#Duplicate` proves the original committed. Too-old, future, and transport-unknown results remain locked and explicit.

### ADR-007: Swaps always escalate

All non-zero swaps classify as Escalation with `#SwapRequiresApproval`; swaps never settle autonomously. Settlement enforces the configured factory, DEX/pair allowlists, token standards, live fees, quote expiry, slippage, min-return, exact empty transit balances, and exact pool balances.

### ADR-008: ICPSwap custody round trip

ICPSwap keys users by bare principal and therefore uses the shared default account. An approved swap transits isolated vault → default account → pool → default account → isolated vault. Source accounting includes all three input-ledger fees. The receipt's `amountOut` is the exact amount credited back to isolated custody.

### ADR-009: Pool calls are never blindly retried

An unknown `depositFromAndSwap` or withdrawal outcome is reconciled by observing exact pool unused balances and exact default ledger balances. If approval committed but the pool did not consume input, recovery durably revokes the allowance with `expected_allowance`, verifies the exact post-revoke transit balance, and sweeps it home.

### ADR-010: Narrow backend-call authority

Known token ledgers and the ICPSwap factory use exact principal+method reservations. Runtime-discovered pools receive only method-scoped `quote`, `depositFromAndSwap`, `withdraw`, and `getUserUnusedBalance` authority.

### ADR-011: Bounded audit state

Persistent activity retains at most 1,000 entries. The vault-state projection returns the recent 100; paginated history responses are capped at 1,000.

### ADR-012: No demo or fallback product behavior

Clean install defaults contain no balances, token limits, allowlists, tickets, receipts, or audit entries. The UI omits absent tile context and renders unavailable values honestly. The repository has one production implementation and no mock token/DEX fixtures.

## Build and verification

Run from `neutron/`:

```bash
npm --workspace neutron-agent-vault run package
npm --workspace neutron-agent-vault test
```

Run frontend typechecking from `neutron/apps/agent_vault/`:

```bash
../../node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

The package uses `package_mopack.ts` and `scripts/run_memory_test.ts` to invoke the vendored Motoko toolchain under the current Node runtime. Do not replace these with mocked compilation.

## Verified production principals

These principals are already encoded in `neutron.json`; do not add or change financial destinations without independent verification.

- ICP ledger: `ryjl3-tyaaa-aaaaa-aaaba-cai`
- ckBTC ledger: `mxzaz-hqaaa-aaaar-qaada-cai`
- ckUSDC ledger: `xevnm-gaaaa-aaaar-qafnq-cai`
- ICPSwap factory: `4mmnk-kiaaa-aaaag-qbllq-cai`

Pools are always discovered from the factory and never hardcoded.

## Coding boundaries

1. Keep all implementation changes inside this repository.
2. Preserve strict typed Candid results and explicit external errors.
3. Never expose keys or unrestricted signing/call authority.
4. Never hardcode token decimals or fees.
5. Never clear an unknown-outcome settlement lock by guessing.
6. Never retry an unknown ICPSwap pool mutation.
7. Do not introduce demo data, fixture balances, fabricated receipts, placeholder principals, or silent UI fallbacks.
8. Preserve unrelated user changes in the worktree.

## Pending verification work

- Exercise duplicate/recovery behavior and prove no double debit.
- Exercise the real swap lifecycle where the full ICPSwap graph is available.

## 2026-08-24 hardening log

- Added per-token fee-inclusive accounting, safe empty defaults, policy validation, and editable owner policy UI.
- Added deterministic custody subaccount and displayed the exact deposit owner/subaccount.
- Added durable transfer and staged swap intents, ticket-aware recovery, approval revoke/unwind, and exact-balance guards.
- Added real ICRC-2 + ICPSwap settlement and forced all swaps to owner approval.
- Narrowed reservations to exact ledger/factory methods plus four pool method scopes.
- Bounded audit storage and projections.
- Corrected kernel Nat argument encoding to decimal strings.
- Removed the standalone Motoko/dfx/Mops implementation and fixture harness.
- Closed review findings in the settlement state machine: autonomous and approval
  classification now use the live ledger fee, uncertain transfer outcomes keep the
  lock for reconciliation, approval duplicates continue the already-authorized
  swap flow, and staged swap recovery preserves output amounts and withdraw-stage
  provenance.
- Bounded resolved approval-ticket retention while preserving every pending ticket;
  dashboard update calls now unwrap typed backend results before refreshing.
- Current package is approximately 317 KiB and the package, Motoko, and TypeScript gates pass.

### 2026-08-24 WS-K live isolated-custody verification

- Added a PocketIC/Playwright verification lane that installs the canonical managed ckUSDC ledger at its production principal, reads the vault deposit account from `getVaultState`, queries the live ledger fee, funds that exact owner/subaccount, proposes a real escalation transfer, and approves it through the dashboard.
- The live test passed against canister `m6toh-kp777-77775-qaabq-cai`: the recipient increased by exactly the transfer amount, the isolated vault subaccount decreased by amount plus the queried fee, and the shared default account remained unchanged.
- Extended the local fixture client with account-aware balance/funding and live fee queries; these helpers use the real PocketIC ledger and do not inject balances, receipts, or production mutation hooks.
- Replaced Bun-only `import.meta.dir` path resolution in the provisioner modules with `fileURLToPath(import.meta.url)`, so the same source works under Bun and Playwright's Node runner. Provisioner TypeScript and all 271 provisioner tests pass.
