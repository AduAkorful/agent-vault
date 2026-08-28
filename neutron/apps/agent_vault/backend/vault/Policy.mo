// Pure policy engine — no state, no I/O, no external calls. This is the
// classification core that decides Autonomous vs Escalation vs Forbidden, and
// owns policy validation plus spend-window/circuit-breaker accounting.
import V "../memory/agentvault/v2";

module {
    public func contains(xs : [Principal], x : Principal) : Bool {
        for (v in xs.vals()) { if (v == x) return true };
        false;
    };

    public func pairAllowed(xs : [V.TokenPair], from : Principal, to : Principal) : Bool {
        for (p in xs.vals()) { if (p.from == from and p.to == to) return true };
        false;
    };

    // Look up the per-token velocity limits, or null if this token has none
    // configured (⇒ it can never settle autonomously — safe by default).
    public func limitFor(policy : V.Policy, token : Principal) : ?V.TokenLimits {
        for (tl in policy.limits.vals()) { if (tl.token == token) return ?tl.limits };
        null;
    };

    // Policy writes are validated before persistence. A zero budget or an
    // inverted window would either disable the intended guardrail or make its
    // interpretation ambiguous; duplicate token entries would make lookup
    // order observable, so both are rejected.
    public func validPolicy(policy : V.Policy) : Bool {
        if (policy.failureThreshold == 0) return false;
        for (left in policy.limits.vals()) {
            if (left.limits.maxPerTx == 0 or left.limits.maxHourlySpend == 0 or left.limits.maxDailySpend == 0) return false;
            if (left.limits.maxPerTx > left.limits.maxHourlySpend or left.limits.maxHourlySpend > left.limits.maxDailySpend) return false;
            var seen = 0;
            for (right in policy.limits.vals()) { if (right.token == left.token) seen += 1 };
            if (seen > 1) return false;
        };
        true;
    };

    // Fee-inclusive spend for one token within [now - window, now]. Windows are
    // nanoseconds. Sums `amount + fee` because the ledger debits both, and filters
    // by token so limits in different tokens' base units are never mixed.
    public func spendIn(spend : [V.Spend], token : Principal, now : Int, window : Int) : Nat {
        let cutoff = now - window;
        var total = 0;
        for (entry in spend.vals()) {
            if (entry.token == token and entry.timestamp >= cutoff and entry.timestamp <= now) total += entry.amount + entry.fee;
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
    // allowlists escalates to human approval. A token with no configured limits
    // can never settle autonomously (⇒ Escalation) — safe by default. All limit
    // comparisons are fee-inclusive (`debit = amount + fee`) and in the token's
    // own base units. `fee`, `hourly`, and `daily` are supplied by the caller for
    // the specific token being spent (the from-token for a swap). Checks are
    // ordered cheap-to-expensive and most-to-least severe.
    public func classify(action : V.Action, policy : V.Policy, fee : Nat, hourly : Nat, daily : Nat) : (V.Tier, ?V.VaultError) {
        if (policy.circuitBreaker) return (#Forbidden, ?#CircuitBreakerActive);
        switch (action) {
            case (#transfer(p)) {
                if (p.amount == 0) return (#Forbidden, ?#InvalidAmount);
                if (not contains(policy.allowlists.recipients, p.recipient)) return (#Escalation, ?#RecipientNotAllowed);
                let limits = switch (limitFor(policy, p.token)) { case (?l) l; case null return (#Escalation, ?#TokenLimitNotConfigured) };
                let debit = p.amount + fee;
                if (debit > limits.maxPerTx) return (#Escalation, ?#PerTransactionLimit);
                if (hourly + debit > limits.maxHourlySpend) return (#Escalation, ?#HourlyLimit);
                if (daily + debit > limits.maxDailySpend) return (#Escalation, ?#DailyLimit);
                (#Autonomous, null);
            };
            case (#swap(p)) {
                // Swaps NEVER settle autonomously. Unlike a transfer, the swap
                // round-trip (approve → depositFromAndSwap → withdraw → sweep)
                // spans several ledgers plus the DEX and cannot lean on a single
                // ledger's duplicate-detection to make a re-submit safe: an
                // interrupted swap needs stateful recovery (inspect the pool's
                // unused balance, withdraw what is stranded) and must never be
                // blindly re-run. So every swap parks for explicit owner approval
                // and the autonomous tier stays transfers-only. A zero amount is
                // still outright invalid; the breaker (checked above) still
                // forbids everything. The dex/pair allowlists and the
                // slippage/quote/min-return/balance guards are enforced at
                // settlement time (main.mo settleSwap), where the live quote and
                // balance are known and a stale quote can actually be re-checked.
                if (p.amount == 0) return (#Forbidden, ?#InvalidAmount);
                (#Escalation, ?#SwapRequiresApproval);
            };
        };
    };
};
