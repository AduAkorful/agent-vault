import Array "mo:core/Array";
import V3 "./v3";
import V4 "./v4";

module {
    // v3 → v4 migration.
    //
    // Adds:
    //   - TimeWindow.days = [] (backward compatible: empty days = every weekday allowed)
    //
    // v3 TimeWindow has only `{ start; end }`. v4 adds `days: [Nat]` (Sun=0..Sat=6).
    // An empty list preserves the v3 behaviour (no day-of-week restriction), so this
    // migration is purely additive and never alters classification outcomes.
    public func migrate(old : V3.Mem) : V4.Mem {
        func upgradeWindow(window : V3.TimeWindow) : V4.TimeWindow {
            {
                start = window.start;
                end = window.end;
                days = ([] : [Nat])
            };
        };

        func upgradeAllowedHours(list : [(Principal, V3.TimeWindow)]) : [(Principal, V4.TimeWindow)] {
            Array.map<(Principal, V3.TimeWindow), (Principal, V4.TimeWindow)>(list, func(entry) {
                let (recipient, window) = entry;
                (recipient, upgradeWindow(window));
            });
        };

        func upgradePolicy(p : V3.Policy) : V4.Policy {
            {
                limits = p.limits;
                allowlists = {
                    recipients = p.allowlists.recipients;
                    dexes = p.allowlists.dexes;
                    pairs = p.allowlists.pairs;
                    tokenRecipients = p.allowlists.tokenRecipients;
                };
                circuitBreaker = p.circuitBreaker;
                failureThreshold = p.failureThreshold;
                consecutiveFailures = p.consecutiveFailures;
                allowedHours = upgradeAllowedHours(p.allowedHours);
                approvalTimelock = p.approvalTimelock;
            };
        };

        func upgradeProfile(profile : V3.PolicyProfile) : V4.PolicyProfile {
            {
                id = profile.id;
                name = profile.name;
                revision = profile.revision;
                policy = upgradePolicy(profile.policy);
            };
        };

        let v4Policies = Array.map<V3.PolicyProfile, V4.PolicyProfile>(old.policies, upgradeProfile);

        {
            var policy = upgradePolicy(old.policy);
            var policies = v4Policies;
            var activePolicyId = old.activePolicyId;
            var nextPolicyId = old.nextPolicyId;
            var spend = old.spend;
            var nextId = old.nextId;
            var liveBalances = old.liveBalances;
            var settlementTickets = old.settlementTickets;
            var activity = old.activity;
            var settlementInFlight = old.settlementInFlight;
            var settlementLock = old.settlementLock;
            var dexConfig = old.dexConfig;
            var recipientLabels = old.recipientLabels;
            var vaultSubaccount = old.vaultSubaccount;
        };
    };
};
