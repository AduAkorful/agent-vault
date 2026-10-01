// Pure policy engine — no state, no I/O, no external calls. This is the
// classification core that decides Autonomous vs Escalation vs Forbidden, and
// owns policy validation plus spend-window/circuit-breaker accounting.
import V "../memory/agentvault/v4";
import Int "mo:core/Int";
import Array "mo:core/Array";

module {
    public func contains(xs : [Principal], x : Principal) : Bool {
        for (v in xs.vals()) { if (v == x) return true };
        false;
    };

    public func pairAllowed(xs : [V.TokenPair], from : Principal, to : Principal) : Bool {
        for (p in xs.vals()) { if (p.from == from and p.to == to) return true };
        false;
    };

    // Additive per-token recipient check: a recipient is allowed for a token if
    // it appears in the per-token recipient list for that token. This supplements
    // (not replaces) the global recipient allowlist — a recipient passes if it is
    // in either. Empty tokenRecipients is backward compatible (global-only).
    public func tokenRecipientsContains(allowlists : V.Allowlists, token : Principal, recipient : Principal) : Bool {
        for ((tk, recipients) in allowlists.tokenRecipients.vals()) {
            if (tk == token) {
                for (r in recipients.vals()) { if (r == recipient) return true };
            };
        };
        false;
    };

    // Per-recipient UTC time window check. If the recipient has no entry in
    // allowedHours, the check passes (no restriction). If it has an entry, the
    // current UTC hour must fall within [start, end) — supporting wraparound at
    // midnight (start > end means the window crosses midnight, e.g. 22→6) — and
    // the current weekday (0=Sun..6=Sat) must be in the window's `days` list, or
    // `days` must be empty (every weekday allowed).
    public func withinAllowedHours(allowedHours : [(Principal, V.TimeWindow)], recipient : Principal, now : Int) : Bool {
        let hour = (now / 3_600_000_000_000) % 24;
        // Unix-day weekday: 1970-01-01 was Thursday (4). Modulo 7 gives 0=Thu,
        // 1=Fri, 2=Sat, 3=Sun, 4=Mon, 5=Tue, 6=Wed. We want 0=Sun..6=Sat, so
        // remap: (raw + 3) % 7. `now` is a non-negative wall-clock timestamp,
        // so the result is always in 0..6 — Int.toNat never returns null.
        let secsPerDay = 86_400;
        let dayIndex : Int = (((now / 1_000_000_000) / secsPerDay) + 3) % 7;
        // `now` is a non-negative wall-clock nanosecond timestamp, so
        // `dayIndex` is also non-negative and falls in 0..6. Int.abs
        // converts to a Nat without sign checks (cheaper than Int.toNat's
        // null branch).
        let d = Int.abs(dayIndex);
        for ((r, window) in allowedHours.vals()) {
            if (r == recipient) {
                let start = Int.fromNat(window.start);
                let end = Int.fromNat(window.end);
                let inHour = if (start < end) {
                    // Normal range: start <= hour < end
                    hour >= start and hour < end;
                } else {
                    // Wrapping range: start <= hour < 24 OR 0 <= hour < end
                    hour >= start or hour < end;
                };
                if (not inHour) return false;
                if (window.days.size() == 0) return true;
                let inDay = Array.contains<Nat>(window.days, d, func(a, b) { a == b });
                if (not inDay) return false;
                return true;
            };
        };
        true;
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
    // order observable, so both are rejected. Time windows must have valid
    // UTC hours (0–23) and weekday entries in 0..6 with no duplicates, and
    // approvalTimelock must be non-negative (<= 0 is treated as 0 = immediate,
    // which is valid).
    public func validPolicy(policy : V.Policy) : Bool {
        if (policy.failureThreshold == 0) return false;
        for (left in policy.limits.vals()) {
            if (left.limits.maxPerTx == 0 or left.limits.maxHourlySpend == 0 or left.limits.maxDailySpend == 0) return false;
            if (left.limits.maxPerTx > left.limits.maxHourlySpend or left.limits.maxHourlySpend > left.limits.maxDailySpend) return false;
            var seen = 0;
            for (right in policy.limits.vals()) { if (right.token == left.token) seen += 1 };
            if (seen > 1) return false;
        };
        // Validate time windows: hours must be in 0..23 and days in 0..6 with
        // no duplicates.
        for ((_, window) in policy.allowedHours.vals()) {
            if (window.start < 0 or window.start > 23 or window.end < 0 or window.end > 23) return false;
            var daySeen : [Nat] = [];
            for (d in window.days.vals()) {
                if (d > 6) return false;
                if (Array.contains<Nat>(daySeen, d, func(a, b) { a == b })) return false;
                daySeen := Array.concat(daySeen, [d]);
            };
        };
        // Validate per-token recipient lists: no duplicate token entries
        var tokenSeen : [Principal] = [];
        for ((token, _) in policy.allowlists.tokenRecipients.vals()) {
            for (s in tokenSeen.vals()) { if (s == token) return false };
            tokenSeen := Array.concat(tokenSeen, [token]);
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
    // the specific token being spent (the from-token for a swap). `now` is the
    // current timestamp for time-window checks. Checks are ordered
    // cheap-to-expensive and most-to-least severe.
    public func classify(action : V.Action, policy : V.Policy, fee : Nat, hourly : Nat, daily : Nat, now : Int) : (V.Tier, ?V.VaultError) {
        if (policy.circuitBreaker) return (#Forbidden, ?#CircuitBreakerActive);
        switch (action) {
            case (#transfer(p)) {
                if (p.amount == 0) return (#Forbidden, ?#InvalidAmount);
                // Additive recipient check: allowed if in the global allowlist
                // OR in the per-token recipient allowlist for this specific token.
                // Backward compatible: empty tokenRecipients reduces to global-only.
                if (not contains(policy.allowlists.recipients, p.recipient) and not tokenRecipientsContains(policy.allowlists, p.token, p.recipient)) return (#Escalation, ?#RecipientNotAllowed);
                // Time-based check: if the recipient has an allowed-hours window,
                // the proposal must fall within it. Outside the window → Escalation.
                if (not withinAllowedHours(policy.allowedHours, p.recipient, now)) return (#Escalation, ?#OutsideAllowedHours);
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
