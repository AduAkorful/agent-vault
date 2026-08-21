#!/usr/bin/env bash
# Agent Vault integration scenarios — driven entirely by the handoff JSON that
# run-local.sh (icpswap mode) produces, so this runner is the single place that
# encodes expected vault behavior against the real local ICPSwap graph.
#
#   scenarios.sh [handoff.json]        run every scenario (default handoff: $HANDOFF
#                                      or /tmp/agent-vault-dev-handoff.json)
#   ONLY="1 4" scenarios.sh [handoff]  run only the listed scenario numbers
#
# Exit code is nonzero if any assertion fails. No replica lifecycle here — the
# caller owns start/stop; this only issues `dfx canister call`s and inspects them.
set -uo pipefail

DFX="${DFX:-$HOME/.local/share/dfx/bin/dfx}"
# project root (two levels up from this script) so the upgrade scenario can `dfx canister
# install agent_vault` regardless of the caller's working directory.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
H="${1:-${HANDOFF:-/tmp/agent-vault-dev-handoff.json}}"
[ -f "$H" ] || { echo "handoff not found: $H" >&2; exit 2; }

j() { jq -r ".$1 // empty" "$H"; }
VAULT="$(j vault)"; CONTROLLER="$(j controller)"; AGENT="$(j agent)"; OUTSIDER="$(j outsider)"
ICRC2="$(j icrc2)"; ICRC2B="$(j icrc2b)"; FACTORY="$(j factory)"; POOL="$(j fixturePool)"
FROM="$(j vaultFromToken)"; TO="$(j vaultToToken)"; RECIPIENT="$(j vaultRecipient)"
MAXPERTX="$(j vaultMaxPerTx)"; MAXHOURLY="$(j vaultMaxHourly)"; MAXDAILY="$(j vaultMaxDaily)"
[ -n "$VAULT" ] || { echo "handoff missing vault principal" >&2; exit 2; }

# Identity names the harness provisions. Assert their principals match the handoff so
# a stale handoff fails loudly instead of silently testing the wrong caller.
ID_CONTROLLER="default"; ID_AGENT="av-agent"; ID_OUTSIDER="av-outsider"
check_identity() {
  local name="$1" want="$2" got
  got="$("$DFX" identity get-principal --identity "$name" 2>/dev/null || echo MISSING)"
  [ "$got" = "$want" ] || { echo "identity $name principal $got != handoff $want" >&2; exit 2; }
}

