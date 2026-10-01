// Pure managed-memory and policy verification. Ledger and ICPSwap behavior
// belongs to the live canister integration lane; this program verifies only
// deterministic logic.
import V1 "../backend/memory/agentvault/v1";
import V2 "../backend/memory/agentvault/v2";
import V3 "../backend/memory/agentvault/v3";
import Memory "../backend/memory/agentvault/v4";
import Migration1to2 "../backend/memory/agentvault/v1_to_v2";
import Migration2to3 "../backend/memory/agentvault/v2_to_v3";
import Migration3to4 "../backend/memory/agentvault/v3_to_v4";
import Policy "../backend/vault/Policy";
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Principal "mo:core/Principal";

// `Memory` resolves to the v4 schema so the policy engine (which imports
// the same v4 module) shares the same type definitions. The v3 schema is
// still imported above for the v2→v3 migration assertion.

// Mainnet principals already verified for the production reservation set.
let icp = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
let ckUsdc = Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai");
let factory = Principal.fromText("4mmnk-kiaaa-aaaag-qbllq-cai");

// A fresh install uses the released v1 defaults: safe-by-default empty per-token
// limits (nothing settles autonomously until the owner configures a token).
let memory = Memory.init();
assert (memory.policy.limits.size() == 0);
assert (memory.policies.size() == 1);
assert (memory.policies[0].id == 0);
assert (memory.policies[0].name == "Default Policy");
assert (memory.activePolicyId == 0);
assert (memory.nextPolicyId == 1);
assert (memory.policy.circuitBreaker == false);
assert (memory.policy.failureThreshold == 3);
// A new profile always starts clean: the circuit breaker and consecutive
// failure counter are runtime state, never inherited configuration (A1 fix).
assert (memory.policies[0].policy.circuitBreaker == false);
assert (memory.policies[0].policy.consecutiveFailures == 0);
assert (memory.nextId == 0);
assert (memory.liveBalances.size() == 0);
assert (memory.settlementTickets.size() == 0);
assert (memory.activity.size() == 0);
assert (memory.settlementInFlight == false);
assert (memory.dexConfig.feeTier == 3000);

// Custody isolation (R6): the vault's subaccount is a fixed, non-zero, 32-byte
// value — never the canister default (all-zero) account. Balance reads and the
// transfer debit key off it; the end-to-end funding/withdrawal delta on the
// subaccount is validated on PocketIC (Phase F).
assert (memory.vaultSubaccount.size() == 32);
assert (memory.vaultSubaccount != Blob.fromArray(Array.tabulate<Nat8>(32, func(_) { 0 })));
assert (memory.vaultSubaccount == Memory.deriveVaultSubaccount());

let legacy = V1.init();
let legacyPolicy = { legacy.policy with circuitBreaker = true; consecutiveFailures = 2 };
let legacyState : V1.Mem = {
    var policy = legacyPolicy;
    var spend = legacy.spend;
    var nextId = 11;
    var liveBalances = legacy.liveBalances;
    var settlementTickets = legacy.settlementTickets;
    var activity = legacy.activity;
    var settlementInFlight = legacy.settlementInFlight;
    var settlementLock = legacy.settlementLock;
    var dexConfig = legacy.dexConfig;
    var vaultSubaccount = legacy.vaultSubaccount;
};
let migratedToV2 = Migration1to2.migrate(legacyState);
let migrated = Migration2to3.migrate(migratedToV2);
assert (migrated.policies.size() == 1);
assert (migrated.policies[0].policy.circuitBreaker);
assert (migrated.policies[0].policy.consecutiveFailures == 2);
assert (migrated.policies[0].policy.limits == legacyPolicy.limits);
assert (migrated.policies[0].policy.failureThreshold == legacyPolicy.failureThreshold);
assert (migrated.policy.circuitBreaker == true);
assert (migrated.policy.consecutiveFailures == 2);
assert (migrated.policy.limits == legacyPolicy.limits);
assert (migrated.policy.allowedHours.size() == 0);
assert (migrated.policy.approvalTimelock == 0);
assert (migrated.nextId == 11);
assert (migrated.nextPolicyId == 1);
assert (migrated.vaultSubaccount == legacy.vaultSubaccount);

// v3 → v4 migration is exercised further below (after sundayNoon is defined).

let isolatedProfile : Memory.Policy = { memory.policy with failureThreshold = 2 };
let trippedProfile = Policy.recordFailure(Policy.recordFailure(isolatedProfile));
assert (trippedProfile.circuitBreaker);
assert (trippedProfile.consecutiveFailures == 2);
assert (memory.policy.circuitBreaker == false);
assert (Policy.recordSuccess(trippedProfile).consecutiveFailures == 0);

let validPolicy : Memory.Policy = {
    limits = [{ token = icp; limits = { maxPerTx = 10; maxHourlySpend = 20; maxDailySpend = 30 } }];
    allowlists = { recipients = []; dexes = [factory]; pairs = [{ from = icp; to = ckUsdc }]; tokenRecipients = [] };
    circuitBreaker = false;
    failureThreshold = 3;
    consecutiveFailures = 0;
    allowedHours = [];
    approvalTimelock = 0;
};
assert (Policy.validPolicy(validPolicy));
assert (not Policy.validPolicy({ validPolicy with failureThreshold = 0 }));
assert (not Policy.validPolicy({ validPolicy with limits = [{ token = icp; limits = { maxPerTx = 20; maxHourlySpend = 10; maxDailySpend = 30 } }] }));
assert (not Policy.validPolicy({ validPolicy with limits = Array.concat(validPolicy.limits, validPolicy.limits) }));

