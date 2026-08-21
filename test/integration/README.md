# M3 Local Integration — Real-Canister Release Validation

This lane exercises Agent Vault against **real local canisters**. Nothing is mocked:
ledger balances, ICRC-1 transfer receipts, ICPSwap quotes, and `depositFromAndSwap`
settlements are all produced by genuine canisters on a local replica.

## Prerequisites

- `dfx` 0.24.3 (`~/.local/share/dfx/bin/dfx`)
- `vessel` (`~/.local/bin/vessel`) — ICPSwap builds with `vessel sources`
- `mops` / `npx --yes ic-mops`
- `jq`, `git`, and network access to the pinned ICPSwap repositories

## Two modes

```bash
test/integration/run-local.sh smoke     # default: clean vault deploy + surface check
test/integration/run-local.sh icpswap   # managed lifecycle: graph + fixtures + settlement suite
```

### `smoke`
Starts a clean replica, builds and deploys Agent Vault, and asserts the controller
can read `getVaultState`. Fast gate for "does the vault build and stand up". Also
verifies the pinned ICPSwap source revisions are checked out.

### `icpswap`
The full managed release-validation lifecycle, all on **one shared replica**:

1. Check out the pinned ICPSwap service + docs commits (isolated to `$ICPSWAP_DIR`).
2. Stand up the complete ICPSwap V3 graph (factory, installer, position index, fee
   receiver, passcode manager, backup, trusted-canister manager) plus two ICRC-2
   token fixtures.
3. Create a real fee-tier-3000 pool for the fixture pair and seed full-range liquidity
   with genuine ledger calls.
4. Deploy Agent Vault onto the same replica and configure it: `setDexConfig` (local
   factory + fee tier 3000), `setPolicy` (allowlisted pair/recipient, spend limits),
   `setApprovedAgents`, real ledger funding of the vault-owned account, pool-admin
   rights, and a `syncBalance` confirmation.
5. Run the settlement scenario suite (`scenarios.sh`) against the provisioned graph.

The suite exits nonzero on the first failed assertion; under `set -e` that aborts the
lifecycle and the `EXIT` trap stops the replica and restores the isolated checkout — so
there is no green run without green tests.

### Isolation guarantees

- All ICPSwap-generated dfx state lives under `$ICPSWAP_DIR`
  (`/tmp/agent-vault-icpswap-v3-service`); the Agent Vault root `dfx.json` is never
  touched. The ICPSwap `dfx.json` is rewritten to omit a `networks` block so its `local`
  network resolves to the same `127.0.0.1:4943` replica the vault uses.
- The handoff file (principals, ledger fees/funded amounts, replica port, commit ids) is
  written under a `mktemp` dir and removed on exit. It is never tracked.
- The replica is always stopped and the checkout restored via the `EXIT` trap.

## The scenario suite

`scenarios.sh` is driven entirely by the handoff JSON, so it is the single place that
encodes expected vault behavior against the real graph. It is invoked automatically by
`run-local.sh icpswap`, and can also be run standalone against a live handoff:

```bash
# run every scenario against a handoff file
HANDOFF=/path/to/handoff.json bash test/integration/scenarios.sh

# run only specific scenarios (space-separated numbers)
HANDOFF=/path/to/handoff.json ONLY="4 8" bash test/integration/scenarios.sh
```

Exit code is nonzero if any assertion fails. `scenarios.sh` owns no replica lifecycle —
the caller starts/stops the replica; the suite only issues `dfx canister call`s and
inspects the Candid they return.

| # | Group | What it proves (all against real canisters) |
|---|-------|---------------------------------------------|
| 1 | Authorization & setup | outsider/agent/controller access matrix; dexConfig + approved-agent state |
| 2 | Real ICRC-1 transfer | autonomous transfer settles; recipient/vault balances move by the exact amount |
| 3 | Tier-2 escalation lifecycle | over-limit parks a ticket; controller approve settles (real block index); reject/`AlreadyResolved` paths |
| 4 | Real ICPSwap settlement | live pool quote → autonomous swap → authoritative receipt (`approvalBlockIndex` + `amountOut` equal to the pre-quote, `transactionId` null); vault input debited by the exact amount via `depositFromAndSwap` |
| 5 | Validation & failure signalling | `INVALID_SLIPPAGE`/`QUOTE_EXPIRED`/`DEX_NOT_CONFIGURED`/`INVALID_MIN_RETURN` (all `partial=false`); `amount=0` Forbidden; no funds move on rejection; failure-threshold circuit breaker trips |
| 6 | Policy invalidation of pending tickets | raised limit → `AlreadyResolved`; shifted escalation reason → the new error; active breaker → `CircuitBreakerActive`; cleared → the same ticket settles |
| 7 | Settlement lock | authorization on `recoverSettlementLock`; idle state; lock **released** after both success and failure; no-op recovery |
| 8 | Upgrade compatibility | forced in-place upgrade preserves policy/dexConfig/agents/balances/audit/pending ticket; the survivor settles for real post-upgrade |