# ---- assertion helpers -------------------------------------------------------
tests=0; fails=0
ok() { tests=$((tests+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
ko() { tests=$((tests+1)); fails=$((fails+1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
has() { case "$1" in *"$2"*) return 0;; *) return 1;; esac; }
snip() { printf '%s' "$1" | tr '\n' ' ' | sed 's/  */ /g' | cut -c1-200; }
assert_has()   { if has "$1" "$2"; then ok "$3"; else ko "$3 -- got: $(snip "$1")"; fi; }
assert_hasnt() { if has "$1" "$2"; then ko "$3 -- unexpectedly matched '$2': $(snip "$1")"; else ok "$3"; fi; }

# vc IDENTITY METHOD ARG  -> stdout is the call result (stderr folded in on trap/reject)
vc() { "$DFX" canister call --identity "$1" "$VAULT" "$2" "${3:-()}" 2>&1; }

# ledger_balance TOKEN OWNER -> integer balance (underscores stripped)
ledger_balance() { "$DFX" canister call "$1" icrc1_balance_of "(record {owner=principal \"$2\"; subaccount=null})" 2>/dev/null | grep -oE '[0-9_]+' | head -1 | tr -d '_'; }

# ticket_id OUTCOME_TEXT -> the nat inside `ticketId = opt (N : nat)` (underscores stripped)
ticket_id() { printf '%s' "$1" | tr '\n' ' ' | sed -n 's/.*ticketId = opt (\([0-9_]*\).*/\1/p' | tr -d '_'; }

# apply_policy [DEXES] [FAILURE_THRESHOLD] [MAXPERTX] [RECIPIENTS] -> (re)apply the canonical
# harness policy, optionally overriding the dex allowlist, failure threshold, per-tx limit, and
# recipient allowlist. consecutiveFailures resets to 0 and the breaker clears. Empty/absent args
# fall back to the harness defaults, so `apply_policy` with no args restores exactly what
# run-local.sh installs. Mirrors run-local.sh's setPolicy — the single source of policy shape.
apply_policy() {
  # brace-free defaults first: a `${1:-vec {...}}` default mis-parses (bash miscounts the nested
  # braces and leaves a spurious trailing `}`), so fill brace-valued defaults the plain way.
  local dexes="${1:-}" ft="${2:-3}" mpt="${3:-$MAXPERTX}" recips="${4:-}"
  [ -n "$dexes" ]  || dexes="vec { principal \"$FACTORY\" }"
  [ -n "$recips" ] || recips="vec { principal \"$RECIPIENT\" }"
  vc "$ID_CONTROLLER" setPolicy "(record {
    limits = record { maxPerTx = $mpt; maxHourlySpend = $MAXHOURLY; maxDailySpend = $MAXDAILY };
    allowlists = record {
      recipients = $recips;
      dexes = $dexes;
      pairs = vec { record { from = principal \"$FROM\"; to = principal \"$TO\" } }
    };
    circuitBreaker = false; failureThreshold = $ft; consecutiveFailures = 0
  })" >/dev/null
}

section() { printf '\n== %s ==\n' "$1"; }

# ---- Scenario 1: authorization & setup --------------------------------------
scen_1_auth() {
  section "Scenario 1: authorization & setup"
  local out
  # Agent-gated reads: agent + controller allowed, outsider rejected.
  out="$(vc "$ID_OUTSIDER" getVaultState)";  assert_has "$out" "Unauthorized" "outsider getVaultState -> Unauthorized"
  out="$(vc "$ID_AGENT" getVaultState)";     assert_has "$out" "dexConfig"    "approved agent getVaultState -> ok"
  out="$(vc "$ID_CONTROLLER" getVaultState)"; assert_has "$out" "dexConfig"   "controller getVaultState -> ok"
  out="$(vc "$ID_OUTSIDER" getPendingApprovals)"; assert_has "$out" "Unauthorized" "outsider getPendingApprovals -> Unauthorized"

  # Agent-gated propose: outsider rejected before any execution.
  out="$(vc "$ID_OUTSIDER" proposeTransfer "(principal \"$FROM\", principal \"$RECIPIENT\", 1, \"x\")")"
  assert_has "$out" "Unauthorized" "outsider proposeTransfer -> Unauthorized"

  # Controller-gated mutations: approved agent is NOT controller -> rejected.
  out="$(vc "$ID_AGENT" setCircuitBreaker "(false)")"; assert_has "$out" "Unauthorized" "agent setCircuitBreaker -> Unauthorized"
  out="$(vc "$ID_OUTSIDER" setPolicy "(record { limits = record { maxPerTx = 1; maxHourlySpend = 1; maxDailySpend = 1 }; allowlists = record { recipients = vec {}; dexes = vec {}; pairs = vec {} }; circuitBreaker = false; failureThreshold = 3; consecutiveFailures = 0 })")"
  assert_has "$out" "Unauthorized" "outsider setPolicy -> Unauthorized"

  # Setup sanity: configured against the LOCAL factory + fee tier, agent enrolled.
  out="$(vc "$ID_CONTROLLER" getVaultState)"
  assert_has "$out" "factory = principal \"$FACTORY\"" "dexConfig points at local factory"
  assert_has "$out" "feeTier = 3_000"                  "dexConfig fee tier 3000"
  assert_has "$out" "$AGENT"                            "approvedAgents contains agent principal"
}

# ---- Scenario 2: real ICRC-1 transfer (autonomous) --------------------------
scen_2_transfer() {
  section "Scenario 2: real ICRC-1 transfer (autonomous)"
  local amt=10000000000 out before after vbefore vafter
  before="$(ledger_balance "$FROM" "$RECIPIENT")"
  vbefore="$(ledger_balance "$FROM" "$VAULT")"
  out="$(vc "$ID_AGENT" proposeTransfer "(principal \"$FROM\", principal \"$RECIPIENT\", $amt, \"scenario2 autonomous transfer\")")"
  assert_has  "$out" "Autonomous" "transfer classified Autonomous"
  assert_has  "$out" "success"    "transfer settled success"
  assert_has  "$out" "blockIndex" "transfer receipt carries real ledger blockIndex"
  assert_hasnt "$out" "failure"   "no failure in settlement"
  after="$(ledger_balance "$FROM" "$RECIPIENT")"
  vafter="$(ledger_balance "$FROM" "$VAULT")"
  # transfer_fee is 0 on the fixture, so movement is exact.
  if [ "$((after - before))" = "$amt" ]; then ok "recipient balance +$amt (real ledger movement)"; else ko "recipient delta $((after-before)) != $amt"; fi
  if [ "$((vbefore - vafter))" = "$amt" ]; then ok "vault balance -$amt"; else ko "vault delta $((vbefore-vafter)) != $amt"; fi
}

# ---- Scenario 3: Tier 2 escalation lifecycle (approve + reject) --------------
# An over-limit transfer classifies as Escalation and parks a pending ticket that only
# the controller can resolve. Approve settles for real; reject closes it with no movement.
scen_3_lifecycle() {
  section "Scenario 3: Tier 2 escalation lifecycle"
  local over=$((MAXPERTX + 10000000000)) out tid before after vbefore vafter

  # -- approve path: over-limit escalates, controller approves, funds move --------
  before="$(ledger_balance "$FROM" "$RECIPIENT")"
  out="$(vc "$ID_AGENT" proposeTransfer "(principal \"$FROM\", principal \"$RECIPIENT\", $over, \"s3 approve probe\")")"
  assert_has "$out" "Escalation"          "over-limit transfer -> Escalation tier"
  assert_has "$out" "PerTransactionLimit" "escalation carries PerTransactionLimit"
  assert_has "$out" "ticketId = opt"      "escalation returns a ticket id"
  tid="$(ticket_id "$out")"
  if [ -n "$tid" ]; then ok "parsed ticket id ($tid)"; else ko "could not parse ticket id: $(snip "$out")"; return; fi

  out="$(vc "$ID_AGENT" getPendingApprovals)"
  assert_has "$out" "s3 approve probe" "pending ticket visible to agent"
  assert_has "$out" "pending"          "ticket status pending"

  out="$(vc "$ID_AGENT" approveTicket "($tid)")";       assert_has "$out" "Unauthorized" "agent cannot approve ticket"
  out="$(vc "$ID_CONTROLLER" approveTicket "($tid)")"
  assert_has  "$out" "success"    "controller approve settles"
  assert_has  "$out" "blockIndex" "approved settlement carries real blockIndex"
  assert_hasnt "$out" "failure"   "no failure on approved settlement"
  after="$(ledger_balance "$FROM" "$RECIPIENT")"
  if [ "$((after - before))" = "$over" ]; then ok "recipient +$over on approval (real movement)"; else ko "recipient delta $((after-before)) != $over"; fi

  out="$(vc "$ID_CONTROLLER" approveTicket "($tid)")";  assert_has "$out" "AlreadyResolved" "re-approve -> AlreadyResolved"
  out="$(vc "$ID_AGENT" getPendingApprovals)";          assert_hasnt "$out" "s3 approve probe" "approved ticket no longer pending"

  # -- reject path: over-limit escalates, controller rejects, no movement ---------
  vbefore="$(ledger_balance "$FROM" "$VAULT")"
  out="$(vc "$ID_AGENT" proposeTransfer "(principal \"$FROM\", principal \"$RECIPIENT\", $over, \"s3 reject probe\")")"
  tid="$(ticket_id "$out")"
  if [ -n "$tid" ]; then ok "reject-path ticket id ($tid)"; else ko "could not parse reject ticket id: $(snip "$out")"; return; fi

  out="$(vc "$ID_AGENT" rejectTicket "($tid, \"nope\")")";              assert_has "$out" "Unauthorized" "agent cannot reject ticket"
  out="$(vc "$ID_CONTROLLER" rejectTicket "($tid, \"over budget\")")";  assert_has "$out" "ok ="          "controller reject accepted"
  out="$(vc "$ID_CONTROLLER" approveTicket "($tid)")";                  assert_has "$out" "AlreadyResolved" "approve after reject -> AlreadyResolved"
  out="$(vc "$ID_AGENT" getPendingApprovals)";                         assert_hasnt "$out" "s3 reject probe" "rejected ticket no longer pending"
  vafter="$(ledger_balance "$FROM" "$VAULT")"
  if [ "$vbefore" = "$vafter" ]; then ok "reject moves no funds (vault balance unchanged)"; else ko "vault balance changed on reject: $vbefore -> $vafter"; fi
}

# ---- Scenario 4: real ICPSwap settlement (autonomous swap) -------------------
# Pre-quote the live pool in the same direction the vault derives, propose a swap inside a
# realistic slippage band, and assert the receipt carries the authoritative synchronous record
# (approvalBlockIndex + amountOut, transactionId null — the pool pushes its swap record only
# after the async withdraw, so no id can be correlated in-call) and that the input token really
# left the vault via depositFromAndSwap.
scen_4_swap() {
  section "Scenario 4: real ICPSwap settlement"
  local amt=10000000000 zfo token0 q Q minret expire out amountOut vbefore vafter
  # ICPSwap sorts the pair by principal (byte order); token0 is the smaller. zeroForOne means
  # swapping token0 -> token1, so it is true iff the vault's fromToken is the sorted token0.
  token0="$(printf '%s\n%s\n' "$FROM" "$TO" | LC_ALL=C sort | head -1)"
  [ "$token0" = "$FROM" ] && zfo=true || zfo=false
  q="$("$DFX" canister call "$POOL" quote "(record { zeroForOne = $zfo; amountIn = \"$amt\"; amountOutMinimum = \"0\" })" 2>&1)"
  Q="$(printf '%s' "$q" | grep -oE '[0-9_]+' | head -1 | tr -d '_')"
  if [[ "$Q" =~ ^[0-9]+$ ]] && [ "$Q" -gt 0 ]; then ok "live pool quote: $amt in -> $Q out (zeroForOne=$zfo)"; else ko "pool quote failed: $(snip "$q")"; return; fi
  minret=$(( Q * 95 / 100 ))
  expire=$(( $(date +%s%N) + 300000000000 ))

  vbefore="$(ledger_balance "$FROM" "$VAULT")"
  out="$(vc "$ID_AGENT" proposeSwap "(principal \"$FROM\", principal \"$TO\", principal \"$FACTORY\", $amt, $minret, 1000, $expire, \"scenario4 real swap\")")"
  assert_has  "$out" "Autonomous"     "swap classified Autonomous"
  assert_has  "$out" "success"        "swap settled success"
  assert_has  "$out" "swap = record"  "receipt is a swap receipt"
  assert_has  "$out" "approvalBlockIndex"  "receipt carries the authoritative approval block index"
  assert_has  "$out" "transactionId = null"  "pool transactionId is null (no synchronous correlation exists)"
  assert_has  "$out" "pool = principal \"$POOL\""    "receipt names the fixture pool"
  assert_has  "$out" "dex = principal \"$FACTORY\""  "receipt names the configured dex"
  assert_hasnt "$out" "failure"       "no failure in swap settlement"
  # amountOut equals the fresh quote (no other trader moves the pool between quote and swap).
  amountOut="$(printf '%s' "$out" | tr '\n' ' ' | sed -n 's/.*amountOut = \([0-9_]*\).*/\1/p' | tr -d '_')"
  if [ "$amountOut" = "$Q" ]; then ok "receipt amountOut ($amountOut) matches live quote"; else ko "amountOut $amountOut != quote $Q"; fi
  vafter="$(ledger_balance "$FROM" "$VAULT")"
  if [ "$((vbefore - vafter))" = "$amt" ]; then ok "vault input balance -$amt (real depositFromAndSwap)"; else ko "vault input delta $((vbefore-vafter)) != $amt"; fi
}

# ---- Scenario 5: swap validation, failure signalling & circuit breaker -------
# Every rejection that fires before ICPSwap touches funds must report partial=false (safe to
# retry) and move nothing; a proposal that trips the failure threshold must arm the breaker.
scen_5_validation() {
  section "Scenario 5: swap validation, failure signalling & circuit breaker"
  local amt=10000000000 Q out vbefore vafter fut
  fut=$(( $(date +%s%N) + 300000000000 ))
  vbefore="$(ledger_balance "$FROM" "$VAULT")"

  # (a) settlement-layer guard rails. Disable the auto-trip and allowlist a decoy dex so each
  #     path is probeable in isolation; all classify Autonomous, then swap() rejects them.
  apply_policy "vec { principal \"$FACTORY\"; principal \"$OUTSIDER\" }" 0
  ok "probing policy applied (failure-threshold off; decoy dex allowlisted)"

  out="$(vc "$ID_AGENT" proposeSwap "(principal \"$FROM\", principal \"$TO\", principal \"$FACTORY\", $amt, 1, 10001, $fut, \"s5 slippage\")")"
  assert_has "$out" "Autonomous"       "over-100% slippage still classifies Autonomous"
  assert_has "$out" "INVALID_SLIPPAGE" "slippageBps>10000 -> INVALID_SLIPPAGE"
  assert_has "$out" "partial = false"  "INVALID_SLIPPAGE: partial=false (nothing at risk)"

  out="$(vc "$ID_AGENT" proposeSwap "(principal \"$FROM\", principal \"$TO\", principal \"$FACTORY\", $amt, 1, 1000, 1, \"s5 expired\")")"
  assert_has "$out" "QUOTE_EXPIRED"   "past quoteExpiresAt -> QUOTE_EXPIRED"
  assert_has "$out" "partial = false" "QUOTE_EXPIRED: partial=false"

  # decoy dex passes the policy allowlist but is not the configured factory
  out="$(vc "$ID_AGENT" proposeSwap "(principal \"$FROM\", principal \"$TO\", principal \"$OUTSIDER\", $amt, 1, 1000, $fut, \"s5 wrong dex\")")"
  assert_has "$out" "DEX_NOT_CONFIGURED" "allowlisted non-factory dex -> DEX_NOT_CONFIGURED"
  assert_has "$out" "partial = false"    "DEX_NOT_CONFIGURED: partial=false"

  Q="$("$DFX" canister call "$POOL" quote "(record { zeroForOne = false; amountIn = \"$amt\"; amountOutMinimum = \"0\" })" 2>&1 | grep -oE '[0-9_]+' | head -1 | tr -d '_')"
  out="$(vc "$ID_AGENT" proposeSwap "(principal \"$FROM\", principal \"$TO\", principal \"$FACTORY\", $amt, $((Q * 2)), 1000, $fut, \"s5 minret high\")")"
  assert_has "$out" "INVALID_MIN_RETURN" "minReturn>quote -> INVALID_MIN_RETURN"
  out="$(vc "$ID_AGENT" proposeSwap "(principal \"$FROM\", principal \"$TO\", principal \"$FACTORY\", $amt, 1, 1000, $fut, \"s5 minret low\")")"
  assert_has "$out" "INVALID_MIN_RETURN" "minReturn<slippage floor -> INVALID_MIN_RETURN"

  # (b) policy-layer Forbidden: a zero amount never reaches settlement and parks no ticket.
  out="$(vc "$ID_AGENT" proposeSwap "(principal \"$FROM\", principal \"$TO\", principal \"$FACTORY\", 0, 1, 1000, $fut, \"s5 zero\")")"
  assert_has "$out" "Forbidden"          "amount=0 -> Forbidden"
  assert_has "$out" "InvalidAmount"      "amount=0 -> InvalidAmount"
  assert_has "$out" "settlement = null"  "Forbidden proposal never settles"

  # (c) invariant: not one of those rejections moved a unit of the input token.
  vafter="$(ledger_balance "$FROM" "$VAULT")"
  if [ "$vbefore" = "$vafter" ]; then ok "no rejection moved funds (vault balance intact: $vbefore)"; else ko "vault balance changed across rejections: $vbefore -> $vafter"; fi

  # (d) failure-threshold circuit breaker: three consecutive settlement failures arm it.
  apply_policy "vec { principal \"$FACTORY\" }" 3
  vc "$ID_AGENT" proposeSwap "(principal \"$FROM\", principal \"$TO\", principal \"$FACTORY\", $amt, 1, 10001, $fut, \"s5 cb1\")" >/dev/null
  vc "$ID_AGENT" proposeSwap "(principal \"$FROM\", principal \"$TO\", principal \"$FACTORY\", $amt, 1, 10001, $fut, \"s5 cb2\")" >/dev/null
  out="$(vc "$ID_AGENT" proposeSwap "(principal \"$FROM\", principal \"$TO\", principal \"$FACTORY\", $amt, 1, 10001, $fut, \"s5 cb3\")")"
  assert_has "$out" "INVALID_SLIPPAGE" "the tripping failure still returns its own error"
  out="$(vc "$ID_CONTROLLER" getVaultState)"
  assert_has "$out" "circuitBreaker = true" "3 consecutive failures trip the circuit breaker"
  out="$(vc "$ID_AGENT" proposeTransfer "(principal \"$FROM\", principal \"$RECIPIENT\", 1, \"s5 blocked\")")"
  assert_has "$out" "CircuitBreakerActive" "tripped breaker forbids an otherwise-valid transfer"

  # (e) restore the canonical harness policy so subsequent runs start clean.
  apply_policy
  out="$(vc "$ID_CONTROLLER" getVaultState)"
  assert_has "$out" "circuitBreaker = false"   "policy reset clears the breaker"
  assert_has "$out" "consecutiveFailures = 0 " "policy reset zeroes the failure counter"
}

# ---- Scenario 6: policy invalidation of pending tickets ----------------------
# A parked escalation ticket is re-classified against the CURRENT policy at approval time
# (Main.mo approveTicket). Mutating policy while a ticket sits pending must make approval
# refuse — never settle stale intent — across all three re-classification branches:
# tier->Forbidden (breaker), tier->Autonomous (limit raised), escalation reason changed.
scen_6_invalidation() {
  section "Scenario 6: policy invalidation of pending tickets"
  local over=$((MAXPERTX + 10000000000)) out tid vbefore vafter

  # -- branch 1: raising maxPerTx above the amount makes it autonomous -> no longer a valid
  #    escalation, so approval is refused (AlreadyResolved) and the agent must re-propose. --
  out="$(vc "$ID_AGENT" proposeTransfer "(principal \"$FROM\", principal \"$RECIPIENT\", $over, \"s6 raise-limit\")")"
  assert_has "$out" "PerTransactionLimit" "over-limit transfer parks a PerTransactionLimit ticket"
  tid="$(ticket_id "$out")"
  if [ -n "$tid" ]; then ok "parked ticket id ($tid)"; else ko "no ticket id: $(snip "$out")"; return; fi
  apply_policy "" 3 "$((over * 2))"   # raise per-tx limit above the parked amount
  out="$(vc "$ID_CONTROLLER" approveTicket "($tid)")"
  assert_has "$out" "AlreadyResolved" "amount now within raised limit -> approve refuses (AlreadyResolved)"
  out="$(vc "$ID_AGENT" getPendingApprovals)"
  assert_has "$out" "s6 raise-limit" "invalidated ticket stays pending (never silently settled)"
  vc "$ID_CONTROLLER" rejectTicket "($tid, \"superseded by limit change\")" >/dev/null
  apply_policy   # restore canonical limit/recipient

  # -- branch 2: dropping the recipient from the allowlist changes the escalation reason;
  #    reclassification yields RecipientNotAllowed (checked before the per-tx limit), and
  #    approve returns that NEW error rather than settling the outdated PerTransactionLimit. --
  out="$(vc "$ID_AGENT" proposeTransfer "(principal \"$FROM\", principal \"$RECIPIENT\", $over, \"s6 drop-recipient\")")"
  tid="$(ticket_id "$out")"
  if [ -n "$tid" ]; then ok "parked ticket id ($tid)"; else ko "no ticket id: $(snip "$out")"; return; fi
  apply_policy "" 3 "$MAXPERTX" "vec {}"   # empty recipient allowlist
  out="$(vc "$ID_CONTROLLER" approveTicket "($tid)")"
  assert_has "$out" "RecipientNotAllowed" "shifted escalation reason blocks approval with the new error"
  assert_hasnt "$out" "success"           "ticket with changed justification does not settle"
  vc "$ID_CONTROLLER" rejectTicket "($tid, \"recipient de-listed\")" >/dev/null
  apply_policy   # restore recipient allowlist

  # -- branch 3: an active circuit breaker forbids approval outright; once cleared, the SAME
  #    unchanged ticket re-classifies to its original escalation and settles for real. -------
  out="$(vc "$ID_AGENT" proposeTransfer "(principal \"$FROM\", principal \"$RECIPIENT\", $over, \"s6 breaker\")")"
  tid="$(ticket_id "$out")"
  if [ -n "$tid" ]; then ok "parked ticket id ($tid)"; else ko "no ticket id: $(snip "$out")"; return; fi
  vc "$ID_CONTROLLER" setCircuitBreaker "(true)" >/dev/null
  out="$(vc "$ID_CONTROLLER" approveTicket "($tid)")"
  assert_has "$out" "CircuitBreakerActive" "active breaker forbids approving a pending ticket"
  out="$(vc "$ID_AGENT" getPendingApprovals)"
  assert_has "$out" "s6 breaker" "breaker-blocked ticket remains pending"
  vc "$ID_CONTROLLER" setCircuitBreaker "(false)" >/dev/null
  vbefore="$(ledger_balance "$FROM" "$RECIPIENT")"
  out="$(vc "$ID_CONTROLLER" approveTicket "($tid)")"
  assert_has  "$out" "success"    "breaker cleared -> the same unchanged ticket approves and settles"
  assert_hasnt "$out" "failure"   "no failure on the post-breaker approval"
  vafter="$(ledger_balance "$FROM" "$RECIPIENT")"
  if [ "$((vafter - vbefore))" = "$over" ]; then ok "approved ticket moved $over (real ledger movement)"; else ko "recipient delta $((vafter-vbefore)) != $over"; fi
  apply_policy   # leave the shared policy canonical for later scenarios/runs
}

# ---- Scenario 7: settlement lock (release invariant + recovery) --------------
# The vault serializes settlement behind settlementInFlight/settlementLock. The safety property
# that actually protects liveness is that the lock is ALWAYS released once settle returns —
# success or failure — so it can never leak and freeze the vault. That, plus controller-only
# recovery and the idle steady state, is deterministic and asserted here.
#
# The two concurrency-only branches — SettlementInFlight (a proposal refused while another
# settlement is mid-flight) and SettlementLockNotStale (force-recovering a still-fresh lock) —
# require observing the lock WHILE held. On this single-node local replica that is not reachable:
# the lock is held only for the sub-second on-chain settlement window and no externally-submitted
# ingress interleaves within it (verified empirically — competing update calls and in-flight
# queries never observe the held lock). Those async-safety branches are covered by code review of
# Main.mo (proposeAction / approveTicket / recoverSettlementLock); the pure Engine unit tests
# model classification/ticketing but not the async lock boundary.
scen_7_lock() {
  section "Scenario 7: settlement lock (release invariant + recovery)"
  local amt=10000000000 zfo token0 Q minret expire out state

  # recovery is controller-only.
  out="$(vc "$ID_AGENT" recoverSettlementLock)";    assert_has "$out" "Unauthorized" "agent cannot recoverSettlementLock"
  out="$(vc "$ID_OUTSIDER" recoverSettlementLock)"; assert_has "$out" "Unauthorized" "outsider cannot recoverSettlementLock"

  # idle steady state: nothing is locked before we settle anything.
  state="$(vc "$ID_CONTROLLER" getVaultState)"
  assert_has "$state" "settlementInFlight = false" "lock idle in steady state"
  assert_has "$state" "settlementLock = null"      "no lock recorded in steady state"

  # release-after-SUCCESS: a completed swap must leave the lock released (no leak).
  token0="$(printf '%s\n%s\n' "$FROM" "$TO" | LC_ALL=C sort | head -1)"
  [ "$token0" = "$FROM" ] && zfo=true || zfo=false
  Q="$("$DFX" canister call "$POOL" quote "(record { zeroForOne = $zfo; amountIn = \"$amt\"; amountOutMinimum = \"0\" })" 2>&1 | grep -oE '[0-9_]+' | head -1 | tr -d '_')"
  minret=$(( Q * 95 / 100 )); expire=$(( $(date +%s%N) + 300000000000 ))
  out="$(vc "$ID_AGENT" proposeSwap "(principal \"$FROM\", principal \"$TO\", principal \"$FACTORY\", $amt, $minret, 1000, $expire, \"s7 success settle\")")"
  assert_has "$out" "success" "swap settled (success path)"
  state="$(vc "$ID_CONTROLLER" getVaultState)"
  assert_has "$state" "settlementInFlight = false" "lock released after a successful settlement"
  assert_has "$state" "settlementLock = null"      "lock cleared after a successful settlement"

  # release-after-FAILURE: a settlement that fails inside swap() must also release the lock —
  # Main.mo clears settlementInFlight/settlementLock unconditionally after `await settle`, before
  # it branches on the success/failure outcome, so a failing settlement cannot wedge the vault.
  expire=$(( $(date +%s%N) + 300000000000 ))
  out="$(vc "$ID_AGENT" proposeSwap "(principal \"$FROM\", principal \"$TO\", principal \"$FACTORY\", $amt, 1, 10001, $expire, \"s7 fail settle\")")"
  assert_has "$out" "INVALID_SLIPPAGE" "swap settled to a failure (INVALID_SLIPPAGE)"
  state="$(vc "$ID_CONTROLLER" getVaultState)"
  assert_has "$state" "settlementInFlight = false" "lock released after a failed settlement (no leak)"
  assert_has "$state" "settlementLock = null"      "lock cleared after a failed settlement"

  # no-op recovery: with nothing locked, recovery hits the `case null` branch and returns ok.
  out="$(vc "$ID_CONTROLLER" recoverSettlementLock)"; assert_has "$out" "variant { ok }" "no-op recovery with nothing locked -> ok"

  apply_policy   # the failing probe bumped consecutiveFailures; reset to leave state canonical
}

# ---- Scenario 8: upgrade compatibility (state preservation + settlement) -----
# A real `dfx canister install --mode upgrade` runs the pre/post-upgrade hooks and serializes
# then deserializes every stable variable. This validates that the vault's stable state — policy,
# dexConfig, approved agents, synced balances, audit history, and an in-flight escalation ticket —
# survives that cycle intact, and that the upgraded actor can still settle end to end against the
# real ICPSwap ledgers. --upgrade-unchanged forces the genuine upgrade path even though the module
# is byte-identical here; the actor class takes owner:Principal, so the original init arg repeats.
scen_8_upgrade() {
  section "Scenario 8: upgrade compatibility"
  local over=$((MAXPERTX + 10000000000)) out tid up rc pre_audit post_audit before after

  # park a pending escalation ticket that must survive the upgrade and remain approvable.
  out="$(vc "$ID_AGENT" proposeTransfer "(principal \"$FROM\", principal \"$RECIPIENT\", $over, \"s8 pre-upgrade ticket\")")"
  assert_has "$out" "PerTransactionLimit" "pre-upgrade over-limit transfer parks a ticket"
  tid="$(ticket_id "$out")"
  if [ -n "$tid" ]; then ok "parked pre-upgrade ticket ($tid)"; else ko "no ticket id: $(snip "$out")"; return; fi
  pre_audit="$(vc "$ID_AGENT" getActivityHistory "(100000, 0)" | grep -o 'note =' | wc -l)"

  # force a genuine in-place upgrade (byte-identical module still runs hooks + stable (de)serialize).
  up="$(cd "$ROOT_DIR" && "$DFX" canister install agent_vault --mode upgrade --upgrade-unchanged --yes --argument "(principal \"$CONTROLLER\")" 2>&1)"; rc=$?
  if [ "$rc" = 0 ] && has "$up" "Upgrading code"; then ok "canister upgraded in place (--mode upgrade)"; else ko "upgrade failed (rc=$rc): $(snip "$up")"; return; fi

  # stable state must survive the serialize/deserialize cycle unchanged.
  out="$(vc "$ID_CONTROLLER" getVaultState)"
  assert_has "$out" "maxPerTx = 50_000_000_000"        "policy limits preserved across upgrade"
  assert_has "$out" "failureThreshold = 3"             "failure threshold preserved across upgrade"
  assert_has "$out" "factory = principal \"$FACTORY\"" "dexConfig factory preserved across upgrade"
  assert_has "$out" "feeTier = 3_000"                  "dexConfig fee tier preserved across upgrade"
  assert_has "$out" "$AGENT"                            "approved agents preserved across upgrade"
  assert_has "$out" "standard = \"ICRC2\""             "synced balances preserved across upgrade"
  post_audit="$(vc "$ID_AGENT" getActivityHistory "(100000, 0)" | grep -o 'note =' | wc -l)"
  if [ "$post_audit" = "$pre_audit" ]; then ok "audit history preserved exactly ($post_audit entries)"; else ko "audit count changed across upgrade: $pre_audit -> $post_audit"; fi
  out="$(vc "$ID_AGENT" getPendingApprovals)"
  assert_has "$out" "s8 pre-upgrade ticket" "pending ticket survived the upgrade"
  assert_has "$out" "pending"               "surviving ticket still pending after upgrade"

  # post-upgrade settlement: the surviving ticket approves and settles for real against the ICPSwap
  # ledgers, proving the upgraded actor's inter-canister settlement path still works end to end.
  before="$(ledger_balance "$FROM" "$RECIPIENT")"
  out="$(vc "$ID_CONTROLLER" approveTicket "($tid)")"
  assert_has  "$out" "success"  "post-upgrade approval settles the surviving ticket"
  assert_hasnt "$out" "failure" "no failure on post-upgrade settlement"
  after="$(ledger_balance "$FROM" "$RECIPIENT")"
  if [ "$((after - before))" = "$over" ]; then ok "post-upgrade settlement moved $over (real ledger movement)"; else ko "recipient delta $((after-before)) != $over"; fi
}

# ---- runner ------------------------------------------------------------------
check_identity "$ID_CONTROLLER" "$CONTROLLER"
check_identity "$ID_AGENT" "$AGENT"
check_identity "$ID_OUTSIDER" "$OUTSIDER"

ALL="1 2 3 4 5 6 7 8"
for n in ${ONLY:-$ALL}; do
  case "$n" in
    1) scen_1_auth ;;
    2) scen_2_transfer ;;
    3) scen_3_lifecycle ;;
    4) scen_4_swap ;;
    5) scen_5_validation ;;
    6) scen_6_invalidation ;;
    7) scen_7_lock ;;
    8) scen_8_upgrade ;;
    *) echo "unknown scenario: $n" >&2 ;;
  esac
done

printf '\n---- %d assertions, %d failed ----\n' "$tests" "$fails"
[ "$fails" -eq 0 ] || exit 1
