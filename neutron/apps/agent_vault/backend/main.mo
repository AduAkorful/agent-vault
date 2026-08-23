// Agent Vault backend — Neutron app module (ported from the M3 standalone actor).
//
// Structural port notes:
//   - `actor class AgentVault(owner)` → `module { public class Init(env) }`. The
//     kernel assembles this into the shared user-owned canister; there is no
//     `owner` parameter and no `actor`.
//   - Authorization is kernel-mediated. M3's controller()/agent()/caller checks
//     and every #Unauthorized return are gone; the owner-vs-agent tier boundary
//     is the manifest `agent_entrypoints` whitelist (agents get propose+read
//     only), not app code (ADR-007).
//   - The ten `stable var`s become fields of the managed-memory root `mem`.
//   - Settlement is wired over the `backend_calls` capability: syncBalance and
//     transfer settlement make real ICRC-1 ledger calls (icrc1_fee /
//     icrc1_balance_of / icrc1_transfer / metadata reads); swaps return a typed
//     SWAP_NOT_ENABLED (deferred in v1). Every ledger read/write that awaits the
//     capability makes its method `async*`. No fabricated receipts under any
//     path — a decode miss or kernel #err becomes an honest ExternalError
//     (ADR-004).
//
// WIRE TYPES: the build-time app-method schema generator reads type aliases from
// THIS file only (it never follows imports — see neutron-scripts/method_schema.ts),
// and it cannot instantiate a generic like `Result<T>`. So every type that
// appears in a public method signature is declared here as a concrete,
// self-contained `public type`, and each fallible method returns a monomorphic
// `…Result` variant. These mirror the persisted shapes in memory/agentvault/v1.mo
// and unify with them structurally (Motoko is structurally typed), so `mem`
// fields flow into wire returns with no conversion. They MUST stay structurally
// in sync with v1.mo; v1.mo remains the single persisted source of truth.
import Array "mo:core/Array";
import Nat "mo:core/Nat";
import Time "mo:core/Time";
import NeutronCapabilities "mo:neutron-capabilities";
import V "./memory/agentvault/v1";
import P "./vault/Policy";
import Icrc "./icrc1/Client";
import IcrcTypes "./icrc1/Types";

