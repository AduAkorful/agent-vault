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
// projections (Outcome / VaultState / Result) are declared inline in main.mo so
// their evolution never perturbs this schema hash.

import Principal "mo:core/Principal";
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Text "mo:core/Text";

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

    // Per-token velocity limits, all expressed in that token's own base units
    // (never mixed across decimals). A token with no entry in `Policy.limits`
    // can never settle autonomously — it escalates to owner approval. This is
    // the safe-by-default rule: an unconfigured token is untrusted.
    public type TokenLimits = {
        maxPerTx : Nat;
        maxHourlySpend : Nat;
        maxDailySpend : Nat;
    };

    public type TokenLimit = { token : Principal; limits : TokenLimits };

    public type Allowlists = {
        recipients : [Principal];
        dexes : [Principal];
        pairs : [TokenPair];
    };

    public type Policy = {
        limits : [TokenLimit];
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
        #transfer : { token : Principal; blockIndex : Nat; fee : Nat };
        #swap : {
            dex : Principal;
            pool : Principal;
            transactionId : ?Nat;
            approvalBlockIndex : Nat;
            amountOut : Nat;
            fee : Nat;
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
        #TokenLimitNotConfigured;
        #InvalidPolicy;
        // A swap was proposed: swaps always park for owner approval and never
        // settle autonomously (see Policy.classify / main.mo settleSwap).
        #SwapRequiresApproval;
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

    // A recorded outflow, fee-inclusive: the ledger debits `amount + fee` from
    // the vault, so spend windows must sum both. Tagged by token so per-token
    // limits never mix base units across decimals.
    public type Spend = { timestamp : Int; token : Principal; amount : Nat; fee : Nat };

    // The durable record of an in-flight settlement, persisted BEFORE the ledger
    // await so an unknown outcome (a lost or trapped response) stays recoverable.
    // `intent` is present only once the debit has actually been submitted to the
    // ledger; while it is null the settlement is still in its pre-submit window
    // (fee/balance queries) and no ledger write has happened yet. On recovery the
    // stored intent is re-submitted with the SAME createdAtTime + memo, so the
    // ledger deduplicates it — #Duplicate means the original debit already
    // committed (never paid twice), #Ok means it never did (commit now). `fee` is
    // the exact fee the original attempt used, captured so the re-submit hashes
    // identically at the ledger. Swap intents also persist their staged leg and
    // discovered pool so recovery can reconcile ICRC legs and inspect stranded
    // pool balances without ever re-running an unknown-outcome swap call.
    public type SettlementStage = {
        #transfer;
        #swapTransit;
        #approval;
        #approvalRevoke;
        #poolSwap;
        #withdraw;
        #sweep;
    };
    public type SettlementIntent = {
        stage : SettlementStage;
        createdAtTime : Nat64;
        memo : Blob;
        fee : Nat;
        amount : Nat;
        pool : ?Principal;
        fromToken : ?Principal;
        toToken : ?Principal;
        fromFee : Nat;
        toFee : Nat;
        zeroForOne : Bool;
        amountOut : Nat;
        approvalBlockIndex : ?Nat;
        expiresAt : ?Int;
    };
    public type SettlementLock = { action : Action; startedAt : Int; ticketId : ?Nat; intent : ?SettlementIntent };

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
        // The vault's isolated ICRC-1 subaccount within the shared canister. Every
        // balance read and transfer debit operates on { owner = canister principal;
        // subaccount = vaultSubaccount } — never the canister default (all-zero)
        // account — so the vault's holdings are custody-isolated from the canister
        // and from other apps in the same canister (R6). Deterministic, non-zero,
        // 32 bytes; see deriveVaultSubaccount.
        var vaultSubaccount : Blob;
    };

    // Deterministic 32-byte vault subaccount: the app-namespaced label's UTF-8,
    // right-padded with zero bytes to the ICRC-1 32-byte width. Distinct from the
    // canister default account (all-zero subaccount) and from any other app's
    // label, so the vault's funds are isolated within the shared canister. Fixed
    // for v1; rotating it (a schema change) would relocate the deposit account.
    public func deriveVaultSubaccount() : Blob {
        let bytes = Blob.toArray(Text.encodeUtf8("neutron:agent_vault:vault:v1"));
        Blob.fromArray(Array.tabulate<Nat8>(32, func(i) { if (i < bytes.size()) bytes[i] else 0 }));
    };

    public func init() : Mem {
        {
            var policy = {
                // Safe by default: no per-token limits and an empty recipient
                // allowlist mean nothing settles autonomously until the owner
                // configures a token limit AND allowlists a recipient. No seeded
                // balances, tickets, or activity exist on a clean install.
                limits = ([] : [TokenLimit]);
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
            var vaultSubaccount = deriveVaultSubaccount();
        };
    };
};
