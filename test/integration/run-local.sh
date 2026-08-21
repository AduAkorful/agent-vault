#!/usr/bin/env bash
set -euo pipefail

# Agent Vault local integration harness.
#
#   run-local.sh smoke     clean Agent Vault deploy + surface check (default)
#   run-local.sh icpswap   managed ICPSwap graph + real-canister settlement suite
#
# All ICPSwap-generated dfx state is isolated to $ICPSWAP_DIR; the Agent Vault
# root config is never modified. An ephemeral machine-readable handoff file is
# written under a mktemp dir and removed on exit. The replica is always stopped
# and the isolated checkout restored via the EXIT trap.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DFX_BIN="${DFX_BIN:-$HOME/.local/share/dfx/bin/dfx}"
VESSEL_BIN="${VESSEL_BIN:-$HOME/.local/bin/vessel}"
ICPSWAP_COMMIT="94eeb92ad6ecc2713d38fd3bef48cd4f328a3513"
ICPSWAP_DOCS_COMMIT="c58bcd73c9c33dc07668fe7f9f9cafd11c0dbe53"
ICPSWAP_DIR="${ICPSWAP_DIR:-/tmp/agent-vault-icpswap-v3-service}"
ICPSWAP_DOCS_DIR="${ICPSWAP_DOCS_DIR:-/tmp/agent-vault-icpswap-docs}"
ICPSWAP_REPO="https://github.com/ICPSwap-Labs/icpswap-v3-service.git"
ICPSWAP_DOCS_REPO="https://github.com/ICPSwap-Labs/docs.git"
DOCUMENTED_FACTORY="4mmnk-kiaaa-aaaag-qbllq-cai"

MODE="${1:-smoke}"
case "$MODE" in
  smoke|icpswap) ;;
  *) echo "usage: $0 [smoke|icpswap]" >&2; exit 2 ;;
esac

CLEAN_ICPSWAP=0
HANDOFF_DIR=""

die() { echo "ERROR: $*" >&2; exit 1; }

cleanup() {
  local rc=$?
  # KEEP_UP=1 leaves the replica, ICPSwap checkout, and handoff intact so the
  # multi-canister graph (a ~2-3 min build) can be reused across iterations.
  # The next non-KEEP_UP run self-heals via `dfx start --clean` + checkout restore.
  if [ "${KEEP_UP:-0}" = "1" ]; then
    echo "[keep-up] replica + ICPSwap graph left running; handoff at ${HANDOFF:-<none>}" >&2
    return $rc
  fi
  "$DFX_BIN" stop >/dev/null 2>&1 || true
  if [ "$CLEAN_ICPSWAP" = "1" ] && [ -d "$ICPSWAP_DIR/.git" ]; then
    git -C "$ICPSWAP_DIR" checkout -- dfx.json package-set.dhall 2>/dev/null || true
    rm -rf "$ICPSWAP_DIR/.dfx"
  fi
  [ -n "$HANDOFF_DIR" ] && rm -rf "$HANDOFF_DIR"
  return $rc
}
trap cleanup EXIT

ensure_checkout() {
  local dir="$1" repo="$2" commit="$3"
  if [ ! -d "$dir/.git" ]; then
    git clone "$repo" "$dir"
  fi
  if [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null || echo none)" != "$commit" ]; then
    git -C "$dir" fetch --quiet --depth 1 origin "$commit"
    git -C "$dir" checkout --quiet "$commit"
  fi
}

hs_put() {
  local key="$1" value="$2" tmp
  tmp="$(jq --arg k "$key" --arg v "$value" '.[$k]=$v' "$HANDOFF")"
  printf '%s\n' "$tmp" > "$HANDOFF"
}

