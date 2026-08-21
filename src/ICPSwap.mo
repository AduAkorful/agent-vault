import T "Types";
import Principal "mo:base/Principal";
module {
  public type ProtocolError = { #CommonError; #InsufficientFunds; #InternalError : Text; #UnsupportedToken : Text };
  public type Token = { address : Text; standard : Text };
  public type Factory = actor { getPool : query ({ fee : Nat; token0 : Token; token1 : Token }) -> async { #ok : { fee : Nat; token0 : Token; token1 : Token; canisterId : Principal }; #err : ProtocolError } };
  public type Pool = actor { quote : query ({ zeroForOne : Bool; amountIn : Text; amountOutMinimum : Text }) -> async { #ok : Nat; #err : ProtocolError }; depositFromAndSwap : ({ amountIn : Text; zeroForOne : Bool; amountOutMinimum : Text; tokenInFee : Nat; tokenOutFee : Nat }) -> async { #ok : Nat; #err : ProtocolError } };
  public func documentedFactory() : Principal { Principal.fromText("4mmnk-kiaaa-aaaag-qbllq-cai") };
  public func unsupported(reason : Text) : T.Settlement { #failure({ code = "ICPSWAP_UNSUPPORTED"; message = reason; partial = false }) };
}
