// ICRC-1 candid types — transfers-only subset ported from the M3 reference actor.
// These mirror the ledger's public interface exactly so `to_candid`/`from_candid`
// round-trip against a real ICRC-1 ledger. Swap/approval (ICRC-2) types are
// omitted: swap settlement is deferred in v1 (ADR-004, no fabricated receipts).
module {
    public type Account = {
        owner : Principal;
        subaccount : ?Blob;
    };

    // icrc1_supported_standards : () -> (vec record { name : text; url : text })
    public type SupportedStandard = {
        name : Text;
        url : Text;
    };

    public type TransferArg = {
        from_subaccount : ?Blob;
        to : Account;
        amount : Nat;
        fee : ?Nat;
        memo : ?Blob;
        created_at_time : ?Nat64;
    };

    public type TransferError = {
        #BadFee : { expected_fee : Nat };
        #BadBurn : { min_burn_amount : Nat };
        #InsufficientFunds : { balance : Nat };
        #TooOld;
        #CreatedInFuture : { ledger_time : Nat64 };
        #TemporarilyUnavailable;
        #Duplicate : { duplicate_of : Nat };
        #GenericError : { error_code : Nat; message : Text };
    };

    public type TransferResult = {
        #Ok : Nat;
        #Err : TransferError;
    };

    public type Result<T> = {
        #ok : T;
        #err : Text;
    };
};