hs_init() {
  HANDOFF_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-vault-handoff.XXXXXX")"
  HANDOFF="$HANDOFF_DIR/handoff.json"
  printf '{}\n' > "$HANDOFF"
  export HANDOFF
  hs_put mode "$MODE"
  hs_put icpswapCommit "$ICPSWAP_COMMIT"
  hs_put icpswapDocsCommit "$ICPSWAP_DOCS_COMMIT"
  hs_put replicaPort "$($DFX_BIN info webserver-port 2>/dev/null || echo unknown)"
}

run_smoke() {
  ensure_checkout "$ICPSWAP_DIR" "$ICPSWAP_REPO" "$ICPSWAP_COMMIT"
  ensure_checkout "$ICPSWAP_DOCS_DIR" "$ICPSWAP_DOCS_REPO" "$ICPSWAP_DOCS_COMMIT"
  cd "$ROOT_DIR"

  "$DFX_BIN" stop >/dev/null 2>&1 || true
  "$DFX_BIN" start --clean --background
  hs_init

  "$DFX_BIN" canister create agent_vault >/dev/null 2>&1 || true
  "$DFX_BIN" build agent_vault
  local controller
  controller="$($DFX_BIN identity get-principal)"
  "$DFX_BIN" deploy agent_vault --argument "(principal \"$controller\")" >/dev/null
  local vault
  vault="$($DFX_BIN canister id agent_vault)"
  hs_put controller "$controller"
  hs_put agent "$controller"
  hs_put vault "$vault"

  local state
  state="$($DFX_BIN canister call agent_vault getVaultState "()")"
  if echo "$state" | grep -qF "err = variant { Unauthorized"; then
    die "controller smoke check failed"
  fi

  echo "Agent Vault deployed against local replica."
  echo "ICPSwap service: $ICPSWAP_COMMIT"
  echo "ICPSwap docs: $ICPSWAP_DOCS_COMMIT"
  echo "Factory configuration default: $DOCUMENTED_FACTORY / fee tier 3000"
  echo "Handoff: $HANDOFF"
}

# Emit an ICPSwap dfx.json with NO `networks` block, so its `local` network
# resolves to the shared replica (127.0.0.1:4943) that the Agent Vault also uses
# — the single "same replica" both graphs deploy against. Restored on exit.
icpswap_write_dfx_json() {
  cat > "$ICPSWAP_DIR/dfx.json" <<'JSON'
{
  "canisters": {
    "SwapPool": { "main": "./src/SwapPool.mo", "type": "motoko" },
    "SwapFeeReceiver": { "main": "./src/SwapFeeReceiver.mo", "type": "motoko" },
    "SwapFactory": { "main": "./src/SwapFactory.mo", "type": "motoko" },
    "SwapDataBackup": { "main": "./src/SwapDataBackup.mo", "type": "motoko" },
    "PasscodeManager": { "main": "./src/PasscodeManager.mo", "type": "motoko" },
    "PositionIndex": { "main": "./src/PositionIndex.mo", "type": "motoko", "dependencies": ["SwapFactory"] },
    "TrustedCanisterManager": { "main": "./src/TrustedCanisterManager.mo", "type": "motoko" },
    "SwapPoolInstaller": { "main": "./src/SwapPoolInstaller.mo", "type": "motoko" },
    "ICRC2": { "wasm": "./test/icrc2/icrc2.wasm", "type": "custom", "candid": "./test/icrc2/icrc2.did" },
    "ICRC2B": { "wasm": "./test/icrc2/icrc2.wasm", "type": "custom", "candid": "./test/icrc2/icrc2.did" }
  },
  "defaults": { "build": { "packtool": "vessel sources" } },
  "version": 1
}
JSON
}

# ICRC-2 token fixture init record (mirrors test/icrc2 wasm init shape), funding
# $MINTER generously. fee=0 keeps the PasscodeManager createPool flow simple.
icpswap_token_arg() {
  printf '( record {name="%s"; symbol="%s"; decimals=8; fee=0; max_supply=1_000_000_000_000_000_000; initial_balances=vec {record {record {owner=principal "%s"; subaccount=null;}; 100_000_000_000_000_000}}; min_burn_amount=10_000; minting_account=null; advanced_settings=null; })' "$1" "$1" "$MINTER"
}

