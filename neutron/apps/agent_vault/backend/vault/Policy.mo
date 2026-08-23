// Pure policy engine — no state, no I/O, no external calls. Ported verbatim from
// the M3 reference (src/Policy.mo); only the types import moved to the schema
// module. This is the classification core that decides Autonomous vs Escalation
// vs Forbidden, and the spend-window + circuit-breaker accounting.
import V "../memory/agentvault/v1";

module {
    public func contains(xs : [Principal], x : Principal) : Bool {
        for (v in xs.vals()) { if (v == x) return true };
        false;
    };

    public func pairAllowed(xs : [V.TokenPair], from : Principal, to : Principal) : Bool {
        for (p in xs.vals()) { if (p.from == from and p.to == to) return true };
        false;
    };

    // Sum of spend entries within [now - window, now]. Windows are nanoseconds.
    public func spendIn(spend : [V.Spend], now : Int, window : Int) : Nat {
        let cutoff = now - window;
        var total = 0;
        for (entry in spend.vals()) {
            if (entry.timestamp >= cutoff and entry.timestamp <= now) total += entry.amount;
        };
        total;
    };

    // A failed settlement increments the streak and trips the breaker once it
    // reaches the threshold; the breaker is sticky (stays tripped) until reset.
    public func recordFailure(policy : V.Policy) : V.Policy {
        let failures = policy.consecutiveFailures + 1;
        {
            policy with
            consecutiveFailures = failures;
            circuitBreaker = policy.circuitBreaker or (policy.failureThreshold > 0 and failures >= policy.failureThreshold);
        };
    };

    public func recordSuccess(policy : V.Policy) : V.Policy {
        { policy with consecutiveFailures = 0 };
    };

    // The heart of the vault: map a proposed action to a tier. Circuit breaker
    // forbids everything; a zero amount is always forbidden; anything outside the
    // allowlists or over any limit escalates to human approval; otherwise it is
    // autonomous. Checks are ordered cheap-to-expensive and most-to-least severe.
    public func classify(action : V.Action, policy : V.Policy, hourly : Nat, daily : Nat) : (V.Tier, ?V.VaultError) {
        if (policy.circuitBreaker) return (#Forbidden, ?#CircuitBreakerActive);
        switch (action) {
            case (#transfer(p)) {
                if (p.amount == 0) return (#Forbidden, ?#InvalidAmount);
                if (not contains(policy.allowlists.recipients, p.recipient)) return (#Escalation, ?#RecipientNotAllowed);
                if (p.amount > policy.limits.maxPerTx) return (#Escalation, ?#PerTransactionLimit);
                if (hourly + p.amount > policy.limits.maxHourlySpend) return (#Escalation, ?#HourlyLimit);
                if (daily + p.amount > policy.limits.maxDailySpend) return (#Escalation, ?#DailyLimit);
                (#Autonomous, null);
            };
            case (#swap(p)) {
                if (p.amount == 0) return (#Forbidden, ?#InvalidAmount);
                if (not contains(policy.allowlists.dexes, p.dex)) return (#Escalation, ?#DexNotAllowed);
                if (not pairAllowed(policy.allowlists.pairs, p.fromToken, p.toToken)) return (#Escalation, ?#TokenPairNotAllowed);
                if (p.amount > policy.limits.maxPerTx) return (#Escalation, ?#PerTransactionLimit);
                if (hourly + p.amount > policy.limits.maxHourlySpend) return (#Escalation, ?#HourlyLimit);
                if (daily + p.amount > policy.limits.maxDailySpend) return (#Escalation, ?#DailyLimit);
                (#Autonomous, null);
            };
        };
    };
};
