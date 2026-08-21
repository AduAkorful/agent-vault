module {
  public type Account = { owner : Principal; subaccount : ?Blob };
  public type TransferArgs = { from_subaccount : ?Blob; to : Account; amount : Nat; fee : ?Nat; memo : ?Blob; created_at_time : ?Nat64 };
  public type TransferError = { #BadFee : { expected_fee : Nat }; #CreatedInFuture : { ledger_time : Nat64 }; #Duplicate : { duplicate_of : Nat }; #GenericError : { error_code : Nat; message : Text }; #InsufficientFunds : { balance : Nat }; #TemporarilyUnavailable; #TooOld };
  public type Ledger = actor { icrc1_balance_of : query (Account) -> async Nat; icrc1_decimals : query () -> async Nat8; icrc1_fee : query () -> async Nat; icrc1_symbol : query () -> async Text; icrc1_supported_standards : query () -> async [{ name : Text; url : Text }]; icrc1_transfer : (TransferArgs) -> async { #Ok : Nat; #Err : TransferError } };
  public type ApproveArgs = { from_subaccount : ?Blob; spender : Account; amount : Nat; expected_allowance : ?Nat; expires_at : ?Nat64; fee : ?Nat; memo : ?Blob; created_at_time : ?Nat64 };
  public type ApproveError = { #AllowanceChanged : { current_allowance : Nat }; #BadFee : { expected_fee : Nat }; #CreatedInFuture : { ledger_time : Nat64 }; #Duplicate : { duplicate_of : Nat }; #Expired : { ledger_time : Nat64 }; #GenericError : { error_code : Nat; message : Text }; #InsufficientFunds : { balance : Nat }; #TemporarilyUnavailable; #TooOld };
  public type ICRC2Ledger = actor { icrc2_approve : (ApproveArgs) -> async { #Ok : Nat; #Err : ApproveError } };
  public func account(owner : Principal) : Account { { owner; subaccount = null } };
}
