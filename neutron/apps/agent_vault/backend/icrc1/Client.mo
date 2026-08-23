// ICRC-1 client — builds `backend_calls` requests and decodes replies for the
// individual ledger methods the vault settles over. Faithful to the M3 actor,
// which read symbol/decimals/fee/standards with individual queries rather than a
// single icrc1_metadata call. Modeled on apps/wallet/backend/icrc1/Client.mo.
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

    public func balanceRequest(ledger : Principal, owner : Principal) : Capabilities.CallRequest {
        let account : Types.Account = { owner; subaccount = null };
        { canister = ledger; method = "icrc1_balance_of"; args = to_candid (account); cycles = 0 };
    };

    // created_at_time is null: in this app the settlement reentrancy lock
    // (settlementInFlight, ADR-005) is the dedup guard and each proposal is a
    // single awaited settlement, so a ledger-side dedup window adds nothing here.
    // Faithful to the M3 reference actor.
    public func transferRequest(
        ledger : Principal,
        destination : Types.Account,
        amount : Nat,
        fee : Nat,
    ) : Capabilities.CallRequest {
        let args : Types.TransferArg = {
            from_subaccount = null;
            to = destination;
            amount;
            fee = ?fee;
            memo = null;
            created_at_time = null;
        };
        { canister = ledger; method = "icrc1_transfer"; args = to_candid (args); cycles = 0 };
    };

    // ----- reply decoders (a null from_candid = candid shape mismatch → #err) -----
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
