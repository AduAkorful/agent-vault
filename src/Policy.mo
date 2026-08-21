import T "Types";

module {
  public func contains(xs : [Principal], x : Principal) : Bool { for (v in xs.vals()) { if (v == x) return true }; false };
  public func pairAllowed(xs : [T.TokenPair], from : Principal, to : Principal) : Bool { for (p in xs.vals()) { if (p.from == from and p.to == to) return true }; false };
  public func spendIn(spend : [T.Spend], now : Int, window : Int) : Nat {
    let cutoff = now - window;
    var total = 0;
    for (entry in spend.vals()) {
      if (entry.timestamp >= cutoff and entry.timestamp <= now) total += entry.amount;
    };
    total
  };
  public func recordFailure(policy : T.Policy) : T.Policy {
    let failures = policy.consecutiveFailures + 1;
    {
      policy with
      consecutiveFailures = failures;
      circuitBreaker = policy.circuitBreaker or (policy.failureThreshold > 0 and failures >= policy.failureThreshold);
    }
  };
  public func recordSuccess(policy : T.Policy) : T.Policy {
    { policy with consecutiveFailures = 0 }
  };
  public func classify(action : T.Action, policy : T.Policy, hourly : Nat, daily : Nat) : (T.Tier, ?T.VaultError) {
    if (policy.circuitBreaker) return (#Forbidden, ?#CircuitBreakerActive);
    switch (action) {
      case (#transfer(p)) {
        if (p.amount == 0) return (#Forbidden, ?#InvalidAmount);
        if (not contains(policy.allowlists.recipients, p.recipient)) return (#Escalation, ?#RecipientNotAllowed);
        if (p.amount > policy.limits.maxPerTx) return (#Escalation, ?#PerTransactionLimit);
        if (hourly + p.amount > policy.limits.maxHourlySpend) return (#Escalation, ?#HourlyLimit);
        if (daily + p.amount > policy.limits.maxDailySpend) return (#Escalation, ?#DailyLimit);
        (#Autonomous, null)
      };
      case (#swap(p)) {
        if (p.amount == 0) return (#Forbidden, ?#InvalidAmount);
        if (not contains(policy.allowlists.dexes, p.dex)) return (#Escalation, ?#DexNotAllowed);
        if (not pairAllowed(policy.allowlists.pairs, p.fromToken, p.toToken)) return (#Escalation, ?#TokenPairNotAllowed);
        if (p.amount > policy.limits.maxPerTx) return (#Escalation, ?#PerTransactionLimit);
        if (hourly + p.amount > policy.limits.maxHourlySpend) return (#Escalation, ?#HourlyLimit);
        if (daily + p.amount > policy.limits.maxDailySpend) return (#Escalation, ?#DailyLimit);
        (#Autonomous, null)
      };
    }
  };
}