# Upload the locally-built SwapPool wasm to the installer and factory. The
# upstream upload-pool-wasm.sh passes each 200KB chunk as an inline CLI arg,
# which exceeds ARG_MAX here; we pass chunks via --argument-file instead (also
# dropping its Rust/cargo dependency). Chunk count is asserted before combine.
icpswap_upload_pool_wasm() {
  local wasm=".dfx/local/canisters/SwapPool/SwapPool.wasm"
  [ -f "$wasm" ] || die "pool wasm not built: $wasm"
  "$DFX_BIN" canister call SwapPoolInstaller clearChunks >/dev/null
  "$DFX_BIN" canister call SwapFactory clearChunks >/dev/null
  local tmp; tmp="$(mktemp -d)"
  split -b 262144 "$wasm" "$tmp/chunk-"
  local total; total="$(ls "$tmp"/chunk-* | wc -l | tr -d ' ')"
  local last_i="" last_f=""
  for c in "$tmp"/chunk-*; do
    { printf '(vec { '; od -An -v -tu1 "$c" | awk '{for(i=1;i<=NF;i++) printf (k++?";":"") $i}'; printf ' })'; } > "$tmp/arg.txt"
    last_i="$("$DFX_BIN" canister call SwapPoolInstaller uploadWasmChunk --argument-file "$tmp/arg.txt")"
    last_f="$("$DFX_BIN" canister call SwapFactory uploadWasmChunk --argument-file "$tmp/arg.txt")"
  done
  rm -rf "$tmp"
  local ci cf
  ci="$(printf '%s' "$last_i" | grep -oE '[0-9]+' | head -1)"
  cf="$(printf '%s' "$last_f" | grep -oE '[0-9]+' | head -1)"
  [ "$ci" = "$total" ] && [ "$cf" = "$total" ] || die "pool wasm chunk count mismatch (installer=$ci factory=$cf expected=$total)"
  "$DFX_BIN" canister call SwapPoolInstaller combineWasmChunks >/dev/null
  "$DFX_BIN" canister call SwapFactory combineWasmChunks >/dev/null
  "$DFX_BIN" canister call SwapPoolInstaller activateWasm >/dev/null
  "$DFX_BIN" canister call SwapFactory activateWasm >/dev/null
}

