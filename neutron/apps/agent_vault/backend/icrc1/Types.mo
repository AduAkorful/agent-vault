// ICRC-1/ICRC-2 candid types + ICPSwap Factory/SwapPool types. These mirror the
// ledger and DEX public interfaces exactly so `to_candid`/`from_candid` round-trip
// against the real canisters. The ICRC-2 approval and ICPSwap shapes drive real
// swap settlement (WS-G); every DEX reply is decoded, and a decode miss becomes an
// honest ExternalError rather than a fabricated receipt (ADR-004). All ICPSwap
// shapes below were verified against the live SwapFactory/SwapPool candid on IC
// mainnet before use (never hallucinated).
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

    // ----- ICRC-2 approval (swap input leg) -----
    // The vault approves an ICPSwap pool as spender so the pool can pull the swap
    // input via icrc2_transfer_from. `from_subaccount` selects which of the
    // vault's accounts the allowance draws from; ICPSwap pools pull from the
    // caller's DEFAULT account, so the approve leg targets subaccount = null.
    public type ApproveArgs = {
        from_subaccount : ?Blob;
        spender : Account;
        amount : Nat;
        expected_allowance : ?Nat;
        expires_at : ?Nat64;
        fee : ?Nat;
        memo : ?Blob;
        created_at_time : ?Nat64;
    };

    public type ApproveError = {
        #BadFee : { expected_fee : Nat };
        #InsufficientFunds : { balance : Nat };
        #AllowanceChanged : { current_allowance : Nat };
        #Expired : { ledger_time : Nat64 };
        #TooOld;
        #CreatedInFuture : { ledger_time : Nat64 };
        #Duplicate : { duplicate_of : Nat };
        #TemporarilyUnavailable;
        #GenericError : { error_code : Nat; message : Text };
    };

    public type ApproveResult = {
        #Ok : Nat;
        #Err : ApproveError;
    };

    // ----- ICPSwap Factory + SwapPool (candid verified on IC mainnet) -----
    // A token as ICPSwap names it: the ledger principal as text plus a standard
    // tag ("ICRC1"/"ICRC2"). ICPSwap reports the ICP ledger itself as "ICRC2".
    public type DexToken = { address : Text; standard : Text };

    // ICPSwap's shared protocol error. Decoders map a candid-shape mismatch (a
    // variant tag outside this set) to an honest #err, never a fabricated ok.
    public type DexError = {
        #CommonError;
        #InternalError : Text;
        #UnsupportedToken : Text;
        #InsufficientFunds;
    };

    // SwapFactory.getPool : (GetPoolArgs) -> (variant { ok : PoolData; err }) query
    // Pools are discovered per pair at runtime (never hardcoded); token0/token1
    // order is decided by the factory and drives the swap's `zeroForOne`.
    public type GetPoolArgs = { fee : Nat; token0 : DexToken; token1 : DexToken };
    public type PoolData = {
        canisterId : Principal;
        fee : Nat;
        key : Text;
        tickSpacing : Int;
        token0 : DexToken;
        token1 : DexToken;
    };
    public type PoolResult = { #ok : PoolData; #err : DexError };

    // Every SwapPool method that returns a scalar uses variant { ok : nat; err }.
    // For quote/swap the ok is the output amount; for withdraw it is the amount
    // credited back; for deposit it is the amount recorded to the unused balance.
    public type DexNatResult = { #ok : Nat; #err : DexError };

    // SwapPool.quote / SwapPool.swap. Amounts are decimal strings in the token's
    // own base units (ICPSwap models them as text to carry arbitrary precision).
    public type SwapArgs = { amountIn : Text; amountOutMinimum : Text; zeroForOne : Bool };

    // SwapPool.depositFromAndSwap: pulls the input via the ICRC-2 allowance the
    // vault granted, swaps it, and credits the output to the vault's unused pool
    // balance (a separate withdraw returns it to the vault). tokenInFee/tokenOutFee
    // are the two ledgers' fees, read live — never assumed.
    public type DepositAndSwapArgs = {
        amountIn : Text;
        amountOutMinimum : Text;
        tokenInFee : Nat;
        tokenOutFee : Nat;
        zeroForOne : Bool;
    };

    // SwapPool.deposit/depositFrom and SwapPool.withdraw. `token` is the ledger
    // principal as text; `fee` is that ledger's fee.
    public type DepositArgs = { amount : Nat; fee : Nat; token : Text };
    public type WithdrawArgs = { amount : Nat; fee : Nat; token : Text };

    // SwapPool.getUserUnusedBalance : (principal) -> (variant { ok : record; err })
    // keyed by the bare principal's DEFAULT account. Drives swap reconciliation:
    // after an interrupted swap, stranded input/output sits here to be withdrawn.
    public type UnusedBalance = { balance0 : Nat; balance1 : Nat };
    public type UnusedBalanceResult = { #ok : UnusedBalance; #err : DexError };
};
