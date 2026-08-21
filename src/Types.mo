module {
  public type Token = { id : Principal; symbol : Text; decimals : Nat8; standard : Text; fee : Nat };
  public type Balance = { token : Token; amount : Nat; syncedAt : Int };
  public type TokenPair = { from : Principal; to : Principal };
  public type Limits = { maxPerTx : Nat; maxHourlySpend : Nat; maxDailySpend : Nat };
  public type Allowlists = { recipients : [Principal]; dexes : [Principal]; pairs : [TokenPair] };
  public type Policy = { limits : Limits; allowlists : Allowlists; circuitBreaker : Bool; failureThreshold : Nat; consecutiveFailures : Nat };
  public type TransferProposal = { token : Principal; recipient : Principal; amount : Nat; reason : Text };
  public type SwapProposal = { fromToken : Principal; toToken : Principal; dex : Principal; amount : Nat; minReturn : Nat; slippageBps : Nat; quoteExpiresAt : Int; reason : Text };
  public type Action = { #transfer : TransferProposal; #swap : SwapProposal };
  public type Tier = { #Autonomous; #Escalation; #Forbidden };
  public type ExternalError = { code : Text; message : Text; partial : Bool };
  public type Receipt = { #transfer : { token : Principal; blockIndex : Nat }; #swap : { dex : Principal; pool : Principal; transactionId : ?Nat; approvalBlockIndex : Nat; amountOut : Nat } };
  public type Settlement = { #success : Receipt; #failure : ExternalError };
  public type VaultError = { #Unauthorized; #CircuitBreakerActive; #InvalidAmount; #PerTransactionLimit; #HourlyLimit; #DailyLimit; #RecipientNotAllowed; #DexNotAllowed; #TokenPairNotAllowed; #TicketNotFound; #AlreadyResolved; #SettlementInFlight; #SettlementLockNotStale; #InsufficientBalance; #UnsupportedTokenStandard; #ExternalFailure : ExternalError; #InvalidSlippage; #InvalidQuote; #QuoteExpired };
  public type Outcome = { tier : Tier; error : ?VaultError; ticketId : ?Nat; auditId : Nat; settlement : ?Settlement };
  public type Ticket = { id : Nat; action : Action; createdAt : Int; policyError : ?VaultError; status : { #pending; #approved : Receipt; #rejected : Text } };
  public type AuditEntry = { id : Nat; action : Action; tier : Tier; policyError : ?VaultError; settlement : ?Settlement; timestamp : Int; ticketId : ?Nat; note : Text };
  public type Spend = { timestamp : Int; amount : Nat };
  public type SettlementLock = { action : Action; startedAt : Int };
  public type DexConfig = { factory : Principal; feeTier : Nat };
  public type VaultState = { balances : [Balance]; policy : Policy; hourlySpend : Nat; dailySpend : Nat; pending : [Ticket]; audit : [AuditEntry]; settlementInFlight : Bool; settlementLock : ?SettlementLock; approvedAgents : [Principal]; dexConfig : DexConfig };
  public type Result<T> = { #ok : T; #err : VaultError };
}
