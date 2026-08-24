// ICRC-1 client — builds `backend_calls` requests and decodes replies for the
// individual ledger methods the vault settles over. Symbol, decimals, fee, and
// standards are queried independently instead of inferred from metadata.
import Capabilities "../capabilities/Types";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Types "Types";

module {
    // ----- request builders (one ICRC-1 method each) -----
    public func supportedStandardsRequest(ledger : Principal) : Capabilities.CallRequest {
        { canister = ledger; method = "icrc1_supported_standards"; args = to_candid (); cycles = 0 };
    };

    public func symbolRequest(ledger : Principal) : Capabilities.CallRequest {
        { canister = ledger; method = "icrc1_symbol"; args = to_candid (); cycles = 0 };
    };

    public func decimalsRequest(ledger : Principal) : Capabilities.CallRequest {
        { canister = ledger; method = "icrc1_decimals"; args = to_candid (); cycles = 0 };
    };

    public func feeRequest(ledger : Principal) : Capabilities.CallRequest {
        { canister = ledger; method = "icrc1_fee"; args = to_candid (); cycles = 0 };
    };

    public func balanceRequest(ledger : Principal, account : Types.Account) : Capabilities.CallRequest {
        { canister = ledger; method = "icrc1_balance_of"; args = to_candid (account); cycles = 0 };
    };

    // from_subaccount isolates the debit to the vault's own subaccount within the
    // shared canister (custody isolation, R6) — never the canister default account.
    // createdAtTime + memo are the durable idempotency key (R8): the ledger
    // deduplicates any re-submit carrying the same (from, to, amount, fee, memo,
    // created_at_time) within its transaction window (~24h on the ICP ledger), so
    // a reconciling re-submit after an unknown outcome returns #Duplicate instead
    // of debiting twice. The backend mints and persists this key before the await;
    // here it is passed straight through.
    public func transferRequest(
        ledger : Principal,
        fromSubaccount : ?Blob,
        destination : Types.Account,
        amount : Nat,
        fee : Nat,
        createdAtTime : ?Nat64,
        memo : ?Blob,
    ) : Capabilities.CallRequest {
        let args : Types.TransferArg = {
            from_subaccount = fromSubaccount;
            to = destination;
            amount;
            fee = ?fee;
            memo;
            created_at_time = createdAtTime;
        };
        { canister = ledger; method = "icrc1_transfer"; args = to_candid (args); cycles = 0 };
    };

    // ----- ICRC-2 + ICPSwap request builders (real swap settlement, WS-G) -----
    // Approve a pool as spender so it can pull the swap input via
    // icrc2_transfer_from. fromSubaccount selects which vault account the
    // allowance draws from; ICPSwap pools pull from the caller's default account,
    // so the swap path passes fromSubaccount = null. The amount/fee arithmetic is
    // decided by the caller (main.mo) and passed through verbatim.
    public func approveRequest(
        ledger : Principal,
        fromSubaccount : ?Blob,
        spender : Types.Account,
        amount : Nat,
        fee : Nat,
        expectedAllowance : ?Nat,
        expiresAt : ?Nat64,
        createdAtTime : ?Nat64,
        memo : ?Blob,
    ) : Capabilities.CallRequest {
        let args : Types.ApproveArgs = {
            from_subaccount = fromSubaccount;
            spender;
            amount;
            expected_allowance = expectedAllowance;
            expires_at = expiresAt;
            fee = ?fee;
            memo;
            created_at_time = createdAtTime;
        };
        { canister = ledger; method = "icrc2_approve"; args = to_candid (args); cycles = 0 };
    };

    // Discover the pool canister for a pair at the configured fee tier. Pools are
    // never hardcoded — the factory is the source of truth for the pool principal
    // and for token0/token1 ordering (which decides `zeroForOne`).
    public func getPoolRequest(factory : Principal, args : Types.GetPoolArgs) : Capabilities.CallRequest {
        { canister = factory; method = "getPool"; args = to_candid (args); cycles = 0 };
    };

    public func quoteRequest(pool : Principal, args : Types.SwapArgs) : Capabilities.CallRequest {
        { canister = pool; method = "quote"; args = to_candid (args); cycles = 0 };
    };

    public func depositFromAndSwapRequest(pool : Principal, args : Types.DepositAndSwapArgs) : Capabilities.CallRequest {
        { canister = pool; method = "depositFromAndSwap"; args = to_candid (args); cycles = 0 };
    };

    public func withdrawRequest(pool : Principal, args : Types.WithdrawArgs) : Capabilities.CallRequest {
        { canister = pool; method = "withdraw"; args = to_candid (args); cycles = 0 };
    };

    public func getUserUnusedBalanceRequest(pool : Principal, who : Principal) : Capabilities.CallRequest {
        { canister = pool; method = "getUserUnusedBalance"; args = to_candid (who); cycles = 0 };
    };

    // ----- reply decoders (a null from_candid = candid shape mismatch → #err) -----
    public func decodeApprove(result : Capabilities.CallResult) : Types.Result<Types.ApproveResult> {
        switch (result) {
            case (#err(error)) #err(error.code # ": " # error.message);
            case (#ok(reply)) {
                let decoded : ?Types.ApproveResult = from_candid reply;
                switch (decoded) {
                    case (?value) #ok(value);
                    case null #err("Ledger returned an unexpected approval result");
                };
            };
        };
    };

    public func decodePool(result : Capabilities.CallResult) : Types.Result<Types.PoolResult> {
        switch (result) {
            case (#err(error)) #err(error.code # ": " # error.message);
            case (#ok(reply)) {
                let decoded : ?Types.PoolResult = from_candid reply;
                switch (decoded) {
                    case (?value) #ok(value);
                    case null #err("Factory returned an unexpected pool result");
                };
            };
        };
    };

    public func decodeDexNat(result : Capabilities.CallResult, valueLabel : Text) : Types.Result<Types.DexNatResult> {
        switch (result) {
            case (#err(error)) #err(error.code # ": " # error.message);
            case (#ok(reply)) {
                let decoded : ?Types.DexNatResult = from_candid reply;
                switch (decoded) {
                    case (?value) #ok(value);
                    case null #err("SwapPool returned an unexpected " # valueLabel # " result");
                };
            };
        };
    };

    public func decodeUnusedBalance(result : Capabilities.CallResult) : Types.Result<Types.UnusedBalanceResult> {
        switch (result) {
            case (#err(error)) #err(error.code # ": " # error.message);
            case (#ok(reply)) {
                let decoded : ?Types.UnusedBalanceResult = from_candid reply;
                switch (decoded) {
                    case (?value) #ok(value);
                    case null #err("SwapPool returned an unexpected unused balance result");
                };
            };
        };
    };

    public func decodeSupportedStandards(
        result : Capabilities.CallResult,
    ) : Types.Result<[Types.SupportedStandard]> {
        switch (result) {
            case (#err(error)) #err(error.code # ": " # error.message);
            case (#ok(reply)) {
                let decoded : ?[Types.SupportedStandard] = from_candid reply;
                switch (decoded) {
                    case (?standards) #ok(standards);
                    case null #err("Ledger returned unexpected supported standards");
                };
            };
        };
    };

    public func decodeSymbol(result : Capabilities.CallResult) : Types.Result<Text> {
        switch (result) {
            case (#err(error)) #err(error.code # ": " # error.message);
            case (#ok(reply)) {
                let decoded : ?Text = from_candid reply;
                switch (decoded) {
                    case (?symbol) #ok(symbol);
                    case null #err("Ledger returned an unexpected symbol");
                };
            };
        };
    };

    public func decodeDecimals(result : Capabilities.CallResult) : Types.Result<Nat8> {
        switch (result) {
            case (#err(error)) #err(error.code # ": " # error.message);
            case (#ok(reply)) {
                let decoded : ?Nat8 = from_candid reply;
                switch (decoded) {
                    case (?decimals) #ok(decimals);
                    case null #err("Ledger returned unexpected decimals");
                };
            };
        };
    };

    public func decodeFee(result : Capabilities.CallResult) : Types.Result<Nat> {
        decodeNat(result, "fee");
    };

    public func decodeBalance(result : Capabilities.CallResult) : Types.Result<Nat> {
        decodeNat(result, "balance");
    };

    public func decodeTransfer(
        result : Capabilities.CallResult,
    ) : Types.Result<Types.TransferResult> {
        switch (result) {
            case (#err(error)) #err(error.code # ": " # error.message);
            case (#ok(reply)) {
                let decoded : ?Types.TransferResult = from_candid reply;
                switch (decoded) {
                    case (?transfer) #ok(transfer);
                    case null #err("Ledger returned an unexpected transfer result");
                };
            };
        };
    };

    public func transferErrorText(error : Types.TransferError) : Text {
        switch (error) {
            case (#BadFee(value)) "Ledger fee changed to " # Nat.toText(value.expected_fee);
            case (#BadBurn(value)) "Amount is below the minimum burn amount " # Nat.toText(value.min_burn_amount);
            case (#InsufficientFunds(value)) "Insufficient funds; current balance is " # Nat.toText(value.balance);
            case (#TooOld) "Transfer request is too old";
            case (#CreatedInFuture(value)) "Transfer timestamp is ahead of ledger time " # Nat64.toText(value.ledger_time);
            case (#TemporarilyUnavailable) "Ledger is temporarily unavailable";
            case (#Duplicate(value)) "Transfer was already recorded in block " # Nat.toText(value.duplicate_of);
            case (#GenericError(value)) "Ledger error " # Nat.toText(value.error_code) # ": " # value.message;
        };
    };

    public func approveErrorText(error : Types.ApproveError) : Text {
        switch (error) {
            case (#BadFee(value)) "Ledger fee changed to " # Nat.toText(value.expected_fee);
            case (#InsufficientFunds(value)) "Insufficient funds; current balance is " # Nat.toText(value.balance);
            case (#AllowanceChanged(value)) "Allowance changed; current allowance is " # Nat.toText(value.current_allowance);
            case (#Expired(value)) "Approval expired at ledger time " # Nat64.toText(value.ledger_time);
            case (#TooOld) "Approval request is too old";
            case (#CreatedInFuture(value)) "Approval timestamp is ahead of ledger time " # Nat64.toText(value.ledger_time);
            case (#Duplicate(value)) "Approval was already recorded in block " # Nat.toText(value.duplicate_of);
            case (#TemporarilyUnavailable) "Ledger is temporarily unavailable";
            case (#GenericError(value)) "Ledger error " # Nat.toText(value.error_code) # ": " # value.message;
        };
    };

    public func dexErrorText(error : Types.DexError) : Text {
        switch (error) {
            case (#CommonError) "ICPSwap common error";
            case (#InternalError(message)) "ICPSwap internal error: " # message;
            case (#UnsupportedToken(message)) "ICPSwap does not support this token: " # message;
            case (#InsufficientFunds) "ICPSwap reported insufficient funds";
        };
    };

    func decodeNat(result : Capabilities.CallResult, valueLabel : Text) : Types.Result<Nat> {
        switch (result) {
            case (#err(error)) #err(error.code # ": " # error.message);
            case (#ok(reply)) {
                let decoded : ?Nat = from_candid reply;
                switch (decoded) {
                    case (?value) #ok(value);
                    case null #err("Ledger returned an unexpected " # valueLabel);
                };
            };
        };
    };
};
