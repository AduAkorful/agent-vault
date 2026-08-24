// Agent Vault backend — Neutron app module. The kernel assembles this class into
// the shared user-owned canister; there is no app actor or owner parameter.
// Authorization is kernel-mediated; the owner-vs-agent tier boundary is the
// manifest `agent_entrypoints` whitelist. Persistent fields live in the managed
// memory root. Settlement uses the constrained `backend_calls` capability for
// real ledger and ICPSwap calls. Swaps always require owner approval and use a
// recoverable transit path because pool calls cannot be safely retried. A decode
// miss or kernel #err becomes an explicit ExternalError, never a receipt.
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
import Nat64 "mo:core/Nat64";
import Blob "mo:core/Blob";
import Principal "mo:core/Principal";
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
    public type TokenLimits = { maxPerTx : Nat; maxHourlySpend : Nat; maxDailySpend : Nat };
    public type TokenLimit = { token : Principal; limits : TokenLimits };
    public type Allowlists = { recipients : [Principal]; dexes : [Principal]; pairs : [TokenPair] };
    public type Policy = {
        limits : [TokenLimit];
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
        #transfer : { token : Principal; blockIndex : Nat; fee : Nat };
        #swap : { dex : Principal; pool : Principal; transactionId : ?Nat; approvalBlockIndex : Nat; amountOut : Nat; fee : Nat };
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
        #TokenLimitNotConfigured;
        #InvalidPolicy;
        #SwapRequiresApproval;
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
    public type DepositAccount = { owner : Principal; subaccount : [Nat8] };
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
    // Full dashboard snapshot. Hourly/daily spend is derived at read time from
    // the token-tagged spend log.
    // Per-token spend within the rolling hourly/daily windows, fee-inclusive and
    // in the token's own base units. One entry per token that has configured
    // limits (the only tokens with a budget to measure against).
    public type TokenSpend = { token : Principal; hourly : Nat; daily : Nat };
    public type VaultState = {
        balances : [Balance];
        policy : Policy;
        spend : [TokenSpend];
        pending : [Ticket];
        audit : [AuditEntry];
        settlementInFlight : Bool;
        settlementLock : ?SettlementLock;
        dexConfig : DexConfig;
        depositAccount : DepositAccount;
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
        // The vault's isolated ICRC-1 account within the shared canister: our own
        // principal, but a non-zero app-namespaced subaccount — never the canister
        // default (all-zero) account (R6). Every balance read and every transfer
        // debit uses this; recipients still receive to their own default account.
        func vaultAccount() : IcrcTypes.Account {
            { owner = calls.canister_principal; subaccount = ?mem.vaultSubaccount };
        };

        func amountOf(action : Action) : Nat {
            switch (action) { case (#transfer(p)) p.amount; case (#swap(p)) p.amount };
        };

        // The token whose balance an action debits: the transferred token, or the
        // from-token of a swap. Per-token limits and spend windows key off this.
        func spendToken(action : Action) : Principal {
            switch (action) { case (#transfer(p)) p.token; case (#swap(p)) p.fromToken };
        };

        // Read the fee used for policy classification immediately before the
        // settlement path. Limits are fee-inclusive, so a stale cached fee is
        // unsafe: a ledger fee change must be reflected before an action can be
        // classified as autonomous.
        func liveFee(token : Principal) : async* { #ok : Nat; #err : VaultError } {
            if (not calls.can_call(token, "icrc1_fee")) {
                return #err(#ExternalFailure({ code = "TOKEN_NOT_RESERVED"; message = "ledger fee method is not reserved for the vault"; partial = false }));
            };
            switch (Icrc.decodeFee(await* calls.call(Icrc.feeRequest(token)))) {
                case (#ok(value)) #ok(value);
                case (#err(message)) #err(#ExternalFailure({ code = "LEDGER_REJECT"; message; partial = false }));
            };
        };

        func classificationFee(action : Action) : async* { #ok : Nat; #err : VaultError } {
            switch (action) {
                case (#transfer(p)) await* liveFee(p.token);
                case (#swap(_)) #ok(0);
            };
        };

        // The fee actually charged, extracted from a settlement receipt, so the
        // recorded spend reflects the true debit (amount + fee).
        func receiptFee(receipt : Receipt) : Nat {
            switch (receipt) { case (#transfer(t)) t.fee; case (#swap(t)) t.fee };
        };

        func defaultAccount() : IcrcTypes.Account {
            { owner = calls.canister_principal; subaccount = null };
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
        // monotonic counter for both audit ids and ticket ids. Retention is
        // bounded so an active vault cannot grow managed memory without limit.
        let activityRetention : Nat = 1_000;
        let dashboardActivityWindow : Nat = 100;
        let resolvedTicketRetention : Nat = 1_000;

        func recentActivity(limit : Nat) : [AuditEntry] {
            let size = mem.activity.size();
            let count = Nat.min(limit, size);
            if (count == 0) return [];
            Array.tabulate<AuditEntry>(count, func(i) { mem.activity[size - count + i] });
        };

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
            let updated = Array.concat(mem.activity, [{ id; action; tier; policyError; settlement; timestamp = Time.now(); ticketId; note }]);
            let size = updated.size();
            mem.activity := if (size <= activityRetention) updated else Array.tabulate<AuditEntry>(activityRetention, func(i) { updated[size - activityRetention + i] });
            id;
        };

        func pending() : [Ticket] {
            Array.filter<Ticket>(mem.settlementTickets, func(t) { t.status == #pending });
        };

        // Pending approvals are never discarded. Resolved tickets are retained
        // only as a bounded recent window so repeated agent activity cannot grow
        // managed memory without limit while the approval inbox remains complete.
        func retainTickets(tickets : [Ticket]) : [Ticket] {
            let pendingTickets = Array.filter<Ticket>(tickets, func(t) { t.status == #pending });
            let resolved = Array.filter<Ticket>(tickets, func(t) { t.status != #pending });
            let keep = Nat.min(resolvedTicketRetention, resolved.size());
            let recentResolved = if (keep == 0) [] else Array.tabulate<Ticket>(keep, func(i) { resolved[resolved.size() - keep + i] });
            Array.concat(pendingTickets, recentResolved);
        };

        func approveRecoveredTicket(ticketId : ?Nat, receipt : Receipt) {
            switch (ticketId) {
                case null {};
                case (?id) {
                    mem.settlementTickets := retainTickets(Array.map<Ticket, Ticket>(mem.settlementTickets, func(ticket) {
                        if (ticket.id == id and ticket.status == #pending) {
                            {
                                id = ticket.id;
                                action = ticket.action;
                                createdAt = ticket.createdAt;
                                policyError = ticket.policyError;
                                status = #approved(receipt);
                            };
                        } else ticket;
                    }));
                };
            };
        };

        // ----- durable idempotency (R8) -----
        // An 8-byte big-endian memo derived from a per-settlement intent id. Two
        // intents can never share a memo (the id is drawn from the monotonic
        // nextId counter), so even settlements that happened to share a
        // created_at_time carry distinct idempotency keys — and a reconciling
        // re-submit that reuses the SAME (created_at_time, memo) is deduplicated
        // by the ledger rather than debiting twice.
        func memoOf(id : Nat64) : Blob {
            func byte(shift : Nat64) : Nat8 { Nat64.toNat8((id >> shift) & 0xff) };
            Blob.fromArray([byte(56), byte(48), byte(40), byte(32), byte(24), byte(16), byte(8), byte(0)]);
        };

        // Submit the transfer leg with a durable idempotency key and return the
        // decoded ledger result. Shared by first-attempt settlement and by
        // reconciliation (recoverSettlementLock): a re-submit carrying the same
        // (from_subaccount, to, amount, fee, memo, created_at_time) is deduplicated
        // by the ledger, so the caller can tell "already committed" (#Duplicate)
        // from "not yet" (#Ok) without ever risking a double debit. The debit is
        // from the isolated vault subaccount; the recipient receives to their own
        // default account.
        func rawTransferLeg(
            token : Principal,
            fromSubaccount : ?Blob,
            destination : IcrcTypes.Account,
            amount : Nat,
            fee : Nat,
            createdAtTime : Nat64,
            memo : Blob,
        ) : async* IcrcTypes.Result<IcrcTypes.TransferResult> {
            Icrc.decodeTransfer(await* calls.call(Icrc.transferRequest(token, fromSubaccount, destination, amount, fee, ?createdAtTime, ?memo)));
        };

        func rawTransfer(p : TransferProposal, fee : Nat, createdAtTime : Nat64, memo : Blob) : async* IcrcTypes.Result<IcrcTypes.TransferResult> {
            let destination : IcrcTypes.Account = { owner = p.recipient; subaccount = null };
            await* rawTransferLeg(p.token, ?mem.vaultSubaccount, destination, p.amount, fee, createdAtTime, memo);
        };

        func setIntent(
            action : Action,
            stage : V.SettlementStage,
            amount : Nat,
            fee : Nat,
            pool : ?Principal,
            fromToken : ?Principal,
            toToken : ?Principal,
            fromFee : Nat,
            toFee : Nat,
            zeroForOne : Bool,
            amountOut : Nat,
            approvalBlockIndex : ?Nat,
            expiresAt : ?Int,
        ) : V.SettlementIntent {
            let intentId = mem.nextId;
            mem.nextId += 1;
            let intent : V.SettlementIntent = {
                stage;
                createdAtTime = Nat64.fromIntWrap(Time.now());
                memo = memoOf(Nat64.fromNat(intentId));
                fee;
                amount;
                pool;
                fromToken;
                toToken;
                fromFee;
                toFee;
                zeroForOne;
                amountOut;
                approvalBlockIndex;
                expiresAt;
            };
            let (startedAt, ticketId) = switch (mem.settlementLock) {
                case (?lock) (lock.startedAt, lock.ticketId);
                case null (Time.now(), null);
            };
            mem.settlementLock := ?{ action; startedAt; ticketId; intent = ?intent };
            intent;
        };

        func replaceIntent(action : Action, intent : V.SettlementIntent) {
            let (startedAt, ticketId) = switch (mem.settlementLock) {
                case (?lock) (lock.startedAt, lock.ticketId);
                case null (Time.now(), null);
            };
            mem.settlementLock := ?{ action; startedAt; ticketId; intent = ?intent };
        };

        // ----- settlement (real ICRC-1 over the backend_calls capability) -----
        // Settle a transfer on the token's own ledger: read the current fee,
        // guard the fee-inclusive balance, then submit icrc1_transfer and map the
        // returned block index into a receipt. A decode miss or a kernel #err
        // becomes an honest ExternalError — never a fabricated receipt (ADR-004).
        func settleTransfer(p : TransferProposal, fee : Nat) : async* Settlement {
            let ledger = p.token;
            if (not calls.can_call(ledger, "icrc1_fee") or not calls.can_call(ledger, "icrc1_balance_of") or not calls.can_call(ledger, "icrc1_transfer")) {
                return external("TOKEN_NOT_RESERVED", "ledger is not reserved for the vault under backend_calls", false);
            };
            // Re-read after the classification await. If the ledger changed its
            // fee in the meantime, refuse the autonomous debit rather than
            // settling under a stale fee-inclusive policy decision.
            let settlementFee = switch (Icrc.decodeFee(await* calls.call(Icrc.feeRequest(ledger)))) {
                case (#ok(value)) value;
                case (#err(message)) return external("LEDGER_UNKNOWN", message, true);
            };
            if (settlementFee != fee) return external("FEE_CHANGED", "ledger fee changed after policy classification; re-propose with the current fee", false);
            let balance = switch (Icrc.decodeBalance(await* calls.call(Icrc.balanceRequest(ledger, vaultAccount())))) {
                case (#ok(value)) value;
                case (#err(message)) return external("LEDGER_UNKNOWN", message, true);
            };
            // The ledger debits amount + fee, so a balance that only covers the
            // amount would be rejected at the ledger. Fail early with a typed error.
            if (balance < p.amount + fee) {
                return external("INSUFFICIENT_BALANCE", "balance " # Nat.toText(balance) # " < amount+fee " # Nat.toText(p.amount + fee), false);
            };
            // Mint a durable idempotency key and upgrade the settlement lock with
            // it BEFORE the transfer await. Everything above this point was
            // read-only (fee/balance queries): if a query trapped, the lock still
            // has intent = null and recovery clears it safely, because no debit was
            // sent. From here on the lock carries an intent, so if the response is
            // lost or traps AFTER the ledger recorded the debit, recovery re-submits
            // this exact key and the ledger dedups it. The captured fee is the one
            // hashed into the transaction, so the re-submit matches byte-for-byte.
            let intent = setIntent(#transfer(p), #transfer, p.amount, fee, null, ?p.token, null, fee, 0, false, 0, null, null);
            // Promote #Duplicate to success: the ledger already recorded this exact
            // transfer at block duplicate_of, so it is a completed debit — not a
            // failure to be retried (which would be the double-spend R8 warns of).
            switch (await* rawTransfer(p, fee, intent.createdAtTime, intent.memo)) {
                case (#ok(#Ok(blockIndex))) #success(#transfer({ token = p.token; blockIndex; fee }));
                case (#ok(#Err(#Duplicate({ duplicate_of })))) #success(#transfer({ token = p.token; blockIndex = duplicate_of; fee }));
                case (#ok(#Err(#TemporarilyUnavailable))) external("LEDGER_UNKNOWN", "ledger is temporarily unavailable; recovery must reconcile the durable transfer intent", true);
                case (#ok(#Err(#GenericError(_)))) external("LEDGER_UNKNOWN", "ledger returned a generic error; recovery must reconcile the durable transfer intent", true);
                case (#ok(#Err(#TooOld))) external("LEDGER_UNKNOWN", "transfer idempotency key is too old; recovery must confirm the original outcome", true);
                case (#ok(#Err(#CreatedInFuture(_)))) external("LEDGER_UNKNOWN", "transfer idempotency key is ahead of ledger time; recovery must confirm the original outcome", true);
                case (#ok(#Err(txError))) external("LEDGER_ERROR", Icrc.transferErrorText(txError), false);
                case (#err(message)) external("LEDGER_UNKNOWN", message, true);
            };
        };

        // ICPSwap uses the shared canister's default account as its user key, so
        // the isolated vault subaccount must transit through that account. The
        // transit is deliberately short-lived and requires both the default
        // ledger accounts and the pool's unused balances to be empty first; this
        // prevents a sweep from consuming funds owned by another app in the
        // shared canister. Every ICRC leg has its own durable key. The pool call
        // itself is never retried: recovery inspects the pool balance instead.
        func settleSwap(p : SwapProposal) : async* Settlement {
            if (p.slippageBps > 10_000) return external("INVALID_SLIPPAGE", "slippageBps must be at most 10000", false);
            if (Time.now() > p.quoteExpiresAt) return external("QUOTE_EXPIRED", "quote deadline passed before settlement", false);
            if (not P.contains(mem.policy.allowlists.dexes, p.dex)) return external("DEX_NOT_ALLOWED", "DEX is not in the policy allowlist", false);
            if (p.dex != mem.dexConfig.factory) return external("DEX_NOT_CONFIGURED", "proposal dex does not match the configured ICPSwap factory", false);
            if (not P.pairAllowed(mem.policy.allowlists.pairs, p.fromToken, p.toToken)) return external("PAIR_NOT_ALLOWED", "token pair is not in the policy allowlist", false);
            if (not calls.can_call(p.fromToken, "icrc1_supported_standards") or not calls.can_call(p.fromToken, "icrc1_fee") or not calls.can_call(p.fromToken, "icrc1_balance_of") or not calls.can_call(p.fromToken, "icrc1_transfer") or not calls.can_call(p.fromToken, "icrc2_approve")) return external("TOKEN_NOT_RESERVED", "input ledger is not reserved for the swap", false);
            if (not calls.can_call(p.toToken, "icrc1_supported_standards") or not calls.can_call(p.toToken, "icrc1_fee") or not calls.can_call(p.toToken, "icrc1_balance_of") or not calls.can_call(p.toToken, "icrc1_transfer")) return external("TOKEN_NOT_RESERVED", "output ledger is not reserved for the swap", false);
            if (not calls.can_call(p.dex, "getPool")) return external("DEX_NOT_RESERVED", "configured factory is not reserved for the vault", false);

            let fromStandards = switch (Icrc.decodeSupportedStandards(await* calls.call(Icrc.supportedStandardsRequest(p.fromToken)))) {
                case (#ok(value)) value;
                case (#err(message)) return external("LEDGER_REJECT", message, false);
            };
            if (not hasStandard(fromStandards, "ICRC-2")) return external("UNSUPPORTED_TOKEN", "ICPSwap depositFromAndSwap requires ICRC-2 input approval", false);
            let toStandards = switch (Icrc.decodeSupportedStandards(await* calls.call(Icrc.supportedStandardsRequest(p.toToken)))) {
                case (#ok(value)) value;
                case (#err(message)) return external("LEDGER_REJECT", message, false);
            };
            if (not supportsICRC1(toStandards)) return external("UNSUPPORTED_TOKEN", "output token does not support ICRC-1", false);
            let fromFee = switch (Icrc.decodeFee(await* calls.call(Icrc.feeRequest(p.fromToken)))) {
                case (#ok(value)) value;
                case (#err(message)) return external("LEDGER_REJECT", message, false);
            };
            let toFee = switch (Icrc.decodeFee(await* calls.call(Icrc.feeRequest(p.toToken)))) {
                case (#ok(value)) value;
                case (#err(message)) return external("LEDGER_REJECT", message, false);
            };

            let vaultBalance = switch (Icrc.decodeBalance(await* calls.call(Icrc.balanceRequest(p.fromToken, vaultAccount())))) {
                case (#ok(value)) value;
                case (#err(message)) return external("LEDGER_REJECT", message, false);
            };
            // The vault pays three source-token ledger fees: the transfer into
            // the shared default transit account, icrc2_approve itself, and the
            // pool's depositFromAndSwap pull (`amountIn + tokenInFee`).
            if (vaultBalance < p.amount + (fromFee * 3)) return external("INSUFFICIENT_BALANCE", "input balance does not cover swap amount and all input-side fees", false);

            let defaultFromBalance = switch (Icrc.decodeBalance(await* calls.call(Icrc.balanceRequest(p.fromToken, defaultAccount())))) {
                case (#ok(value)) value;
                case (#err(message)) return external("LEDGER_REJECT", message, false);
            };
            let defaultToBalance = switch (Icrc.decodeBalance(await* calls.call(Icrc.balanceRequest(p.toToken, defaultAccount())))) {
                case (#ok(value)) value;
                case (#err(message)) return external("LEDGER_REJECT", message, false);
            };
            if (defaultFromBalance != 0 or defaultToBalance != 0) return external("DEFAULT_ACCOUNT_NOT_EMPTY", "swap transit requires empty default ledger accounts to preserve custody isolation", false);

            let poolData = switch (Icrc.decodePool(await* calls.call(Icrc.getPoolRequest(p.dex, { fee = mem.dexConfig.feeTier; token0 = { address = Principal.toText(p.fromToken); standard = "ICRC2" }; token1 = { address = Principal.toText(p.toToken); standard = if (hasStandard(toStandards, "ICRC-2")) "ICRC2" else "ICRC1" } })))) {
                case (#ok(#ok(value))) value;
                case (#ok(#err(value))) return external("POOL_NOT_FOUND", Icrc.dexErrorText(value), false);
                case (#err(message)) return external("DEX_REJECT", message, false);
            };
            let pool = poolData.canisterId;
            if (not calls.can_call(pool, "quote") or not calls.can_call(pool, "depositFromAndSwap") or not calls.can_call(pool, "withdraw") or not calls.can_call(pool, "getUserUnusedBalance")) return external("POOL_NOT_RESERVED", "discovered pool method is not covered by the vault reservation", false);
            let zeroForOne = poolData.token0.address == Principal.toText(p.fromToken);
            let unusedBefore = switch (Icrc.decodeUnusedBalance(await* calls.call(Icrc.getUserUnusedBalanceRequest(pool, calls.canister_principal)))) {
                case (#ok(#ok(value))) value;
                case (#ok(#err(value))) return external("POOL_REJECT", Icrc.dexErrorText(value), false);
                case (#err(message)) return external("DEX_REJECT", message, false);
            };
            if (unusedBefore.balance0 != 0 or unusedBefore.balance1 != 0) return external("POOL_ACCOUNT_NOT_EMPTY", "swap requires an empty ICPSwap unused balance for the shared canister principal", false);

            let quoted = switch (Icrc.decodeDexNat(await* calls.call(Icrc.quoteRequest(pool, { amountIn = Nat.toText(p.amount); amountOutMinimum = "0"; zeroForOne })), "quote")) {
                case (#ok(#ok(value))) value;
                case (#ok(#err(value))) return external("QUOTE_FAILED", Icrc.dexErrorText(value), false);
                case (#err(message)) return external("DEX_REJECT", message, false);
            };
            let keepBps = 10_000 - p.slippageBps;
            let slippageFloor = quoted * keepBps / 10_000;
            if (p.minReturn < slippageFloor or p.minReturn > quoted) return external("INVALID_MIN_RETURN", "minReturn is outside the quote/slippage bounds", false);
            if (Time.now() > p.quoteExpiresAt) return external("QUOTE_EXPIRED", "quote deadline passed before input transit", false);

            // Leave exactly enough in the default account for the approval fee
            // and the pool pull fee. The transit transfer itself charges one
            // additional fee from the isolated vault subaccount.
            let transitAmount = p.amount + (fromFee * 2);
            let transit = setIntent(#swap(p), #swapTransit, transitAmount, fromFee, ?pool, ?p.fromToken, ?p.toToken, fromFee, toFee, zeroForOne, 0, null, ?p.quoteExpiresAt);
            switch (await* rawTransferLeg(p.fromToken, ?mem.vaultSubaccount, defaultAccount(), transitAmount, fromFee, transit.createdAtTime, transit.memo)) {
                case (#ok(#Ok(_))) {};
                case (#ok(#Err(#Duplicate(_)))) {};
                case (#ok(#Err(#TemporarilyUnavailable))) return external("TRANSIT_UNKNOWN", "input transit outcome is unknown; recovery must reconcile the durable transfer intent", true);
                case (#ok(#Err(#TooOld))) return external("TRANSIT_UNKNOWN", "input transit idempotency key is too old; recovery must confirm the original outcome", true);
                case (#ok(#Err(#CreatedInFuture(_)))) return external("TRANSIT_UNKNOWN", "input transit idempotency key is ahead of ledger time; recovery must confirm the original outcome", true);
                case (#ok(#Err(error))) return external("TRANSIT_FAILED", Icrc.transferErrorText(error), false);
                case (#err(message)) return external("TRANSIT_UNKNOWN", message, true);
            };

            let approvalAmount = p.amount + fromFee;
            let approval = setIntent(#swap(p), #approval, approvalAmount, fromFee, ?pool, ?p.fromToken, ?p.toToken, fromFee, toFee, zeroForOne, 0, null, ?p.quoteExpiresAt);
            // An approval duplicate proves that this exact approval already
            // committed. It is therefore safe to continue with the pool call;
            // treating it as a partial failure would unnecessarily revoke a
            // valid approval and strand an otherwise executable ticket.
            func continueAfterApproval(blockIndex : Nat) : async* Settlement {
                ignore setIntent(#swap(p), #poolSwap, p.amount, 0, ?pool, ?p.fromToken, ?p.toToken, fromFee, toFee, zeroForOne, 0, ?blockIndex, ?p.quoteExpiresAt);
                if (Time.now() > p.quoteExpiresAt) return external("QUOTE_EXPIRED_AFTER_APPROVAL", "quote deadline passed after approval", true);
                switch (Icrc.decodeDexNat(await* calls.call(Icrc.depositFromAndSwapRequest(pool, { amountIn = Nat.toText(p.amount); amountOutMinimum = Nat.toText(p.minReturn); tokenInFee = fromFee; tokenOutFee = toFee; zeroForOne })), "swap")) {
                    case (#ok(#err(value))) return external("SWAP_FAILED", Icrc.dexErrorText(value), true);
                    case (#err(message)) return external("SWAP_UNKNOWN", message, true);
                    case (#ok(#ok(amountOut))) {
                        if (amountOut < p.minReturn) return external("INVALID_SWAP_OUTPUT", "pool returned less than the requested minimum", true);
                        let unused = switch (Icrc.decodeUnusedBalance(await* calls.call(Icrc.getUserUnusedBalanceRequest(pool, calls.canister_principal)))) {
                            case (#ok(#ok(value))) value;
                            case (#ok(#err(value))) return external("POOL_REJECT", Icrc.dexErrorText(value), true);
                            case (#err(message)) return external("DEX_REJECT", message, true);
                        };
                        let outputUnused = if (zeroForOne) unused.balance1 else unused.balance0;
                        if (outputUnused != amountOut) return external("SWAP_OUTPUT_PENDING", "ICPSwap output is not yet present as an exact unused balance; recovery must inspect it later", true);
                        let withdraw = setIntent(#swap(p), #withdraw, amountOut, toFee, ?pool, ?p.fromToken, ?p.toToken, fromFee, toFee, zeroForOne, amountOut, ?blockIndex, ?p.quoteExpiresAt);
                        switch (Icrc.decodeDexNat(await* calls.call(Icrc.withdrawRequest(pool, { amount = amountOut; fee = toFee; token = Principal.toText(p.toToken) })), "withdraw")) {
                            case (#ok(#err(value))) {
                                // The pool definitively rejected this withdrawal, so
                                // no output reached the default account. Restore the
                                // observable pool stage: recovery can inspect the
                                // still-stranded unused output and retry only after
                                // proving that the rejected mutation did not commit.
                                replaceIntent(#swap(p), { withdraw with stage = #poolSwap });
                                return external("WITHDRAW_FAILED", Icrc.dexErrorText(value), true);
                            };
                            case (#err(message)) return external("WITHDRAW_UNKNOWN", message, true);
                            case (#ok(#ok(_))) {
                                let defaultOutput = switch (Icrc.decodeBalance(await* calls.call(Icrc.balanceRequest(p.toToken, defaultAccount())))) {
                                    case (#ok(value)) value;
                                    case (#err(message)) return external("LEDGER_REJECT", message, true);
                                };
                                if (amountOut <= toFee or defaultOutput != amountOut - toFee) return external("WITHDRAW_AMOUNT_MISMATCH", "withdraw did not credit the expected net output to the isolated transit account", true);
                                let sweepAmount = defaultOutput - toFee;
                                let sweep = setIntent(#swap(p), #sweep, sweepAmount, toFee, ?pool, ?p.fromToken, ?p.toToken, fromFee, toFee, zeroForOne, sweepAmount, ?blockIndex, ?p.quoteExpiresAt);
                                switch (await* rawTransferLeg(p.toToken, null, vaultAccount(), sweepAmount, toFee, sweep.createdAtTime, sweep.memo)) {
                                    case (#ok(#Ok(_))) #success(#swap({ dex = p.dex; pool; transactionId = null; approvalBlockIndex = blockIndex; amountOut = sweepAmount; fee = fromFee * 3 }));
                                    case (#ok(#Err(#Duplicate(_)))) #success(#swap({ dex = p.dex; pool; transactionId = null; approvalBlockIndex = blockIndex; amountOut = sweepAmount; fee = fromFee * 3 }));
                                    case (#ok(#Err(error))) external("SWEEP_FAILED", Icrc.transferErrorText(error), true);
                                    case (#err(message)) external("SWEEP_UNKNOWN", message, true);
                                };
                            };
                        };
                    };
                };
            };
            switch (Icrc.decodeApprove(await* calls.call(Icrc.approveRequest(p.fromToken, null, { owner = pool; subaccount = null }, approvalAmount, fromFee, null, null, ?approval.createdAtTime, ?approval.memo)))) {
                case (#ok(#Ok(blockIndex))) await* continueAfterApproval(blockIndex);
                case (#ok(#Err(#Duplicate({ duplicate_of })))) await* continueAfterApproval(duplicate_of);
                case (#ok(#Err(#TemporarilyUnavailable))) external("APPROVAL_UNKNOWN", "approval outcome is unknown; recovery must reconcile the durable approval intent", true);
                case (#ok(#Err(#TooOld))) external("APPROVAL_UNKNOWN", "approval idempotency key is too old; recovery must confirm the original outcome", true);
                case (#ok(#Err(#CreatedInFuture(_)))) external("APPROVAL_UNKNOWN", "approval idempotency key is ahead of ledger time; recovery must confirm the original outcome", true);
                case (#ok(#Err(error))) {
                    let defaultBalance = switch (Icrc.decodeBalance(await* calls.call(Icrc.balanceRequest(p.fromToken, defaultAccount())))) {
                        case (#ok(value)) value;
                        case (#err(message)) return external("APPROVAL_FAILED_TRANSIT_UNKNOWN", message, true);
                    };
                    if (defaultBalance != approvalAmount + fromFee) return external("APPROVAL_FAILED_TRANSIT_UNKNOWN", "approval failed but the default input balance does not exactly match this swap's transit funds", true);
                    let unwind = setIntent(#swap(p), #sweep, defaultBalance - fromFee, fromFee, ?pool, ?p.fromToken, ?p.toToken, fromFee, toFee, zeroForOne, 0, null, ?p.quoteExpiresAt);
                    switch (await* rawTransferLeg(p.fromToken, null, vaultAccount(), unwind.amount, fromFee, unwind.createdAtTime, unwind.memo)) {
                        case (#ok(#Ok(_))) external("APPROVAL_FAILED", Icrc.approveErrorText(error), false);
                        case (#ok(#Err(#Duplicate(_)))) external("APPROVAL_FAILED", Icrc.approveErrorText(error), false);
                        case (#ok(#Err(transferError))) external("APPROVAL_FAILED_TRANSIT_UNWIND", Icrc.transferErrorText(transferError), true);
                        case (#err(message)) external("APPROVAL_FAILED_TRANSIT_UNWIND", message, true);
                    };
                };
                case (#err(message)) external("APPROVAL_UNKNOWN", message, true);
            };
        };

        // Dispatch settlement by action. Swaps always arrive here from an owner
        // approval ticket because Policy.classify never makes them autonomous.
        func settle(action : Action, transferFee : Nat) : async* Settlement {
            switch (action) {
                case (#transfer(p)) await* settleTransfer(p, transferFee);
                case (#swap(p)) await* settleSwap(p);
            };
        };

        // Sync one token's identity + live balance from its ledger. Reads
        // supported standards, symbol, decimals, fee, and balance with individual
        // ICRC-1 queries. decimals/fee are read, never
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
            let amount = switch (Icrc.decodeBalance(await* calls.call(Icrc.balanceRequest(ledger, vaultAccount())))) {
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
            let token = spendToken(action);
            let fee = switch (await* classificationFee(action)) {
                case (#ok(value)) value;
                case (#err(error)) {
                    let id = addAudit(action, #Forbidden, ?error, null, null, "live fee unavailable; autonomous classification refused");
                    return { tier = #Forbidden; error = ?error; ticketId = null; auditId = id; settlement = null };
                };
            };
            let hourly = P.spendIn(mem.spend, token, Time.now(), 3_600_000_000_000);
            let daily = P.spendIn(mem.spend, token, Time.now(), 86_400_000_000_000);
            let (tier, policyError) = P.classify(action, mem.policy, fee, hourly, daily);
            if (tier == #Forbidden) {
                let id = addAudit(action, tier, policyError, null, null, "policy rejected");
                return { tier; error = policyError; ticketId = null; auditId = id; settlement = null };
            };
            if (tier == #Escalation) {
                let ticketId = mem.nextId;
                mem.nextId += 1;
                mem.settlementTickets := retainTickets(Array.concat(mem.settlementTickets, [{ id = ticketId; action; createdAt = Time.now(); policyError; status = #pending }]));
                let id = addAudit(action, tier, policyError, null, ?ticketId, "pending approval");
                return { tier; error = policyError; ticketId = ?ticketId; auditId = id; settlement = null };
            };
            if (mem.settlementInFlight) {
                let id = addAudit(action, tier, null, null, null, "settlement lock rejected");
                return { tier; error = ?#SettlementInFlight; ticketId = null; auditId = id; settlement = null };
            };
            mem.settlementInFlight := true;
            mem.settlementLock := ?{ action; startedAt = Time.now(); ticketId = null; intent = null };
            let result = await* settle(action, fee);
            switch (result) {
                case (#success(_)) { mem.settlementInFlight := false; mem.settlementLock := null };
                case (#failure(error)) {
                    // A partial result means an external leg may have committed
                    // while its response was lost. Keep the durable lock and the
                    // in-flight guard until recoverSettlementLock reconciles it.
                    if (not error.partial) { mem.settlementInFlight := false; mem.settlementLock := null };
                };
            };
            switch (result) {
                case (#success(receipt)) {
                    mem.spend := Array.concat(mem.spend, [{ timestamp = Time.now(); token; amount = amountOf(action); fee = receiptFee(receipt) }]);
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
            let now = Time.now();
            #ok({
                balances = mem.liveBalances;
                policy = mem.policy;
                spend = Array.map<V.TokenLimit, TokenSpend>(mem.policy.limits, func(tl) {
                    {
                        token = tl.token;
                        hourly = P.spendIn(mem.spend, tl.token, now, 3_600_000_000_000);
                        daily = P.spendIn(mem.spend, tl.token, now, 86_400_000_000_000);
                    };
                });
                pending = pending();
                audit = recentActivity(dashboardActivityWindow);
                settlementInFlight = mem.settlementInFlight;
                // Project away the idempotency intent: the dashboard only needs to
                // know a settlement is mid-flight/stuck (presence) and what it was;
                // the memo/created_at_time key is backend-only reconciliation detail.
                settlementLock = switch (mem.settlementLock) {
                    case null null;
                    case (?lock) ?{ action = lock.action; startedAt = lock.startedAt };
                };
                dexConfig = mem.dexConfig;
                depositAccount = { owner = calls.canister_principal; subaccount = Blob.toArray(mem.vaultSubaccount) };
            });
        };

        // NB: activity is stored oldest-first; the dashboard pages from the tail
        // for recent-first display.
        public func /*query*/getActivityHistory(limit : Nat, offset : Nat) : ActivityResult {
            let size = mem.activity.size();
            if (offset >= size) return #ok([]);
            let count = Nat.min(Nat.min(limit, activityRetention), size - offset);
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

        // Swaps are real but never autonomous: every proposal parks as an owner
        // approval ticket before the ICPSwap round trip can begin. It is not
        // exposed as an agent tool in v1.
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
            let token = spendToken(ticket.action);
            let fee = switch (await* classificationFee(ticket.action)) {
                case (#ok(value)) value;
                case (#err(error)) return #err(error);
            };
            let (tier, currentError) = P.classify(ticket.action, mem.policy, fee, P.spendIn(mem.spend, token, Time.now(), 3_600_000_000_000), P.spendIn(mem.spend, token, Time.now(), 86_400_000_000_000));
            if (tier == #Forbidden) return #err(switch (currentError) { case (?e) e; case (null) #CircuitBreakerActive });
            if (tier != #Escalation or currentError != ticket.policyError) return #err(switch (currentError) { case (?e) e; case (null) #AlreadyResolved });
            mem.settlementInFlight := true;
            mem.settlementLock := ?{ action = ticket.action; startedAt = Time.now(); ticketId = ?ticketId; intent = null };
            let result = await* settle(ticket.action, fee);
            switch (result) {
                case (#success(_)) { mem.settlementInFlight := false; mem.settlementLock := null };
                case (#failure(error)) {
                    if (not error.partial) { mem.settlementInFlight := false; mem.settlementLock := null };
                };
            };
            switch (result) {
                case (#success(receipt)) {
                    mem.settlementTickets := retainTickets(Array.map<Ticket, Ticket>(mem.settlementTickets, func(t) { if (t.id == ticketId) ({ id = t.id; action = t.action; createdAt = t.createdAt; policyError = t.policyError; status = #approved(receipt) }) else t }));
                    mem.spend := Array.concat(mem.spend, [{ timestamp = Time.now(); token; amount = amountOf(ticket.action); fee = receiptFee(receipt) }]);
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
            mem.settlementTickets := retainTickets(Array.map<Ticket, Ticket>(mem.settlementTickets, func(t) { if (t.id == ticketId) ({ id = t.id; action = t.action; createdAt = t.createdAt; policyError = t.policyError; status = #rejected(reason) }) else t }));
            let id = addAudit(switch (action) { case (?a) a; case (null) return #err(#TicketNotFound) }, #Escalation, null, null, ?ticketId, "owner rejected: " # reason);
            #ok(id);
        };

        // ----- admin (update; owner-only — excluded from agent_entrypoints) -----
        public func /*update*/setDexConfig(next : DexConfig) : UnitResult {
            if (next.feeTier == 0) return #err(#InvalidAmount);
            if (next.factory != Principal.fromText("4mmnk-kiaaa-aaaag-qbllq-cai")) return #err(#DexNotAllowed);
            mem.dexConfig := next;
            #ok(());
        };

        // Reconcile a stuck settlement instead of blindly unlocking it (R8). A lock
        // persists only when a settlement's response was lost or trapped, leaving the
        // true on-chain outcome unknown. We never guess: once the lock is stale we
        // RE-SUBMIT the stored intent with the identical idempotency key, and the
        // ledger tells us the truth — #Duplicate means the debit already committed
        // (so we record it, no double-spend), #Ok means it never did (so it commits
        // now). Only then is the lock cleared. A lock with no intent never reached
        // the ledger and is cleared directly. If the outcome still can't be
        // established (the re-submit fell outside the ledger's dedup window, or the
        // reconciliation call itself failed) we STAY locked — failing safe beats
        // re-paying on a guess.
        public func /*update*/recoverSettlementLock() : async* UnitResult {
            switch (mem.settlementLock) {
                case null { mem.settlementInFlight := false; #ok(()) };
                case (?lock) {
                    // Only recoverable once demonstrably stale (5 min), so a genuinely
                    // in-flight settlement is never disturbed mid-flight.
                    if (Time.now() - lock.startedAt < 300_000_000_000) return #err(#SettlementLockNotStale);
                    switch (lock.intent) {
                        case null {
                            // No debit was ever submitted (a query trapped before the
                            // transfer). Nothing to reconcile; clear it.
                            mem.settlementInFlight := false;
                            mem.settlementLock := null;
                            ignore addAudit(lock.action, #Escalation, null, null, null, "recovered pre-submit lock (no ledger write occurred)");
                            #ok(());
                        };
                        case (?intent) {
                            switch (lock.action) {
                                case (#transfer(p)) {
                                    // Both #Ok and #Duplicate mean the funds moved exactly
                                    // once: record the fee-inclusive spend, clear the lock.
                                    func commit(blockIndex : Nat, note : Text) : UnitResult {
                                        let receipt : Receipt = #transfer({ token = p.token; blockIndex; fee = intent.fee });
                                        mem.spend := Array.concat(mem.spend, [{ timestamp = Time.now(); token = p.token; amount = p.amount; fee = intent.fee }]);
                                        mem.policy := P.recordSuccess(mem.policy);
                                        approveRecoveredTicket(lock.ticketId, receipt);
                                        mem.settlementInFlight := false;
                                        mem.settlementLock := null;
                                        ignore addAudit(lock.action, #Autonomous, null, ?#success(receipt), lock.ticketId, note);
                                        #ok(());
                                    };
                                    // Outcome unknown: stay locked (never re-pay on a guess).
                                    func inconclusive(reason : Text) : UnitResult {
                                        ignore addAudit(lock.action, #Forbidden, null, null, null, "reconciliation inconclusive: " # reason);
                                        #err(#ExternalFailure({ code = "RECONCILE_INCONCLUSIVE"; message = reason; partial = true }));
                                    };
                                    switch (await* rawTransfer(p, intent.fee, intent.createdAtTime, intent.memo)) {
                                        case (#ok(#Ok(blockIndex))) commit(blockIndex, "reconciled: settled on re-submit (original never committed)");
                                        case (#ok(#Err(#Duplicate({ duplicate_of })))) commit(duplicate_of, "reconciled: original settlement already committed (ledger duplicate)");
                                        case (#ok(#Err(#TooOld))) inconclusive("created_at_time older than the ledger dedup window (~24h); confirm the original outcome against the ledger block log");
                                        case (#ok(#Err(#CreatedInFuture(_)))) inconclusive("created_at_time ahead of ledger time; retry recovery once clocks agree");
                                        case (#ok(#Err(#TemporarilyUnavailable))) inconclusive("ledger is temporarily unavailable; retry recovery without clearing the lock");
                                        case (#ok(#Err(#GenericError(error)))) inconclusive("ledger returned a generic error (" # Nat.toText(error.error_code) # "): " # error.message);
                                        case (#ok(#Err(txError))) {
                                            // The ledger checks dedup BEFORE balance/fee, so a
                                            // deterministic rejection here proves no duplicate
                                            // existed — the original debit never committed.
                                            mem.policy := P.recordFailure(mem.policy);
                                            mem.settlementInFlight := false;
                                            mem.settlementLock := null;
                                            ignore addAudit(lock.action, #Autonomous, null, ?external("LEDGER_ERROR", Icrc.transferErrorText(txError), false), null, "reconciled: original settlement did not commit (" # Icrc.transferErrorText(txError) # ")");
                                            #ok(());
                                        };
                                        case (#err(message)) inconclusive("reconciliation call failed: " # message);
                                    };
                                };
                                case (#swap(p)) {
                                    // Pool calls are never re-submitted. Recovery only
                                    // observes the pool's shared unused balance and
                                    // unwinds a uniquely identified stranded leg.
                                    func inconclusive(reason : Text) : UnitResult {
                                        ignore addAudit(lock.action, #Forbidden, null, null, null, "swap reconciliation inconclusive: " # reason);
                                        #err(#ExternalFailure({ code = "RECONCILE_INCONCLUSIVE"; message = reason; partial = true }));
                                    };
                                    func failed(note : Text) : UnitResult {
                                        mem.policy := P.recordFailure(mem.policy);
                                        mem.settlementInFlight := false;
                                        mem.settlementLock := null;
                                        ignore addAudit(lock.action, #Escalation, null, ?external("SWAP_RECOVERED_FAILURE", note, false), lock.ticketId, note);
                                        #ok(());
                                    };
                                    func committed(amountOut : Nat, note : Text) : UnitResult {
                                        switch (intent.approvalBlockIndex) {
                                            case null inconclusive("swap output was found but the approval block index is missing");
                                            case (?approvalBlockIndex) {
                                                let receipt : Receipt = #swap({
                                                    dex = p.dex;
                                                    pool = switch (intent.pool) { case (?value) value; case null return inconclusive("swap output was found but the discovered pool is missing") };
                                                    transactionId = null;
                                                    approvalBlockIndex;
                                                    amountOut;
                                                    fee = intent.fromFee * 3;
                                                });
                                                mem.spend := Array.concat(mem.spend, [{ timestamp = Time.now(); token = p.fromToken; amount = p.amount; fee = intent.fromFee * 3 }]);
                                                mem.policy := P.recordSuccess(mem.policy);
                                                approveRecoveredTicket(lock.ticketId, receipt);
                                                mem.settlementInFlight := false;
                                                mem.settlementLock := null;
                                                ignore addAudit(lock.action, #Escalation, null, ?#success(receipt), lock.ticketId, note);
                                                #ok(());
                                            };
                                        };
                                    };
                                    func sweepBack(token : Principal, gross : Nat, fee : Nat, recoveredAmountOut : Nat) : async* UnitResult {
                                        if (gross <= fee) return inconclusive("stranded swap balance is not large enough to pay the recovery transfer fee");
                                        let sweepAmount = gross - fee;
                                        let sweep = setIntent(lock.action, #sweep, sweepAmount, fee, intent.pool, intent.fromToken, intent.toToken, intent.fromFee, intent.toFee, intent.zeroForOne, recoveredAmountOut, intent.approvalBlockIndex, intent.expiresAt);
                                        switch (await* rawTransferLeg(token, null, vaultAccount(), sweepAmount, fee, sweep.createdAtTime, sweep.memo)) {
                                            case (#ok(#Ok(_))) #ok(());
                                            case (#ok(#Err(#Duplicate(_)))) #ok(());
                                            case (#ok(#Err(error))) inconclusive("recovery sweep failed: " # Icrc.transferErrorText(error));
                                            case (#err(message)) inconclusive("recovery sweep outcome is unknown: " # message);
                                        };
                                    };
                                    // If approval committed but the pool leg was never
                                    // submitted (or its call failed before consuming the
                                    // input), revoke the exact allowance before returning
                                    // transit funds. The revoke has its own durable key;
                                    // recovery can therefore be repeated without either
                                    // leaving a live spender allowance or paying the same
                                    // revoke twice. `expected_allowance` prevents us from
                                    // overwriting an allowance that changed unexpectedly.
                                    func revokeApprovalAndReturn(
                                        fromToken : Principal,
                                        pool : Principal,
                                        expectedAllowance : Nat,
                                        // Exact balance expected AFTER the zero-amount
                                        // revoke approval has charged its own ledger fee.
                                        expectedDefaultBalance : Nat,
                                        approvalBlockIndex : ?Nat,
                                    ) : async* UnitResult {
                                        // During #approvalRevoke, `amount` stores the
                                        // allowance value that must still be present before
                                        // it may be replaced with zero. The submitted approve
                                        // amount itself is always zero.
                                        let revoke = setIntent(lock.action, #approvalRevoke, expectedAllowance, intent.fromFee, ?pool, intent.fromToken, intent.toToken, intent.fromFee, intent.toFee, intent.zeroForOne, 0, approvalBlockIndex, intent.expiresAt);
                                        switch (Icrc.decodeApprove(await* calls.call(Icrc.approveRequest(fromToken, null, { owner = pool; subaccount = null }, 0, intent.fromFee, ?expectedAllowance, null, ?revoke.createdAtTime, ?revoke.memo)))) {
                                            case (#ok(#Ok(_))) {};
                                            case (#ok(#Err(#Duplicate(_)))) {};
                                            case (#ok(#Err(#TooOld))) return inconclusive("approval revoke intent is outside the ledger dedup window");
                                            case (#ok(#Err(#CreatedInFuture(_)))) return inconclusive("approval revoke intent is ahead of ledger time");
                                            case (#ok(#Err(#TemporarilyUnavailable))) return inconclusive("approval revoke outcome is unknown; retry reconciliation");
                                            case (#ok(#Err(error))) return inconclusive("approval revoke rejected: " # Icrc.approveErrorText(error));
                                            case (#err(message)) return inconclusive("approval revoke call failed: " # message);
                                        };
                                        let balance = switch (Icrc.decodeBalance(await* calls.call(Icrc.balanceRequest(fromToken, defaultAccount())))) {
                                            case (#ok(value)) value;
                                            case (#err(message)) return inconclusive("approval revoked but the transit balance could not be inspected: " # message);
                                        };
                                        if (balance != expectedDefaultBalance) return inconclusive("approval revoked but the default input balance does not exactly match this swap's transit funds");
                                        switch (await* sweepBack(fromToken, balance, intent.fromFee, 0)) {
                                            case (#ok(())) failed("swap approval was revoked and the transit input was returned to the vault");
                                            case (#err(error)) #err(error);
                                        };
                                    };
                                    switch (intent.stage) {
                                        case (#swapTransit) {
                                            let transitToken = switch (intent.fromToken) { case (?value) value; case null return inconclusive("swap transit intent has no input token") };
                                            let result = await* rawTransferLeg(transitToken, ?mem.vaultSubaccount, defaultAccount(), intent.amount, intent.fee, intent.createdAtTime, intent.memo);
                                            switch (result) {
                                                case (#ok(#Ok(_))) {
                                                    ignore setIntent(lock.action, #approval, p.amount + intent.fromFee, intent.fromFee, intent.pool, intent.fromToken, intent.toToken, intent.fromFee, intent.toFee, intent.zeroForOne, 0, null, intent.expiresAt);
                                                    inconclusive("input transit reconciled; approval is intentionally not submitted automatically");
                                                };
                                                case (#ok(#Err(#Duplicate(_)))) {
                                                    ignore setIntent(lock.action, #approval, p.amount + intent.fromFee, intent.fromFee, intent.pool, intent.fromToken, intent.toToken, intent.fromFee, intent.toFee, intent.zeroForOne, 0, null, intent.expiresAt);
                                                    inconclusive("input transit was already committed; approval is intentionally not submitted automatically");
                                                };
                                                case (#ok(#Err(#TooOld))) inconclusive("input transit intent is outside the ledger dedup window");
                                                case (#ok(#Err(#CreatedInFuture(_)))) inconclusive("input transit intent is ahead of ledger time");
                                                case (#ok(#Err(#TemporarilyUnavailable))) inconclusive("input transit ledger is temporarily unavailable");
                                                case (#ok(#Err(error))) failed("input transit did not commit: " # Icrc.transferErrorText(error));
                                                case (#err(message)) inconclusive("input transit reconciliation failed: " # message);
                                            };
                                        };
                                        case (#approval) {
                                            let fromToken = switch (intent.fromToken) { case (?value) value; case null return inconclusive("approval intent has no input token") };
                                            let pool = switch (intent.pool) { case (?value) value; case null return inconclusive("approval intent has no pool") };
                                            switch (Icrc.decodeApprove(await* calls.call(Icrc.approveRequest(fromToken, null, { owner = pool; subaccount = null }, intent.amount, intent.fee, null, null, ?intent.createdAtTime, ?intent.memo)))) {
                                                case (#ok(#Ok(blockIndex))) {
                                                    // Transit deposited amount+2 fees. The
                                                    // original approval spent one and this
                                                    // revoke spends the other, leaving amount.
                                                    await* revokeApprovalAndReturn(fromToken, pool, p.amount + intent.fromFee, p.amount, ?blockIndex);
                                                };
                                                case (#ok(#Err(#Duplicate({ duplicate_of })))) {
                                                    await* revokeApprovalAndReturn(fromToken, pool, p.amount + intent.fromFee, p.amount, ?duplicate_of);
                                                };
                                                case (#ok(#Err(#TooOld))) inconclusive("approval intent is outside the ledger dedup window");
                                                case (#ok(#Err(#CreatedInFuture(_)))) inconclusive("approval intent is ahead of ledger time");
                                                case (#ok(#Err(#TemporarilyUnavailable))) inconclusive("approval ledger is temporarily unavailable");
                                                case (#ok(#Err(error))) {
                                                    let balance = switch (Icrc.decodeBalance(await* calls.call(Icrc.balanceRequest(fromToken, defaultAccount())))) {
                                                        case (#ok(value)) value;
                                                        case (#err(message)) return inconclusive("approval failed and the transit balance could not be inspected: " # message);
                                                    };
                                                    let expectedBalance = intent.amount + intent.fee;
                                                    if (balance != expectedBalance) return inconclusive("approval rejected but the default input balance does not exactly match this swap's transit funds");
                                                    if (balance <= intent.fromFee) return inconclusive("approval rejected but the transit balance cannot cover its return fee");
                                                    let unwind = setIntent(lock.action, #sweep, balance - intent.fromFee, intent.fromFee, ?pool, intent.fromToken, intent.toToken, intent.fromFee, intent.toFee, intent.zeroForOne, 0, null, intent.expiresAt);
                                                    switch (await* rawTransferLeg(fromToken, null, vaultAccount(), unwind.amount, intent.fromFee, unwind.createdAtTime, unwind.memo)) {
                                                        case (#ok(#Ok(_))) failed("approval rejected; the transit input was returned to the vault (" # Icrc.approveErrorText(error) # ")");
                                                        case (#ok(#Err(#Duplicate(_)))) failed("approval rejected; the transit input was already returned to the vault (" # Icrc.approveErrorText(error) # ")");
                                                        case (#ok(#Err(transferError))) inconclusive("approval rejected and transit unwind failed: " # Icrc.transferErrorText(transferError));
                                                        case (#err(message)) inconclusive("approval rejected and transit unwind outcome is unknown: " # message);
                                                    };
                                                };
                                                case (#err(message)) inconclusive("approval reconciliation failed: " # message);
                                            };
                                        };
                                        case (#approvalRevoke) {
                                            let fromToken = switch (intent.fromToken) { case (?value) value; case null return inconclusive("approval revoke intent has no input token") };
                                            let pool = switch (intent.pool) { case (?value) value; case null return inconclusive("approval revoke intent has no pool") };
                                            if (intent.amount <= intent.fromFee) return inconclusive("approval revoke intent cannot identify the post-revoke transit balance");
                                            switch (Icrc.decodeApprove(await* calls.call(Icrc.approveRequest(fromToken, null, { owner = pool; subaccount = null }, 0, intent.fee, ?intent.amount, null, ?intent.createdAtTime, ?intent.memo)))) {
                                                case (#ok(#Ok(_))) {};
                                                case (#ok(#Err(#Duplicate(_)))) {};
                                                case (#ok(#Err(#TooOld))) return inconclusive("approval revoke intent is outside the ledger dedup window");
                                                case (#ok(#Err(#CreatedInFuture(_)))) return inconclusive("approval revoke intent is ahead of ledger time");
                                                case (#ok(#Err(#TemporarilyUnavailable))) return inconclusive("approval revoke ledger is temporarily unavailable");
                                                case (#ok(#Err(error))) return inconclusive("approval revoke rejected: " # Icrc.approveErrorText(error));
                                                case (#err(message)) return inconclusive("approval revoke reconciliation failed: " # message);
                                            };
                                            let expectedBalance = intent.amount - intent.fromFee;
                                            let balance = switch (Icrc.decodeBalance(await* calls.call(Icrc.balanceRequest(fromToken, defaultAccount())))) {
                                                case (#ok(value)) value;
                                                case (#err(message)) return inconclusive("approval revoke reconciled but the transit balance could not be inspected: " # message);
                                            };
                                            if (balance != expectedBalance) return inconclusive("approval revoke reconciled but the default input balance does not exactly match this swap's transit funds");
                                            switch (await* sweepBack(fromToken, balance, intent.fromFee, 0)) {
                                                case (#ok(())) failed("swap approval revoke reconciled and the transit input was returned to the vault");
                                                case (#err(error)) #err(error);
                                            };
                                        };
                                        case (#poolSwap) {
                                            let pool = switch (intent.pool) { case (?value) value; case null return inconclusive("pool swap intent has no pool") };
                                            let unused = switch (Icrc.decodeUnusedBalance(await* calls.call(Icrc.getUserUnusedBalanceRequest(pool, calls.canister_principal)))) {
                                                case (#ok(#ok(value))) value;
                                                case (#ok(#err(value))) return inconclusive("pool rejected unused-balance inspection: " # Icrc.dexErrorText(value));
                                                case (#err(message)) return inconclusive("pool unused-balance inspection failed: " # message);
                                            };
                                            let inputBalance = if (intent.zeroForOne) unused.balance0 else unused.balance1;
                                            let outputBalance = if (intent.zeroForOne) unused.balance1 else unused.balance0;
                                            if (inputBalance > 0 and outputBalance > 0) return inconclusive("pool has both stranded input and output; outcome is ambiguous");
                                            if (inputBalance > 0) {
                                                let token = switch (intent.fromToken) { case (?value) value; case null return inconclusive("stranded input has no token") };
                                                let withdraw = setIntent(lock.action, #withdraw, inputBalance, intent.fromFee, ?pool, intent.fromToken, intent.toToken, intent.fromFee, intent.toFee, intent.zeroForOne, 0, intent.approvalBlockIndex, intent.expiresAt);
                                                switch (Icrc.decodeDexNat(await* calls.call(Icrc.withdrawRequest(pool, { amount = inputBalance; fee = intent.fromFee; token = Principal.toText(token) })), "input unwind")) {
                                                    case (#ok(#ok(_))) {
                                                        let balance = switch (Icrc.decodeBalance(await* calls.call(Icrc.balanceRequest(token, defaultAccount())))) { case (#ok(value)) value; case (#err(message)) return inconclusive("input unwind balance read failed: " # message) };
                                                        if (inputBalance <= intent.fromFee or balance != inputBalance - intent.fromFee) return inconclusive("input unwind credited an unexpected default-account balance");
                                                        switch (await* sweepBack(token, balance, intent.fromFee, 0)) { case (#ok(())) failed("swap failed; stranded input was withdrawn and returned to the vault"); case (#err(error)) #err(error) };
                                                    };
                                                    case (#ok(#err(value))) {
                                                        replaceIntent(lock.action, { withdraw with stage = #poolSwap });
                                                        inconclusive("pool rejected stranded-input withdrawal: " # Icrc.dexErrorText(value));
                                                    };
                                                    case (#err(message)) inconclusive("stranded-input withdrawal outcome is unknown: " # message);
                                                };
                                            } else if (outputBalance > 0) {
                                                let token = switch (intent.toToken) { case (?value) value; case null return inconclusive("stranded output has no token") };
                                                if (outputBalance <= intent.toFee * 2) return inconclusive("stranded output cannot cover both the pool withdrawal fee and the vault sweep fee");
                                                let withdraw = setIntent(lock.action, #withdraw, outputBalance, intent.toFee, ?pool, intent.fromToken, intent.toToken, intent.fromFee, intent.toFee, intent.zeroForOne, outputBalance - (intent.toFee * 2), intent.approvalBlockIndex, intent.expiresAt);
                                                switch (Icrc.decodeDexNat(await* calls.call(Icrc.withdrawRequest(pool, { amount = outputBalance; fee = intent.toFee; token = Principal.toText(token) })), "output unwind")) {
                                                    case (#ok(#ok(_))) {
                                                        let balance = switch (Icrc.decodeBalance(await* calls.call(Icrc.balanceRequest(token, defaultAccount())))) { case (#ok(value)) value; case (#err(message)) return inconclusive("output unwind balance read failed: " # message) };
                                                        if (outputBalance <= intent.toFee or balance != outputBalance - intent.toFee) return inconclusive("output unwind credited an unexpected default-account balance");
                                                        let sweepResult = await* sweepBack(token, balance, intent.toFee, outputBalance - (intent.toFee * 2));
                                                        switch (sweepResult) { case (#ok(())) committed(outputBalance - (intent.toFee * 2), "swap output recovered and swept to the vault"); case (#err(error)) #err(error) };
                                                    };
                                                    case (#ok(#err(value))) {
                                                        replaceIntent(lock.action, { withdraw with stage = #poolSwap });
                                                        inconclusive("pool rejected stranded-output withdrawal: " # Icrc.dexErrorText(value));
                                                    };
                                                    case (#err(message)) inconclusive("stranded-output withdrawal outcome is unknown: " # message);
                                                };
                                            } else {
                                                // No pool balance means the pool leg may never
                                                // have consumed the approved input. Inspect the
                                                // default transit account before deciding that
                                                // the outcome is unknown; an exact match proves
                                                // the input is still ours and permits a safe
                                                // allowance revoke + unwind.
                                                let fromToken = switch (intent.fromToken) { case (?value) value; case null return inconclusive("pool swap intent has no input token") };
                                                let defaultInput = switch (Icrc.decodeBalance(await* calls.call(Icrc.balanceRequest(fromToken, defaultAccount())))) {
                                                    case (#ok(value)) value;
                                                    case (#err(message)) return inconclusive("pool swap had no unused balance and the default input balance could not be inspected: " # message);
                                                };
                                                let expectedApprovedBalance = p.amount + intent.fromFee;
                                                if (defaultInput == expectedApprovedBalance) {
                                                    // `defaultInput` is pre-revoke (amount+fee);
                                                    // the helper verifies post-revoke `amount`.
                                                    await* revokeApprovalAndReturn(fromToken, pool, p.amount + intent.fromFee, p.amount, intent.approvalBlockIndex);
                                                } else {
                                                    inconclusive("pool has no observable unused balance and the default input balance does not identify an unconsumed transit");
                                                };
                                            };
                                        };
                                        case (#withdraw) {
                                            let token = switch (intent.toToken) { case (?value) value; case null return inconclusive("withdraw intent has no output token") };
                                            let pool = switch (intent.pool) { case (?value) value; case null return inconclusive("withdraw intent has no pool") };
                                            let defaultBalance = switch (Icrc.decodeBalance(await* calls.call(Icrc.balanceRequest(token, defaultAccount())))) {
                                                case (#ok(value)) value;
                                                case (#err(message)) return inconclusive("withdraw recovery balance read failed: " # message);
                                            };
                                            if (defaultBalance > 0) {
                                                if (intent.amount <= intent.toFee * 2) return inconclusive("withdraw recovery found an output too small to pay both the withdrawal and vault sweep fees");
                                                let expectedBalance = intent.amount - intent.toFee;
                                                if (defaultBalance != expectedBalance) return inconclusive("withdraw recovery default balance does not exactly match this swap's net output");
                                                let sweepAmount = expectedBalance - intent.toFee;
                                                let sweep = setIntent(lock.action, #sweep, sweepAmount, intent.toFee, ?pool, intent.fromToken, intent.toToken, intent.fromFee, intent.toFee, intent.zeroForOne, sweepAmount, intent.approvalBlockIndex, intent.expiresAt);
                                                switch (await* rawTransferLeg(token, null, vaultAccount(), sweep.amount, intent.toFee, sweep.createdAtTime, sweep.memo)) {
                                                case (#ok(#Ok(_))) committed(sweep.amount, "withdraw committed and its output was swept to the vault");
                                                case (#ok(#Err(#Duplicate(_)))) committed(sweep.amount, "withdraw output was already swept to the vault");
                                                    case (#ok(#Err(error))) inconclusive("withdraw recovery sweep failed: " # Icrc.transferErrorText(error));
                                                    case (#err(message)) inconclusive("withdraw recovery sweep outcome is unknown: " # message);
                                                };
                                            } else inconclusive("withdraw outcome is unknown: no default output is observable yet");
                                        };
                                        case (#sweep) {
                                            let token = if (intent.amountOut > 0) {
                                                switch (intent.toToken) { case (?value) value; case null return inconclusive("output sweep has no token") };
                                            } else {
                                                switch (intent.fromToken) { case (?value) value; case null return inconclusive("input sweep has no token") };
                                            };
                                            switch (await* rawTransferLeg(token, null, vaultAccount(), intent.amount, intent.fee, intent.createdAtTime, intent.memo)) {
                                                case (#ok(#Ok(_))) { if (intent.amountOut > 0) committed(intent.amountOut, "swap output sweep reconciled") else failed("swap input sweep reconciled") };
                                                case (#ok(#Err(#Duplicate(_)))) { if (intent.amountOut > 0) committed(intent.amountOut, "swap output sweep was already committed") else failed("swap input sweep was already committed") };
                                                case (#ok(#Err(#TooOld))) inconclusive("sweep intent is outside the ledger dedup window");
                                                case (#ok(#Err(#CreatedInFuture(_)))) inconclusive("sweep intent is ahead of ledger time");
                                                case (#ok(#Err(error))) inconclusive("sweep failed: " # Icrc.transferErrorText(error));
                                                case (#err(message)) inconclusive("sweep outcome is unknown: " # message);
                                            };
                                        };
                                        case (#transfer) inconclusive("swap settlement lock carries a transfer-stage intent");
                                    };
                                };
                            };
                        };
                    };
                };
            };
        };

        public func /*update*/setPolicy(next : Policy) : UnitResult {
            if (not P.validPolicy(next)) return #err(#InvalidPolicy);
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
