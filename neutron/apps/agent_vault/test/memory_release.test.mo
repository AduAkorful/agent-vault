// Pure managed-memory and policy verification. Ledger and ICPSwap behavior
// belongs to the live canister integration lane; this program verifies only
// deterministic logic.
import V1 "../backend/memory/agentvault/v1";
import Memory "../backend/memory/agentvault/v2";
import Migration "../backend/memory/agentvault/v1_to_v2";
import Policy "../backend/vault/Policy";
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Principal "mo:core/Principal";

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
let migrated = Migration.migrate(legacyState);
assert (migrated.policies.size() == 1);
assert (migrated.policies[0].policy.circuitBreaker);
assert (migrated.policies[0].policy.consecutiveFailures == 2);
assert (migrated.policy == legacyPolicy);
assert (migrated.nextId == 11);
assert (migrated.nextPolicyId == 1);
assert (migrated.vaultSubaccount == legacy.vaultSubaccount);

let isolatedProfile : Memory.Policy = { memory.policy with failureThreshold = 2 };
let trippedProfile = Policy.recordFailure(Policy.recordFailure(isolatedProfile));
assert (trippedProfile.circuitBreaker);
assert (trippedProfile.consecutiveFailures == 2);
assert (memory.policy.circuitBreaker == false);
assert (Policy.recordSuccess(trippedProfile).consecutiveFailures == 0);

let validPolicy : Memory.Policy = {
    limits = [{ token = icp; limits = { maxPerTx = 10; maxHourlySpend = 20; maxDailySpend = 30 } }];
    allowlists = { recipients = []; dexes = [factory]; pairs = [{ from = icp; to = ckUsdc }] };
    circuitBreaker = false;
    failureThreshold = 3;
    consecutiveFailures = 0;
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
assert (Policy.classify(transfer, transferPolicy, 1, 0, 0) == (#Autonomous, null));
assert (Policy.classify(transfer, transferPolicy, 2, 0, 0) == (#Escalation, ?#PerTransactionLimit));
assert (Policy.classify(#transfer({ token = icp; recipient = factory; amount = 5; reason = "hourly boundary" }), transferPolicy, 1, 14, 0) == (#Autonomous, null));
assert (Policy.classify(#transfer({ token = icp; recipient = factory; amount = 5; reason = "hourly exceeded" }), transferPolicy, 1, 15, 0) == (#Escalation, ?#HourlyLimit));
assert (Policy.classify(#transfer({ token = icp; recipient = factory; amount = 5; reason = "daily exceeded" }), transferPolicy, 1, 0, 25) == (#Escalation, ?#DailyLimit));

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
assert (Policy.classify(swap, validPolicy, 1, 0, 0) == (#Escalation, ?#SwapRequiresApproval));
assert (Policy.classify(#swap({
    fromToken = icp;
    toToken = ckUsdc;
    dex = factory;
    amount = 0;
    minReturn = 0;
    slippageBps = 0;
    quoteExpiresAt = 1;
    reason = "invalid amount";
}), validPolicy, 1, 0, 0) == (#Forbidden, ?#InvalidAmount));
