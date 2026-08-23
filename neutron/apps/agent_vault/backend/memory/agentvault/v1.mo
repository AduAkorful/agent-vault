// Agent Vault — persistent state schema (managed memory store `agentvault`, v1).
//
// IMMUTABILITY: once a packaged release pins this file's hash in
// neutron.lock.json, it must never change — evolve the schema by adding v2.mo
// plus a `migrations` entry, never by editing v1. Until that first release the
// schema is still free to change (the lock is a local, regenerable artifact).
//
// IMPORTS: package imports only. Relative imports are forbidden here so the
// persisted layout cannot silently drift with app-local modules. Every type
// reachable from `Mem` therefore lives inline in this file; return-only
// projections (Outcome / VaultState / Result) live in ../../vault/Types.mo so
// their evolution never perturbs this schema hash.

import Principal "mo:core/Principal";

module {
    public type Token = {
        id : Principal;
        symbol : Text;
        decimals : Nat8;
        standard : Text;
        fee : Nat;
    };

    public type Balance = { token : Token; amount : Nat; syncedAt : Int };

    public type TokenPair = { from : Principal; to : Principal };

    public type Limits = {
        maxPerTx : Nat;
        maxHourlySpend : Nat;
        maxDailySpend : Nat;
    };

    public type Allowlists = {
        recipients : [Principal];
        dexes : [Principal];
        pairs : [TokenPair];
    };

    public type Policy = {
        limits : Limits;
        allowlists : Allowlists;
        circuitBreaker : Bool;
        failureThreshold : Nat;
        consecutiveFailures : Nat;
    };

    public type TransferProposal = {
        token : Principal;
        recipient : Principal;
        amount : Nat;
        reason : Text;
    };

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
        #swap : {
            dex : Principal;
            pool : Principal;
            transactionId : ?Nat;
            approvalBlockIndex : Nat;
            amountOut : Nat;
        };
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

    public type Ticket = {
        id : Nat;
        action : Action;
        createdAt : Int;
        policyError : ?VaultError;
        status : { #pending; #approved : Receipt; #rejected : Text };
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

    public type Spend = { timestamp : Int; amount : Nat };

    public type SettlementLock = { action : Action; startedAt : Int };

    public type DexConfig = { factory : Principal; feeTier : Nat };

    public type Mem = {
        var policy : Policy;
        var spend : [Spend];
        var nextId : Nat;
        var liveBalances : [Balance];
        var settlementTickets : [Ticket];
        var activity : [AuditEntry];
        var settlementInFlight : Bool;
        var settlementLock : ?SettlementLock;
        var dexConfig : DexConfig;
    };

    public func init() : Mem {
        {
            var policy = {
                limits = {
                    maxPerTx = 100;
                    maxHourlySpend = 500;
                    maxDailySpend = 1000;
                };
                allowlists = { recipients = []; dexes = []; pairs = [] };
                circuitBreaker = false;
                failureThreshold = 3;
                consecutiveFailures = 0;
            };
            var spend = [];
            var nextId = 0;
            var liveBalances = [];
            var settlementTickets = [];
            var activity = [];
            var settlementInFlight = false;
            var settlementLock = null;
            var dexConfig = {
                factory = Principal.fromText("4mmnk-kiaaa-aaaag-qbllq-cai");
                feeTier = 3000;
            };
        };
    };
};