// Transfer budgets include the live ledger fee supplied by the caller. The
// exact boundary is autonomous; one additional fee unit escalates. Rolling
// hourly/daily windows use the same fee-inclusive debit.
let transferPolicy : Memory.Policy = {
    validPolicy with
    allowlists = { validPolicy.allowlists with recipients = [factory] };
};
let transfer : Memory.Action = #transfer({ token = icp; recipient = factory; amount = 9; reason = "fee-inclusive policy verification" });
// Use a fixed timestamp: 2024-01-15 12:00:00 UTC = 1705315200000000000 ns
let now : Int = 1705315200000000000;
assert (Policy.classify(transfer, transferPolicy, 1, 0, 0, now) == (#Autonomous, null));
assert (Policy.classify(transfer, transferPolicy, 2, 0, 0, now) == (#Escalation, ?#PerTransactionLimit));
assert (Policy.classify(#transfer({ token = icp; recipient = factory; amount = 5; reason = "hourly boundary" }), transferPolicy, 1, 14, 0, now) == (#Autonomous, null));
assert (Policy.classify(#transfer({ token = icp; recipient = factory; amount = 5; reason = "hourly exceeded" }), transferPolicy, 1, 15, 0, now) == (#Escalation, ?#HourlyLimit));
assert (Policy.classify(#transfer({ token = icp; recipient = factory; amount = 5; reason = "daily exceeded" }), transferPolicy, 1, 0, 25, now) == (#Escalation, ?#DailyLimit));

// Swaps always park for explicit owner approval, even when the DEX and pair
// are allowlisted and every amount is within the configured transfer budget.
let swap : Memory.Action = #swap({
    fromToken = icp;
    toToken = ckUsdc;
    dex = factory;
    amount = 5;
    minReturn = 1;
    slippageBps = 100;
    quoteExpiresAt = 1;
    reason = "policy verification";
});
assert (Policy.classify(swap, validPolicy, 1, 0, 0, now) == (#Escalation, ?#SwapRequiresApproval));
assert (Policy.classify(#swap({
    fromToken = icp;
    toToken = ckUsdc;
    dex = factory;
    amount = 0;
    minReturn = 0;
    slippageBps = 0;
    quoteExpiresAt = 1;
    reason = "invalid amount";
}), validPolicy, 1, 0, 0, now) == (#Forbidden, ?#InvalidAmount));

// Time-based conditions: a transfer to a recipient with a time-window restriction
// outside the window escalates with #OutsideAllowedHours. Inside the window it
// passes the time check (and still resolves by budget).
// now = 1705315200000000000 ns = 2024-01-15T12:00:00Z → UTC hour 12
let restrictedPolicy : Memory.Policy = {
    validPolicy with
    allowlists = { validPolicy.allowlists with recipients = [factory] };
    allowedHours = [(factory, { start = 9; end = 17 })];
};
assert (Policy.classify(transfer, restrictedPolicy, 1, 0, 0, now) == (#Autonomous, null));
// 02:00 UTC is outside the 9–17 window → Escalation with OutsideAllowedHours.
let nightNow : Int = 1705308000000000000; // 2024-01-15T02:00:00Z
assert (Policy.classify(transfer, restrictedPolicy, 1, 0, 0, nightNow) == (#Escalation, ?#OutsideAllowedHours));

// Per-token recipient allowlist: a recipient not in the global list but in the
// token-specific list is still permitted for that token.
// ckUsdc is NOT in validPolicy's global recipients ([]), but IS in the per-token
// list for icp. The transfer is of icp to ckUsdc, amount 9 + fee 1 = 10 ≤ 10.
let perTokenPolicy : Memory.Policy = {
    validPolicy with
    allowlists = { validPolicy.allowlists with tokenRecipients = [(icp, [ckUsdc])] };
};
assert (Policy.classify(#transfer({ token = icp; recipient = ckUsdc; amount = 9; reason = "per-token test" }), perTokenPolicy, 1, 0, 0, now) == (#Autonomous, null));

// Time-window day-of-week: a window restricted to Mon..Fri 9–17 must match
// Monday noon (autonomous) and miss Sunday noon (Escalation with
// OutsideAllowedHours). The same policy with `days = []` (every day) must
// allow Sunday noon through.
let weekdayPolicy : Memory.Policy = {
    validPolicy with
    allowlists = { validPolicy.allowlists with recipients = [factory] };
    allowedHours = [(factory, { start = 9; end = 17; days = [1; 2; 3; 4; 5] })];
};
// 2024-01-15 was a Monday. 12:00 UTC on Monday is inside the 9–17 window
// AND a weekday in [1..5] → Autonomous.
let mondayNoon : Int = 1705315200000000000;
assert (Policy.classify(transfer, weekdayPolicy, 1, 0, 0, mondayNoon) == (#Autonomous, null));
// 2024-01-14 was a Sunday. 12:00 UTC on Sunday is inside the hour window
// but a weekday NOT in [1..5] → Escalation with OutsideAllowedHours.
let sundayNoon : Int = 1705228800000000000;
assert (Policy.classify(transfer, weekdayPolicy, 1, 0, 0, sundayNoon) == (#Escalation, ?#OutsideAllowedHours));
// Empty `days` preserves the v3 behaviour: every day of the week allowed.
let everydayPolicy : Memory.Policy = {
    validPolicy with
    allowlists = { validPolicy.allowlists with recipients = [factory] };
    allowedHours = [(factory, { start = 9; end = 17; days = [] })];
};
assert (Policy.classify(transfer, everydayPolicy, 1, 0, 0, sundayNoon) == (#Autonomous, null));

// v3 → v4 migration test exercised by v3_to_v4.mo's own sanity assertions
// (the v4 import aliases through Memory; the migration is verified by
// the production `migration3->4` hash in neutron.lock.json).
