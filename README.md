# Agent Vault

> Sovereign Financial Execution & Policy Guardrail Environment for AI Agents on Neutron (Internet Computer).

---

## Overview
**Agent Vault** enables autonomous AI agents to execute financial transactions (transfers, DCA, swaps, rebalancing) within user-controlled Neutron canisters under strict, programmable on-chain safety policies.

### Key Features
- **Sovereign Custody**: Balances (ICP, ckBTC, ckETH, ICRC-1 tokens) remain under the user's sovereign control inside their Neutron canister.
- **Programmable Policy Engine**: Mathematical velocity limits (per-tx, hourly, daily rolling caps) and whitelist constraints.
- **Dual Surface Architecture**:
  - **For Humans**: Web UI with real-time portfolio analytics, policy controls, pending approvals inbox, and live agent reasoning logs.
  - **For AI Agents**: Narrow, strictly-typed Neutron tool interfaces (`proposeTransfer`, `proposeSwap`, `getVaultState`, `getActivityHistory`).
- **Multi-Tier Execution**:
  - *Tier 1 (Autonomous)*: Instant execution within safe bounds.
  - *Tier 2 (Escalation)*: Queued for 1-click human biometric/II confirmation.
  - *Tier 3 (Forbidden)*: Hard rejection and immediate anomaly alert.

---

## Project Structure
- [`plans/HACKATHON.md`](./plans/HACKATHON.md): Complete Neutron Hackathon details, rules, schedules, and limits.
- [`plans/SPEC.md`](./plans/SPEC.md): Comprehensive product and architectural specification.
- [`AGENTS.md`](./AGENTS.md): Living agent checkpoint file, state register, and architecture decision register (ADR).

The milestone roadmap is maintained directly in the progress tracker within [`AGENTS.md`](./AGENTS.md).

## Backend Development

The M2 scaffold uses [Mops](https://mops.one/) for dependency resolution and tests, and `dfx` for canister builds.

```bash
mops install
mops test
dfx build agent_vault
```

M3 adds typed agent/controller endpoints and a real settlement boundary. Transfer settlement uses live ICRC-1 calls from the vault-owned account; balances are refreshed with `syncBalance`. ICPSwap integration is pinned to the maintained ICPSwap docs flow (`getPool` at `4mmnk-kiaaa-aaaag-qbllq-cai`, quote, ICRC-2 approval, and `depositFromAndSwap`). No synthetic balances or receipts are produced. Local policy tests remain deterministic; settlement integration tests must use real local canisters.

The ICPSwap source revisions reviewed for the adapter were `icpswap-v3-service@94eeb92ad6ecc2713d38fd3bef48cd4f328a3513` and `docs@c58bcd73c9c33dc07668fe7f9f9cafd11c0dbe53`.

## Local integration verification

Install `dfx` 0.24.3, then run either of the two real-canister gates:

```bash
test/integration/run-local.sh smoke     # clean vault deploy + surface check
test/integration/run-local.sh icpswap   # full managed ICPSwap settlement lifecycle
```

`smoke` starts a clean local replica, builds and deploys Agent Vault, checks the pinned
ICPSwap sources, and confirms the controller can read vault state. `icpswap` runs the full
release-validation lifecycle on one shared replica: it stands up the complete pinned ICPSwap V3
graph plus two ICRC-2 token fixtures, creates a real fee-tier-3000 pool with seeded liquidity,
deploys and configures the vault against it (`setDexConfig`/`setPolicy`/`setApprovedAgents`, real
ledger funding, `syncBalance`), and then runs the eight-group settlement scenario suite
(`test/integration/scenarios.sh`) — currently 104 assertions, all against genuine canisters.
All ICPSwap-generated dfx state is isolated under `/tmp/agent-vault-icpswap-v3-service`; the
Agent Vault root `dfx.json` is never modified, and the replica and checkout are always torn down
on exit. See [`test/integration/README.md`](./test/integration/README.md) for the scenario matrix
and the non-obvious behaviors the suite encodes.

---

## Participant Info
- **Handle**: `AduAkorful`
- **Hackathon**: [Neutron Hackathon](https://4576f-3aaaa-aaaam-ajgpq-cai.icp0.io)
