import Array "mo:base/Array";
import P "Policy";
import T "Types";
module {
  public type State = { spend : [T.Spend]; tickets : [T.Ticket]; audit : [T.AuditEntry]; nextId : Nat };
  public type Transition = { state : State; outcome : T.Outcome };
  public func apply(state : State, action : T.Action, policy : T.Policy, now : Int) : Transition {
    let hourly = P.spendIn(state.spend, now, 3_600_000_000_000);
    let daily = P.spendIn(state.spend, now, 86_400_000_000_000);
    let (tier, error) = P.classify(action, policy, hourly, daily);
    let auditId = state.nextId;
    switch (tier) {
      case (#Escalation) {
        let ticketId = auditId + 1;
        let ticket : T.Ticket = { id = ticketId; action; createdAt = now; policyError = error; status = #pending };
        let entry : T.AuditEntry = { id = auditId; action; tier; policyError = error; settlement = null; timestamp = now; ticketId = ?ticketId; note = "pending approval" };
        { state = { spend = state.spend; tickets = Array.append(state.tickets, [ticket]); audit = Array.append(state.audit, [entry]); nextId = ticketId + 1 }; outcome = { tier; error; ticketId = ?ticketId; auditId; settlement = null } }
      };
      case (_) {
        let entry : T.AuditEntry = { id = auditId; action; tier; policyError = error; settlement = null; timestamp = now; ticketId = null; note = if (tier == #Forbidden) "policy rejected" else "settlement required" };
        { state = { spend = state.spend; tickets = state.tickets; audit = Array.append(state.audit, [entry]); nextId = auditId + 1 }; outcome = { tier; error; ticketId = null; auditId; settlement = null } }
      };
    }
  }
}
