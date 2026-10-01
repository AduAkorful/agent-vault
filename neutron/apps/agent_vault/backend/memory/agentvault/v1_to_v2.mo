import Array "mo:core/Array";
import V1 "./v1";
import V2 "./v2";

module {
    public func migrate(old : V1.Mem) : V2.Mem {
        let profile : V2.PolicyProfile = {
            id = 0;
            name = "Default Policy";
            revision = 0;
            policy = old.policy;
        };
        let evaluation : ?V2.PolicyEvaluation = null;
        let settlementTickets = Array.map<V1.Ticket, V2.Ticket>(old.settlementTickets, func(ticket) {
            {
                id = ticket.id;
                action = ticket.action;
                createdAt = ticket.createdAt;
                policyError = ticket.policyError;
                evaluation;
                status = ticket.status;
            }
        });
        let activity = Array.map<V1.AuditEntry, V2.AuditEntry>(old.activity, func(entry) {
            {
                id = entry.id;
                action = entry.action;
                tier = entry.tier;
                policyError = entry.policyError;
                evaluation;
                settlement = entry.settlement;
                timestamp = entry.timestamp;
                ticketId = entry.ticketId;
                note = entry.note;
            }
        });
        {
            var policy = old.policy;
            var policies = [profile];
            var activePolicyId = 0;
            var nextPolicyId = 1;
            var spend = old.spend;
            var nextId = old.nextId;
            var liveBalances = old.liveBalances;
            var settlementTickets;
            var activity;
            var settlementInFlight = old.settlementInFlight;
            var settlementLock = switch (old.settlementLock) {
                case null null;
                case (?lock) ?{
                    action = lock.action;
                    startedAt = lock.startedAt;
                    ticketId = lock.ticketId;
                    profile = null;
                    intent = lock.intent;
                };
            };
            var dexConfig = old.dexConfig;
            var recipientLabels = [] : [(Principal, Text)];
            var vaultSubaccount = old.vaultSubaccount;
        }
    };
};
