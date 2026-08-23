// Reference/schema test for the agent_vault managed-memory store and the
// backend's SYNCHRONOUS surface.
//
// The settling methods (syncBalance / proposeTransfer / proposeSwap /
// approveTicket) are `async*` over the backend_calls capability; their real
// ICRC-1 behavior — a transfer that settles, an over-limit proposal that parks
// a ticket, a swap that returns SWAP_NOT_ENABLED — is validated on PocketIC in
// Phase F, not here. So this test never drives the async paths: it builds the
// backend with a stub ledger that is never invoked, and exercises the init
// defaults, the synchronous policy surface, and the managed root's read-back /
// no-clobber-on-reinit invariant. Seeding a pending ticket is done by mutating
// the shared root directly, standing in for the (async) escalate path.
import Vault "../backend/main";
import Memory "../backend/memory/agentvault/v1";
import Capabilities "../backend/capabilities/Types";
import Array "mo:core/Array";
import Principal "mo:core/Principal";

// Obviously-placeholder principals — the async settlement paths are never
// exercised here, so these need only be valid, not real ledgers.
let token = Principal.fromText("aaaaa-aa");
let recipient = Principal.fromText("2vxsx-fae");

// A stub backend_calls capability. The synchronous surface under test never
// reaches a ledger, so every entry point returns an inert typed failure and is
// never actually invoked; if a later edit accidentally routes a synchronous
// method through it, the #err surfaces rather than a silent fake success.
let noLedger : Capabilities.BackendCalls = {
    canister_principal = Principal.fromText("aaaaa-aa");
    can_call = func(_ : Principal, _ : Text) : Bool { false };
    call = func(_ : Capabilities.CallRequest) : async* Capabilities.CallResult {
        #err({ code = "NO_LEDGER"; message = "stub ledger; async settlement is validated on PocketIC (Phase F)" });
    };
    call_batch = func(_ : [Capabilities.CallRequest]) : async* [Capabilities.CallResult] {
        [];
    };
};

// A fresh install uses the released v1 defaults.
let memory = Memory.init();
assert (memory.policy.limits.maxPerTx == 100);
assert (memory.policy.circuitBreaker == false);
assert (memory.policy.failureThreshold == 3);
assert (memory.nextId == 0);
assert (memory.liveBalances.size() == 0);
assert (memory.settlementTickets.size() == 0);
assert (memory.activity.size() == 0);
assert (memory.settlementInFlight == false);
assert (memory.dexConfig.feeTier == 3000);

// The backend mutates that exact managed root, not a copy: an owner toggle is
// observable on `memory` itself.
let vault = Vault.Init({
    stable_memory = { agentvault = memory };
    capabilities = { backend_calls = noLedger };
});
switch (vault.setCircuitBreaker(true)) { case (#ok(())) {}; case (#err(_)) assert false };
assert (memory.policy.circuitBreaker == true);
switch (vault.setCircuitBreaker(false)) { case (#ok(())) {}; case (#err(_)) assert false };
assert (memory.policy.circuitBreaker == false);

// Seed a pending ticket directly on the shared root (the escalate path that
// would normally park it, proposeTransfer, is async* and covered on PocketIC).
// Mirror what proposeAction does: consume nextId, then append. The read surface
// must then surface the parked ticket unchanged.
let ticketId = memory.nextId;
memory.nextId += 1;
let ticket : Memory.Ticket = {
    id = ticketId;
    action = #transfer({ token; recipient; amount = 10; reason = "reference test" });
    createdAt = 0;
    policyError = ?#RecipientNotAllowed;
    status = #pending;
};
memory.settlementTickets := Array.concat(memory.settlementTickets, [ticket]);
assert (memory.settlementTickets.size() == 1);
switch (vault.getPendingApprovals()) {
    case (#ok(items)) {
        assert (items.size() == 1);
        assert (items[0].id == ticketId);
        assert (items[0].status == #pending);
    };
    case (#err(_)) assert false;
};

// Rebuilding the runtime over the retained root observes production state;
// init() must not re-run and clobber the parked ticket or the toggled policy.
let restored = Vault.Init({
    stable_memory = { agentvault = memory };
    capabilities = { backend_calls = noLedger };
});
switch (restored.getPendingApprovals()) {
    case (#ok(items)) assert (items.size() == 1);
    case (#err(_)) assert false;
};
assert (memory.policy.circuitBreaker == false);