## Development loop (KEEP_UP)

The ICPSwap graph is a ~2–3 minute build. `KEEP_UP=1` leaves the replica, checkout, and
handoff intact after provisioning so you can iterate on scenarios in seconds
(`dfx canister call` round-trips) instead of rebuilding the graph each time:

```bash
KEEP_UP=1 test/integration/run-local.sh icpswap        # provision once, leave it up
HANDOFF=/tmp/.../handoff.json ONLY=6 bash test/integration/scenarios.sh   # iterate
```

The next non-`KEEP_UP` run self-heals via `dfx start --clean` + checkout restore.

## Findings that shaped these tests

These are non-obvious behaviors discovered while validating against the real graph. They
are encoded as assertions and/or documented here so future changes don't silently regress
or misread them.

- **ICRC-2 ⊇ ICRC-1.** The fixture tokens advertise only `"ICRC-2"` in
  `icrc1_supported_standards`. Because ICRC-2 is a strict superset of ICRC-1, the vault's
  `supportsICRC1` helper accepts either tag; a token that claims ICRC-2 without honoring
  ICRC-1 still fails safely at the actual ledger call with a typed error.

- **A successful ICPSwap swap has no synchronous transaction id.** `depositFromAndSwap`
  returning `#ok(amountOut)` is the authoritative settlement signal — the input was pulled and
  the swap executed. But the pool does *not* write its terminal `OneStepSwap` record when that
  call returns: it enqueues the output withdrawal and pushes the record to its sync buffer only
  when the withdraw-queue timer fires, after the call has already returned. An early version
  scanned `getPendingSyncData(?20)` for that record and returned `RECEIPT_UNAVAILABLE` when it
  was absent — which failed *every* swap on a fresh pool, while on a reused (`KEEP_UP`) pool it
  matched a **stale** id from a prior swap and passed spuriously. `getPendingSyncData` returns
  oldest-first and is drained only by an admin call, so it is the wrong tool for a caller to
  look up its own recent tx. The vault now records the synchronous authoritative fields
  (`amountOut` + the approval block index) and leaves `transactionId : ?Nat` null. Scenario 4
  asserts exactly that shape, so a regression to a fabricated or stale id fails the gate.

- **The transfer recipient is deliberately not the controller.** On the fixture ledger the
  minting account is the controller principal, and an ICRC-1 transfer *to* the minter is a
  burn (tokens leave the vault but no account is credited). The harness provisions a
  separate `av-recipient` identity so the "recipient balance increased by exactly N"
  assertions are actually testable.

- **The settlement lock is not externally observable on a single-node local replica.** A
  swap round-trips in ~1.1 s; queries never catch the pre-`await` in-flight window and
  externally-submitted competing update calls don't interleave into it. So `SettlementInFlight`
  (concurrent rejection) and `SettlementLockNotStale` are defensive async-safety branches,
  verified by code review rather than a flaky live probe. Scenario 7 instead asserts the
  **deterministic release invariant** — the lock is cleared after both the success and the
  failure settlement paths — which is the property that actually prevents a frozen vault.

- **Forcing a genuine upgrade.** `dfx canister install --mode upgrade` short-circuits with
  "Module hash is already installed" when the wasm is unchanged, skipping the real upgrade
  path. Scenario 8 passes `--upgrade-unchanged` to force the pre/post hooks and the stable
  serialize/deserialize cycle. The actor class takes `owner : Principal`, so the upgrade
  also requires `--argument "(principal \"$CONTROLLER\")"`; omitting it fails with "Expected
  arguments but found none."

- **Candid rendering gotchas the assertions account for.** `#ok(())` renders as
  `(variant { ok })` — a unit payload with no `= value`. And `dfx` prints a whole `vec` on
  a single line, so audit-entry counts are taken with `grep -o 'note =' | wc -l`
  (occurrences), not `grep -c` (matching lines, which would always be 1).