# Stand up the full ICPSwap V3 canister graph on the shared replica: token
# fixtures, fee receiver, factory + dependencies, and the pool-installer with
# the pool wasm registered. Records every principal into the handoff file.
icpswap_graph_up() {
  cd "$ICPSWAP_DIR"
  icpswap_write_dfx_json
  MINTER="$($DFX_BIN identity get-principal)"
  local wallet; wallet="$($DFX_BIN identity get-wallet)"

  echo "[icpswap] creating canisters on shared replica (:4943)..."
  "$DFX_BIN" canister create --all --with-cycles 1000000000000 >/dev/null
  echo "[icpswap] building graph (vessel sources)..."
  "$DFX_BIN" build >/dev/null

  echo "[icpswap] installing token fixtures + infrastructure..."
  "$DFX_BIN" canister install ICRC2  --argument="$(icpswap_token_arg ICRC2)"  >/dev/null
  "$DFX_BIN" canister install ICRC2B --argument="$(icpswap_token_arg ICRC2B)" >/dev/null
  local icrc2 icrc2b factory passcode posidx feerecv trusted backup installer
  icrc2="$($DFX_BIN canister id ICRC2)";          icrc2b="$($DFX_BIN canister id ICRC2B)"
  factory="$($DFX_BIN canister id SwapFactory)";  passcode="$($DFX_BIN canister id PasscodeManager)"
  posidx="$($DFX_BIN canister id PositionIndex)"; feerecv="$($DFX_BIN canister id SwapFeeReceiver)"
  trusted="$($DFX_BIN canister id TrustedCanisterManager)"; backup="$($DFX_BIN canister id SwapDataBackup)"
  installer="$($DFX_BIN canister id SwapPoolInstaller)"

  "$DFX_BIN" canister install SwapFeeReceiver --argument="(principal \"$factory\", record {address=\"$icrc2\"; standard=\"ICRC2\"}, record {address=\"$icrc2\"; standard=\"ICRC2\"}, principal \"$MINTER\")" >/dev/null
  "$DFX_BIN" canister install TrustedCanisterManager --argument="(null)" >/dev/null
  "$DFX_BIN" canister install SwapDataBackup --argument="(principal \"$factory\", null)" >/dev/null
  "$DFX_BIN" canister install SwapFactory --argument="(principal \"$feerecv\", principal \"$passcode\", principal \"$trusted\", principal \"$backup\", opt principal \"$MINTER\", principal \"$posidx\")" >/dev/null
  "$DFX_BIN" canister install PositionIndex --argument="(principal \"$factory\")" >/dev/null
  "$DFX_BIN" canister install PasscodeManager --argument="(principal \"$icrc2\", 100000000, principal \"$factory\", principal \"$MINTER\")" >/dev/null

  echo "[icpswap] configuring SwapPoolInstaller + registering pool wasm..."
  "$DFX_BIN" deploy SwapPoolInstaller --argument="(principal \"$factory\", principal \"$factory\", principal \"$posidx\")" >/dev/null
  "$DFX_BIN" canister update-settings SwapPoolInstaller --add-controller "$factory" >/dev/null
  "$DFX_BIN" canister update-settings SwapPoolInstaller --remove-controller "$wallet" >/dev/null
  local module_hash
  module_hash="$("$DFX_BIN" canister call SwapPoolInstaller getStatus | sed -n 's/.*moduleHash = opt blob "\(.*\)".*/\1/p')"
  [ -n "$module_hash" ] || die "installer module hash empty"
  "$DFX_BIN" canister call SwapFactory setInstallerModuleHash "(blob \"$module_hash\")" >/dev/null
  "$DFX_BIN" canister call SwapFactory addPoolInstallers "(vec {record {canisterId = principal \"$installer\"; subnet = \"mainnet\"; subnetType = \"mainnet\"; weight = 100: nat};})" >/dev/null
  "$DFX_BIN" canister call SwapFactory removePoolInstaller "(principal \"$installer\")" >/dev/null
  "$DFX_BIN" canister call SwapFactory addPoolInstallers "(vec {record {canisterId = principal \"$installer\"; subnet = \"mainnet\"; subnetType = \"mainnet\"; weight = 100: nat};})" >/dev/null
  "$DFX_BIN" canister deposit-cycles 50698725619460 SwapPoolInstaller >/dev/null

  echo "[icpswap] uploading pool wasm (chunked, --argument-file)..."
  icpswap_upload_pool_wasm

  "$DFX_BIN" canister call SwapFactory getPoolInstallers | grep -q "$installer" || die "installer not registered with factory"

  hs_put icrc2 "$icrc2"; hs_put icrc2b "$icrc2b"; hs_put factory "$factory"
  hs_put passcodeManager "$passcode"; hs_put positionIndex "$posidx"
  hs_put feeReceiver "$feerecv"; hs_put trustedCanisterManager "$trusted"
  hs_put swapDataBackup "$backup"; hs_put swapPoolInstaller "$installer"
  hs_put minter "$MINTER"
  cd "$ROOT_DIR"
}

