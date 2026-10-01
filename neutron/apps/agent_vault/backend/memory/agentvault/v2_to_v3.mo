import Array "mo:core/Array";
import V2 "./v2";
import V3 "./v3";

module {
    // v2 → v3 migration.
    //
    // Adds:
    //   - Allowlists.tokenRecipients = [] (backward compatible: additive OR with global recipients)
    //   - Policy.allowedHours = [] (backward compatible: no time restrictions)
    //   - Policy.approvalTimelock = 0 (backward compatible: immediate approval)
    //   - Ticket.timelockUntil = null (backward compatible: no deferred settlement)
    //
    // These are all safe defaults that preserve existing behavior: an empty
    // tokenRecipients list means only global recipients are checked; an empty
    // allowedHours list means no time restrictions; approvalTimelock = 0 means
    // approveTicket settles immediately as before.
    public func migrate(old : V2.Mem) : V3.Mem {
        // Helper: upgrade a V2.Policy to a V3.Policy with safe defaults for
        // the new fields.
        func upgradePolicy(p : V2.Policy) : V3.Policy {
            {
                limits = p.limits;
                allowlists = {
                    recipients = p.allowlists.recipients;
                    dexes = p.allowlists.dexes;
                    pairs = p.allowlists.pairs;
                    tokenRecipients = [] : [(Principal, [Principal])];
                };
                circuitBreaker = p.circuitBreaker;
                failureThreshold = p.failureThreshold;
                consecutiveFailures = p.consecutiveFailures;
                allowedHours = [] : [(Principal, V3.TimeWindow)];
                approvalTimelock = 0;
            };
        };

        // Upgrade a policy profile's policy.
        func upgradeProfile(profile : V2.PolicyProfile) : V3.PolicyProfile {
            {
                id = profile.id;
                name = profile.name;
                revision = profile.revision;
                policy = upgradePolicy(profile.policy);
            };
        };

        // Upgrade a V2.Ticket to a V3.Ticket (add timelockUntil = null).
        func upgradeTicket(t : V2.Ticket) : V3.Ticket {
            {
                id = t.id;
                action = t.action;
                createdAt = t.createdAt;
                policyError = t.policyError;
                evaluation = t.evaluation;
                status = t.status;
                timelockUntil = null;
            };
        };

        let v3Policies = Array.map<V2.PolicyProfile, V3.PolicyProfile>(old.policies, upgradeProfile);
        let v3Tickets = Array.map<V2.Ticket, V3.Ticket>(old.settlementTickets, upgradeTicket);

        {
            var policy = upgradePolicy(old.policy);
            var policies = v3Policies;
            var activePolicyId = old.activePolicyId;
            var nextPolicyId = old.nextPolicyId;
            var spend = old.spend;
            var nextId = old.nextId;
            var liveBalances = old.liveBalances;
            var settlementTickets = v3Tickets;
            var activity = old.activity;
            var settlementInFlight = old.settlementInFlight;
            var settlementLock = old.settlementLock;
            var dexConfig = old.dexConfig;
            var recipientLabels = old.recipientLabels;
            var vaultSubaccount = old.vaultSubaccount;
        };
    };
};
