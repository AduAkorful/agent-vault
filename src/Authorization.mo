module {
  public func isController(caller : Principal, controller : Principal) : Bool {
    caller == controller
  };
  public func isAgent(caller : Principal, controller : Principal, agents : [Principal]) : Bool {
    if (caller == controller) return true;
    for (agent in agents.vals()) { if (caller == agent) return true };
    false
  };
}