# Create a real ICRC2/ICRC2 pool at fee tier 3000 and seed full-range liquidity
# with genuine ledger calls, so the vault can later settle a live swap. Both
# fixture tokens are registered with standard "ICRC2" so the pool uses
# icrc2_transfer_from, matching the vault's icrc2_approve path.
#
# createPool sorts token0/token1 by address (PoolUtils.sort); getPool matches on
# sorted address and ignores the standard string, so the vault's natural query
# order (fromToken, toToken) resolves the same pool regardless of sort. We assert
# that here rather than trust it. The passcode fee (one PasscodeManager deposit)
# is funded from the minter's ICRC2 balance before requestPasscode.
icpswap_create_fixture_pool() {
  cd "$ICPSWAP_DIR"
  local icrc2 icrc2b passcode
  icrc2="$($DFX_BIN canister id ICRC2)"; icrc2b="$($DFX_BIN canister id ICRC2B)"; passcode="$($DFX_BIN canister id PasscodeManager)"

  # Address-sorted token order is what createPool/getPool key on internally.
  local t0 t1
  if [[ "$icrc2" < "$icrc2b" ]]; then t0="$icrc2"; t1="$icrc2b"; else t0="$icrc2b"; t1="$icrc2"; fi

  echo "[icpswap] funding passcode fee + requesting pool passcode..."
  "$DFX_BIN" canister call ICRC2 icrc2_approve "(record{amount=1_000_000_000; created_at_time=null; expected_allowance=null; expires_at=null; fee=null; from_subaccount=null; memo=null; spender=record {owner=principal \"$passcode\"; subaccount=null}})" >/dev/null
  "$DFX_BIN" canister call PasscodeManager depositFrom "(record {amount=100000000; fee=0})" >/dev/null
  "$DFX_BIN" canister call PasscodeManager requestPasscode "(principal \"$t0\", principal \"$t1\", 3000)" >/dev/null

  echo "[icpswap] creating pool (fee 3000, standard ICRC2/ICRC2)..."
  local created pool
  created="$("$DFX_BIN" canister call SwapFactory createPool "(record {subnet = opt \"mainnet\"; token0 = record {address = \"$t0\"; standard = \"ICRC2\"}; token1 = record {address = \"$t1\"; standard = \"ICRC2\"}; fee = 3000; sqrtPriceX96 = \"274450166607934908532224538203\"})")"
  pool="$(printf '%s' "$created" | sed -n 's/.*canisterId = principal "\([^"]*\)".*/\1/p')"
  [ -n "$pool" ] || die "createPool returned no canisterId: $created"

  # Prove getPool resolves this pool in the vault's natural (fromToken, toToken)
  # order — the exact query Main.mo's swap() issues.
  "$DFX_BIN" canister call SwapFactory getPool "(record {token0 = record {address=\"$icrc2\"; standard=\"ICRC2\"}; token1 = record {address=\"$icrc2b\"; standard=\"ICRC2\"}; fee = 3000})" \
    | grep -q "canisterId = principal \"$pool\"" || die "getPool did not resolve fixture pool $pool in vault query order"

  echo "[icpswap] seeding full-range liquidity..."
  "$DFX_BIN" canister call ICRC2  icrc2_approve "(record{amount=10_000_000_000_000_000; created_at_time=null; expected_allowance=null; expires_at=null; fee=null; from_subaccount=null; memo=null; spender=record {owner=principal \"$pool\"; subaccount=null}})" >/dev/null
  "$DFX_BIN" canister call ICRC2B icrc2_approve "(record{amount=10_000_000_000_000_000; created_at_time=null; expected_allowance=null; expires_at=null; fee=null; from_subaccount=null; memo=null; spender=record {owner=principal \"$pool\"; subaccount=null}})" >/dev/null
  "$DFX_BIN" canister call "$pool" depositFrom "(record {token=\"$t0\"; amount=1_000_000_000_000_000; fee=0})" >/dev/null
  "$DFX_BIN" canister call "$pool" depositFrom "(record {token=\"$t1\"; amount=1_000_000_000_000_000; fee=0})" >/dev/null
  "$DFX_BIN" canister call "$pool" mint "(record {token0=\"$t0\"; token1=\"$t1\"; fee=3000; tickLower=-887220; tickUpper=887220; amount0Desired=\"1000000000000000\"; amount1Desired=\"1000000000000000\"})" >/dev/null

  # Vault swap direction: fromToken=ICRC2. zeroForOne is true only when ICRC2 is
  # the sorted token0. Quote must succeed before we declare the fixture ready.
  local zeroForOne; if [ "$t0" = "$icrc2" ]; then zeroForOne=true; else zeroForOne=false; fi
  "$DFX_BIN" canister call "$pool" quote "(record {zeroForOne=$zeroForOne; amountIn=\"10000000000\"; amountOutMinimum=\"0\"})" \
    | grep -q "ok =" || die "fixture pool quote failed in vault direction"

  hs_put fixturePool "$pool"; hs_put fixtureToken0 "$t0"; hs_put fixtureToken1 "$t1"
  hs_put vaultFromToken "$icrc2"; hs_put vaultToToken "$icrc2b"
  echo "[icpswap] fixture pool ready: $pool"
  cd "$ROOT_DIR"
}

# Deploy the Agent Vault onto the SAME shared replica and configure it against the
# real local ICPSwap graph: local factory + fee tier 3000, a policy whose allowlists
# admit the fixture pair/recipient, an approved agent identity, and real ledger funding
# of the vault's default-subaccount account. The vault is deliberately NOT made a pool
# admin: depositFromAndSwap pulls via ICRC-2 approval and needs no special privilege, so
# scenario 4 exercises the true production path. Finally it proves syncBalance returns
# live ledger metadata. Throwaway av-agent/av-outsider identities back the authorization
# scenarios; they are created idempotently and left in place.
icpswap_deploy_vault() {
  local icrc2 icrc2b factory
  cd "$ICPSWAP_DIR"
  icrc2="$($DFX_BIN canister id ICRC2)"; icrc2b="$($DFX_BIN canister id ICRC2B)"; factory="$($DFX_BIN canister id SwapFactory)"
  cd "$ROOT_DIR"

  local controller agent outsider recipient
  controller="$($DFX_BIN identity get-principal)"
  for id in av-agent av-outsider av-recipient; do
    "$DFX_BIN" identity list 2>/dev/null | grep -qx "$id" || "$DFX_BIN" identity new "$id" --storage-mode plaintext >/dev/null 2>&1 || true
  done
  agent="$($DFX_BIN identity get-principal --identity av-agent)"
  outsider="$($DFX_BIN identity get-principal --identity av-outsider)"
  # Transfer recipient MUST NOT be the controller: the controller is the fixture ledger's
  # minting account, and an ICRC-1 transfer to the minter is a burn (tokens leave the vault
  # but no account is credited), which would make a real-movement assertion untestable.
  recipient="$($DFX_BIN identity get-principal --identity av-recipient)"

  echo "[icpswap] deploying + configuring Agent Vault on shared replica..."
  "$DFX_BIN" canister create agent_vault >/dev/null 2>&1 || true
  "$DFX_BIN" deploy agent_vault --argument "(principal \"$controller\")" >/dev/null
  local vault; vault="$($DFX_BIN canister id agent_vault)"

  "$DFX_BIN" canister call "$vault" setDexConfig "(record { factory = principal \"$factory\"; feeTier = 3000 })" >/dev/null
  "$DFX_BIN" canister call "$vault" setPolicy "(record {
    limits = record { maxPerTx = 50_000_000_000; maxHourlySpend = 10_000_000_000_000; maxDailySpend = 100_000_000_000_000 };
    allowlists = record {
      recipients = vec { principal \"$recipient\" };
      dexes = vec { principal \"$factory\" };
      pairs = vec { record { from = principal \"$icrc2\"; to = principal \"$icrc2b\" } }
    };
    circuitBreaker = false; failureThreshold = 3; consecutiveFailures = 0
  })" >/dev/null
  "$DFX_BIN" canister call "$vault" setApprovedAgents "(vec { principal \"$agent\" })" >/dev/null

  echo "[icpswap] funding vault..."
  cd "$ICPSWAP_DIR"
  "$DFX_BIN" canister call ICRC2  icrc1_transfer "(record {to=record{owner=principal \"$vault\"; subaccount=null}; amount=10_000_000_000_000; fee=null; memo=null; from_subaccount=null; created_at_time=null})" >/dev/null
  "$DFX_BIN" canister call ICRC2B icrc1_transfer "(record {to=record{owner=principal \"$vault\"; subaccount=null}; amount=1_000_000_000_000;  fee=null; memo=null; from_subaccount=null; created_at_time=null})" >/dev/null
  cd "$ROOT_DIR"

  local synced
  synced="$($DFX_BIN canister call --identity av-agent "$vault" syncBalance "(principal \"$icrc2\")")"
  echo "$synced" | grep -q 'ok =' || die "syncBalance failed: $synced"
  echo "$synced" | grep -q 'standard = "ICRC2"' || die "syncBalance did not detect ICRC2 standard"
  echo "$synced" | grep -qE 'amount = [1-9]' || die "syncBalance reported zero balance"

  hs_put vault "$vault"; hs_put controller "$controller"; hs_put agent "$agent"; hs_put outsider "$outsider"
  hs_put vaultRecipient "$recipient"
  # Spend limits must mirror the setPolicy record above so scenarios.sh apply_policy can restore
  # the exact policy the harness installs (empty vars would produce a malformed setPolicy record).
  hs_put vaultMaxPerTx "50000000000"; hs_put vaultMaxHourly "10000000000000"; hs_put vaultMaxDaily "100000000000000"
  echo "[icpswap] vault ready: $vault (agent=$agent)"
}

run_icpswap() {
  [ -x "$VESSEL_BIN" ] || die "vessel not found at $VESSEL_BIN (needed to build ICPSwap)"
  ensure_checkout "$ICPSWAP_DIR" "$ICPSWAP_REPO" "$ICPSWAP_COMMIT"
  ensure_checkout "$ICPSWAP_DOCS_DIR" "$ICPSWAP_DOCS_REPO" "$ICPSWAP_DOCS_COMMIT"

  # From here on the isolated checkout may be mutated; restore it on exit.
  CLEAN_ICPSWAP=1
  # ICPSwap's package-set pins git deps over SSH; rewrite to HTTPS for CI/offline.
  sed -i 's#git@github.com:#https://github.com/#g' "$ICPSWAP_DIR/package-set.dhall"

  cd "$ROOT_DIR"
  "$DFX_BIN" stop >/dev/null 2>&1 || true
  "$DFX_BIN" start --clean --background
  hs_init

  icpswap_graph_up
  icpswap_create_fixture_pool
  icpswap_deploy_vault

  echo ""
  echo "[icpswap] graph + fixture pool + vault up on the shared replica. Handoff:"
  jq . "$HANDOFF"

  # Settlement tests are part of the managed lifecycle: run the full scenario suite
  # against the freshly-provisioned graph. scenarios.sh exits nonzero on any failed
  # assertion, which (under set -e) aborts here and lets the EXIT trap stop the
  # replica and restore the isolated checkout — no green run without green tests.
  echo ""
  echo "[icpswap] running settlement scenario suite..."
  bash "$ROOT_DIR/test/integration/scenarios.sh" "$HANDOFF"
  echo "[icpswap] settlement scenario suite passed."
}

command -v "$DFX_BIN" >/dev/null || die "dfx not found at $DFX_BIN"

case "$MODE" in
  smoke) run_smoke ;;
  icpswap) run_icpswap ;;
esac