module {
    // ----- wire types (mirror memory/agentvault/v1.mo, structurally) -----
    public type Token = {
        id : Principal;
        symbol : Text;
        decimals : Nat8;
        standard : Text;
        fee : Nat;
    };
    public type Balance = { token : Token; amount : Nat; syncedAt : Int };
    public type TokenPair = { from : Principal; to : Principal };
    public type Limits = { maxPerTx : Nat; maxHourlySpend : Nat; maxDailySpend : Nat };
    public type Allowlists = { recipients : [Principal]; dexes : [Principal]; pairs : [TokenPair] };
    public type Policy = {
        limits : Limits;
        allowlists : Allowlists;
        circuitBreaker : Bool;
        failureThreshold : Nat;
        consecutiveFailures : Nat;
    };
    public type TransferProposal = { token : Principal; recipient : Principal; amount : Nat; reason : Text };
    public type SwapProposal = {
        fromToken : Principal;
        toToken : Principal;
        dex : Principal;
        amount : Nat;
        minReturn : Nat;
        slippageBps : Nat;
        quoteExpiresAt : Int;
        reason : Text;
    };
    public type Action = { #transfer : TransferProposal; #swap : SwapProposal };
    public type Tier = { #Autonomous; #Escalation; #Forbidden };
    public type ExternalError = { code : Text; message : Text; partial : Bool };
    public type Receipt = {
        #transfer : { token : Principal; blockIndex : Nat };
        #swap : { dex : Principal; pool : Principal; transactionId : ?Nat; approvalBlockIndex : Nat; amountOut : Nat };
    };
    public type Settlement = { #success : Receipt; #failure : ExternalError };
    public type VaultError = {
        #CircuitBreakerActive;
        #InvalidAmount;
        #PerTransactionLimit;
        #HourlyLimit;
        #DailyLimit;
        #RecipientNotAllowed;
        #DexNotAllowed;
        #TokenPairNotAllowed;
        #TicketNotFound;
        #AlreadyResolved;
        #SettlementInFlight;
        #SettlementLockNotStale;
        #InsufficientBalance;
        #UnsupportedTokenStandard;
        #ExternalFailure : ExternalError;
        #InvalidSlippage;
        #InvalidQuote;
        #QuoteExpired;
    };
    public type TicketStatus = { #pending; #approved : Receipt; #rejected : Text };
    public type Ticket = {
        id : Nat;
        action : Action;
        createdAt : Int;
        policyError : ?VaultError;
        status : TicketStatus;
    };
    public type AuditEntry = {
        id : Nat;
        action : Action;
        tier : Tier;
        policyError : ?VaultError;
        settlement : ?Settlement;
        timestamp : Int;
        ticketId : ?Nat;
        note : Text;
    };
    public type SettlementLock = { action : Action; startedAt : Int };
    public type DexConfig = { factory : Principal; feeTier : Nat };

    // ----- return-only projections -----
    // Result of classifying + (for Autonomous actions) settling a proposal.
    public type Outcome = {
        tier : Tier;
        error : ?VaultError;
        ticketId : ?Nat;
        auditId : Nat;
        settlement : ?Settlement;
    };
    // Full dashboard snapshot. `approvedAgents` is gone versus M3 (ADR-007);
    // hourly/daily spend are derived at read time from the spend log.
    public type VaultState = {
        balances : [Balance];
        policy : Policy;
        hourlySpend : Nat;
        dailySpend : Nat;
        pending : [Ticket];
        audit : [AuditEntry];
        settlementInFlight : Bool;
        settlementLock : ?SettlementLock;
        dexConfig : DexConfig;
    };

    // Monomorphic result variants — one per success payload. The schema
    // generator cannot instantiate a generic `Result<T>`, so each is concrete.
    public type VaultStateResult = { #ok : VaultState; #err : VaultError };
    public type ActivityResult = { #ok : [AuditEntry]; #err : VaultError };
    public type PendingResult = { #ok : [Ticket]; #err : VaultError };
    public type BalanceResult = { #ok : Balance; #err : VaultError };
    public type OutcomeResult = { #ok : Outcome; #err : VaultError };
    public type IdResult = { #ok : Nat; #err : VaultError };
    public type UnitResult = { #ok : (); #err : VaultError };

    public type AppBackendEnvironment = {
        stable_memory : { agentvault : V.Mem };
        capabilities : { backend_calls : NeutronCapabilities.BackendCallsV1 };
    };

    public class Init(env : AppBackendEnvironment) {
        let mem = env.stable_memory.agentvault;
        // The kernel-mediated capability handle: every ledger call is dispatched
        // through it, bounded by the manifest's principal reservations. Its
        // `canister_principal` is the vault's own principal (settlement moves the
        // vault's own funds), and `can_call` mirrors those reservations so an
        // unreserved ledger fails fast rather than trapping in the kernel.
        let calls = env.capabilities.backend_calls;

        // ----- pure helpers -----
        func amountOf(action : Action) : Nat {
            switch (action) { case (#transfer(p)) p.amount; case (#swap(p)) p.amount };
        };

        func external(code : Text, message : Text, partial : Bool) : Settlement {
            #failure({ code; message; partial });
        };

        func hasStandard(standards : [IcrcTypes.SupportedStandard], wanted : Text) : Bool {
            for (standard in standards.vals()) { if (standard.name == wanted) return true };
            false;
        };

        // A ledger is settleable if it advertises ICRC-1 (ICRC-2 supersets it).
        func supportsICRC1(standards : [IcrcTypes.SupportedStandard]) : Bool {
            hasStandard(standards, "ICRC-1") or hasStandard(standards, "ICRC-2");
        };

        // Upsert a freshly-synced balance by token id (replace-or-append), so a
        // re-sync of the same ledger overwrites rather than duplicates its row.
        func setBalance(value : Balance) {
            mem.liveBalances := Array.concat(Array.filter<Balance>(mem.liveBalances, func(b) { b.token.id != value.token.id }), [value]);
        };

        // Appends an audit entry and returns its id. `nextId` is the shared
        // monotonic counter for both audit ids and ticket ids.
        func addAudit(
            action : Action,
            tier : Tier,
            policyError : ?VaultError,
            settlement : ?Settlement,
            ticketId : ?Nat,
            note : Text,
        ) : Nat {
            let id = mem.nextId;
            mem.nextId += 1;
            mem.activity := Array.concat(mem.activity, [{ id; action; tier; policyError; settlement; timestamp = Time.now(); ticketId; note }]);
            id;
        };

        func pending() : [Ticket] {
            Array.filter<Ticket>(mem.settlementTickets, func(t) { t.status == #pending });
        };

        // ----- settlement (real ICRC-1 over the backend_calls capability) -----
        // Settle a transfer on the token's own ledger: read the current fee,
        // guard the fee-inclusive balance, then submit icrc1_transfer and map the
        // returned block index into a receipt. A decode miss or a kernel #err
        // becomes an honest ExternalError — never a fabricated receipt (ADR-004).
        // Faithful to the M3 reference actor.
        func settleTransfer(p : TransferProposal) : async* Settlement {
            let ledger = p.token;
            if (not calls.can_call(ledger, "icrc1_fee") or not calls.can_call(ledger, "icrc1_balance_of") or not calls.can_call(ledger, "icrc1_transfer")) {
                return external("TOKEN_NOT_RESERVED", "ledger is not reserved for the vault under backend_calls", false);
            };
            let fee = switch (Icrc.decodeFee(await* calls.call(Icrc.feeRequest(ledger)))) {
                case (#ok(value)) value;
                case (#err(message)) return external("LEDGER_REJECT", message, false);
            };
            let balance = switch (Icrc.decodeBalance(await* calls.call(Icrc.balanceRequest(ledger, calls.canister_principal)))) {
                case (#ok(value)) value;
                case (#err(message)) return external("LEDGER_REJECT", message, false);
            };
            // The ledger debits amount + fee, so a balance that only covers the
            // amount would be rejected at the ledger. Fail early with a typed error.
            if (balance < p.amount + fee) {
                return external("INSUFFICIENT_BALANCE", "balance " # Nat.toText(balance) # " < amount+fee " # Nat.toText(p.amount + fee), false);
            };
            let destination : IcrcTypes.Account = { owner = p.recipient; subaccount = null };
            switch (Icrc.decodeTransfer(await* calls.call(Icrc.transferRequest(ledger, destination, p.amount, fee)))) {
                case (#ok(#Ok(blockIndex))) #success(#transfer({ token = p.token; blockIndex }));
                case (#ok(#Err(txError))) external("LEDGER_ERROR", Icrc.transferErrorText(txError), false);
                case (#err(message)) external("LEDGER_REJECT", message, false);
            };
        };

        // Dispatch settlement by action. Swaps are deferred in v1 and return a
        // typed SWAP_NOT_ENABLED — no receipt is fabricated (ADR-004).
        func settle(action : Action) : async* Settlement {
            switch (action) {
                case (#transfer(p)) await* settleTransfer(p);
                case (#swap(_)) external("SWAP_NOT_ENABLED", "swap settlement is deferred in v1; no receipt is fabricated (ADR-004)", false);
            };
        };

        // Sync one token's identity + live balance from its ledger. Reads
        // supported standards, symbol, decimals, fee, and balance with individual
        // ICRC-1 queries (faithful to the M3 actor). decimals/fee are read, never
        // assumed — decimals vary (ckBTC 8, USDC 6, ICP 8) and hardcoding them
        // corrupts every amount.
        func sync(token : Principal) : async* BalanceResult {
            let ledger = token;
            if (not calls.can_call(ledger, "icrc1_supported_standards") or not calls.can_call(ledger, "icrc1_symbol") or not calls.can_call(ledger, "icrc1_decimals") or not calls.can_call(ledger, "icrc1_fee") or not calls.can_call(ledger, "icrc1_balance_of")) {
                return #err(#ExternalFailure({ code = "TOKEN_NOT_RESERVED"; message = "ledger is not reserved for the vault under backend_calls"; partial = false }));
            };
            let standards = switch (Icrc.decodeSupportedStandards(await* calls.call(Icrc.supportedStandardsRequest(ledger)))) {
                case (#ok(value)) value;
                case (#err(message)) return #err(#ExternalFailure({ code = "LEDGER_REJECT"; message; partial = false }));
            };
            if (not supportsICRC1(standards)) return #err(#UnsupportedTokenStandard);
            let symbol = switch (Icrc.decodeSymbol(await* calls.call(Icrc.symbolRequest(ledger)))) {
                case (#ok(value)) value;
                case (#err(message)) return #err(#ExternalFailure({ code = "LEDGER_REJECT"; message; partial = false }));
            };
            let decimals = switch (Icrc.decodeDecimals(await* calls.call(Icrc.decimalsRequest(ledger)))) {
                case (#ok(value)) value;
                case (#err(message)) return #err(#ExternalFailure({ code = "LEDGER_REJECT"; message; partial = false }));
            };
            let fee = switch (Icrc.decodeFee(await* calls.call(Icrc.feeRequest(ledger)))) {
                case (#ok(value)) value;
                case (#err(message)) return #err(#ExternalFailure({ code = "LEDGER_REJECT"; message; partial = false }));
            };
            let amount = switch (Icrc.decodeBalance(await* calls.call(Icrc.balanceRequest(ledger, calls.canister_principal)))) {
                case (#ok(value)) value;
                case (#err(message)) return #err(#ExternalFailure({ code = "LEDGER_REJECT"; message; partial = false }));
            };
            let value : Balance = {
                token = { id = token; symbol; decimals; standard = if (hasStandard(standards, "ICRC-2")) "ICRC2" else "ICRC1"; fee };
                amount;
                syncedAt = Time.now();
            };
            setBalance(value);
            #ok(value);
        };

        // Classify a proposal; settle immediately if Autonomous, otherwise park a
        // ticket (Escalation) or reject (Forbidden). The settlement lock is set
        // before settle() and cleared after — the reentrancy invariant (ADR-005)
        // that keeps a single in-flight settlement at a time. Because settle() now
        // awaits the ledger, a second proposal that arrives mid-settlement finds
        // settlementInFlight already set and is turned away with SettlementInFlight.
        func proposeAction(action : Action) : async* Outcome {
            let hourly = P.spendIn(mem.spend, Time.now(), 3_600_000_000_000);
            let daily = P.spendIn(mem.spend, Time.now(), 86_400_000_000_000);
            let (tier, policyError) = P.classify(action, mem.policy, hourly, daily);
            if (tier == #Forbidden) {
                let id = addAudit(action, tier, policyError, null, null, "policy rejected");
                return { tier; error = policyError; ticketId = null; auditId = id; settlement = null };
            };
            if (tier == #Escalation) {
                let ticketId = mem.nextId;
                mem.nextId += 1;
                mem.settlementTickets := Array.concat(mem.settlementTickets, [{ id = ticketId; action; createdAt = Time.now(); policyError; status = #pending }]);
                let id = addAudit(action, tier, policyError, null, ?ticketId, "pending approval");
                return { tier; error = policyError; ticketId = ?ticketId; auditId = id; settlement = null };
            };
            if (mem.settlementInFlight) {
                let id = addAudit(action, tier, null, null, null, "settlement lock rejected");
                return { tier; error = ?#SettlementInFlight; ticketId = null; auditId = id; settlement = null };
            };
            mem.settlementInFlight := true;
            mem.settlementLock := ?{ action; startedAt = Time.now() };
            let result = await* settle(action);
            mem.settlementInFlight := false;
            mem.settlementLock := null;
            switch (result) {
                case (#success(_)) {
                    mem.spend := Array.concat(mem.spend, [{ timestamp = Time.now(); amount = amountOf(action) }]);
                    mem.policy := P.recordSuccess(mem.policy);
                };
                case (#failure(_)) { mem.policy := P.recordFailure(mem.policy) };
            };
            let id = addAudit(action, tier, null, ?result, null, "autonomous settlement");
            {
                tier;
                error = switch (result) { case (#failure(e)) ?#ExternalFailure(e); case (_) null };
                ticketId = null;
                auditId = id;
                settlement = ?result;
            };
        };

        // ----- read surface (query) -----
        public func /*query*/getVaultState() : VaultStateResult {
            #ok({
                balances = mem.liveBalances;
                policy = mem.policy;
                hourlySpend = P.spendIn(mem.spend, Time.now(), 3_600_000_000_000);
                dailySpend = P.spendIn(mem.spend, Time.now(), 86_400_000_000_000);
                pending = pending();
                audit = mem.activity;
                settlementInFlight = mem.settlementInFlight;
                settlementLock = mem.settlementLock;
                dexConfig = mem.dexConfig;
            });
        };

        // NB: activity is stored oldest-first; the dashboard pages from the tail
        // for recent-first display.
        public func /*query*/getActivityHistory(limit : Nat, offset : Nat) : ActivityResult {
            let size = mem.activity.size();
            if (offset >= size) return #ok([]);
            let count = Nat.min(limit, size - offset);
            #ok(Array.tabulate<AuditEntry>(count, func(i) { mem.activity[offset + i] }));
        };

        public func /*query*/getPendingApprovals() : PendingResult {
            #ok(pending());
        };

        // ----- proposal surface (update; agent-facing via agent_entrypoints) -----
        public func /*update*/syncBalance(token : Principal) : async* BalanceResult {
            await* sync(token);
        };

        public func /*update*/proposeTransfer(token : Principal, recipient : Principal, amount : Nat, reason : Text) : async* OutcomeResult {
            #ok(await* proposeAction(#transfer({ token; recipient; amount; reason })));
        };

        // Kept classifiable so policy tiering still works, but its settlement is
        // deferred (settle() short-circuits swaps to a typed SWAP_NOT_ENABLED).
        // Not exposed as an agent tool in v1.
        public func /*update*/proposeSwap(fromToken : Principal, toToken : Principal, dex : Principal, amount : Nat, minReturn : Nat, slippageBps : Nat, quoteExpiresAt : Int, reason : Text) : async* OutcomeResult {
            #ok(await* proposeAction(#swap({ fromToken; toToken; dex; amount; minReturn; slippageBps; quoteExpiresAt; reason })));
        };

        // ----- approval lifecycle (update; owner-only — excluded from agent_entrypoints) -----
        public func /*update*/approveTicket(ticketId : Nat) : async* OutcomeResult {
            var found : ?Ticket = null;
            for (ticket in mem.settlementTickets.vals()) { if (ticket.id == ticketId) found := ?ticket };
            let ticket = switch (found) { case (null) return #err(#TicketNotFound); case (?value) value };
            if (ticket.status != #pending) return #err(#AlreadyResolved);
            if (mem.settlementInFlight) return #err(#SettlementInFlight);
            // Re-classify at approval time: policy may have tightened since the
            // ticket was parked, and the breaker may have tripped.
            let (tier, currentError) = P.classify(ticket.action, mem.policy, P.spendIn(mem.spend, Time.now(), 3_600_000_000_000), P.spendIn(mem.spend, Time.now(), 86_400_000_000_000));
            if (tier == #Forbidden) return #err(switch (currentError) { case (?e) e; case (null) #CircuitBreakerActive });
            if (tier != #Escalation or currentError != ticket.policyError) return #err(switch (currentError) { case (?e) e; case (null) #AlreadyResolved });
            mem.settlementInFlight := true;
            mem.settlementLock := ?{ action = ticket.action; startedAt = Time.now() };
            let result = await* settle(ticket.action);
            mem.settlementInFlight := false;
            mem.settlementLock := null;
            switch (result) {
                case (#success(receipt)) {
                    mem.settlementTickets := Array.map<Ticket, Ticket>(mem.settlementTickets, func(t) { if (t.id == ticketId) ({ id = t.id; action = t.action; createdAt = t.createdAt; policyError = t.policyError; status = #approved(receipt) }) else t });
                    mem.spend := Array.concat(mem.spend, [{ timestamp = Time.now(); amount = amountOf(ticket.action) }]);
                    mem.policy := P.recordSuccess(mem.policy);
                    let id = addAudit(ticket.action, tier, currentError, ?result, ?ticketId, "owner approved and settled");
                    #ok({ tier; error = null; ticketId = ?ticketId; auditId = id; settlement = ?result });
                };
                case (#failure(e)) {
                    mem.policy := P.recordFailure(mem.policy);
                    ignore addAudit(ticket.action, tier, currentError, ?result, ?ticketId, "approval settlement failed");
                    #err(#ExternalFailure(e));
                };
            };
        };

        public func /*update*/rejectTicket(ticketId : Nat, reason : Text) : IdResult {
            var found = false;
            var pendingTicket = false;
            var action : ?Action = null;
            for (ticket in mem.settlementTickets.vals()) {
                if (ticket.id == ticketId) { found := true; pendingTicket := ticket.status == #pending; action := ?ticket.action };
            };
            if (not found) return #err(#TicketNotFound);
            if (not pendingTicket) return #err(#AlreadyResolved);
            mem.settlementTickets := Array.map<Ticket, Ticket>(mem.settlementTickets, func(t) { if (t.id == ticketId) ({ id = t.id; action = t.action; createdAt = t.createdAt; policyError = t.policyError; status = #rejected(reason) }) else t });
            let id = addAudit(switch (action) { case (?a) a; case (null) return #err(#TicketNotFound) }, #Escalation, null, null, ?ticketId, "owner rejected: " # reason);
            #ok(id);
        };

        // ----- admin (update; owner-only — excluded from agent_entrypoints) -----
        public func /*update*/setDexConfig(next : DexConfig) : UnitResult {
            if (next.feeTier == 0) return #err(#InvalidAmount);
            mem.dexConfig := next;
            #ok(());
        };

        public func /*update*/recoverSettlementLock() : UnitResult {
            switch (mem.settlementLock) {
                case null { mem.settlementInFlight := false; #ok(()) };
                case (?lock) {
                    // Only recoverable once demonstrably stale (5 min), so a live
                    // in-flight settlement can never be cleared out from under itself.
                    if (Time.now() - lock.startedAt < 300_000_000_000) return #err(#SettlementLockNotStale);
                    mem.settlementInFlight := false;
                    mem.settlementLock := null;
                    ignore addAudit(lock.action, #Forbidden, null, null, null, "owner recovered stale settlement lock");
                    #ok(());
                };
            };
        };

        public func /*update*/setPolicy(next : Policy) : UnitResult {
            mem.policy := next;
            #ok(());
        };

        public func /*update*/setCircuitBreaker(active : Bool) : UnitResult {
            mem.policy := { mem.policy with circuitBreaker = active };
            #ok(());
        };
    };
/*---NEUTRON GENERATED BEGIN---*/

public type getVaultState_Input = ();
public type getVaultState_Output = VaultStateResult;

public type getActivityHistory_Input = (limit : Nat, offset : Nat);
public type getActivityHistory_Output = ActivityResult;

public type getPendingApprovals_Input = ();
public type getPendingApprovals_Output = PendingResult;

public type syncBalance_Input = (token : Principal);
public type syncBalance_Output = BalanceResult;

public type proposeTransfer_Input = (token : Principal, recipient : Principal, amount : Nat, reason : Text);
public type proposeTransfer_Output = OutcomeResult;

public type proposeSwap_Input = (fromToken : Principal, toToken : Principal, dex : Principal, amount : Nat, minReturn : Nat, slippageBps : Nat, quoteExpiresAt : Int, reason : Text);
public type proposeSwap_Output = OutcomeResult;

public type approveTicket_Input = (ticketId : Nat);
public type approveTicket_Output = OutcomeResult;

public type rejectTicket_Input = (ticketId : Nat, reason : Text);
public type rejectTicket_Output = IdResult;

public type setDexConfig_Input = (next : DexConfig);
public type setDexConfig_Output = UnitResult;

public type recoverSettlementLock_Input = ();
public type recoverSettlementLock_Output = UnitResult;

public type setPolicy_Input = (next : Policy);
public type setPolicy_Output = UnitResult;

public type setCircuitBreaker_Input = (active : Bool);
public type setCircuitBreaker_Output = UnitResult;

/*---NEUTRON GENERATED END---*/
}
