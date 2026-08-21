import Array "mo:base/Array";
import Error "mo:base/Error";
import Int "mo:base/Int";
import Nat "mo:base/Nat";
import Principal "mo:base/Principal";
import Text "mo:base/Text";
import Time "mo:base/Time";
import Auth "Authorization";
import ICP "ICPSwap";
import L "Ledger";
import P "Policy";
import T "Types";

actor class AgentVault(owner : Principal) = this {
  stable var policy : T.Policy = { limits = { maxPerTx = 100; maxHourlySpend = 500; maxDailySpend = 1000 }; allowlists = { recipients = []; dexes = []; pairs = [] }; circuitBreaker = false; failureThreshold = 3; consecutiveFailures = 0 };
  stable var spend : [T.Spend] = [];
  stable var nextId : Nat = 0;

  stable var liveBalances : [T.Balance] = [];
  stable var settlementTickets : [T.Ticket] = [];
  stable var activity : [T.AuditEntry] = [];
  stable var approvedAgents : [Principal] = [];
  stable var settlementInFlight : Bool = false;
  stable var settlementLock : ?T.SettlementLock = null;
  stable var dexConfig : T.DexConfig = { factory = ICP.documentedFactory(); feeTier = 3000 };

  func controller(caller : Principal) : Bool { Auth.isController(caller, owner) };
  func agent(caller : Principal) : Bool { Auth.isAgent(caller, owner, approvedAgents) };
  func amountOf(action : T.Action) : Nat { switch (action) { case (#transfer(p)) p.amount; case (#swap(p)) p.amount } };
  func external(code : Text, message : Text, partial : Bool) : T.Settlement { #failure({ code; message; partial }) };
  func addAudit(action : T.Action, tier : T.Tier, policyError : ?T.VaultError, settlement : ?T.Settlement, ticketId : ?Nat, note : Text) : Nat {
    let id = nextId; nextId += 1;
    activity := Array.append(activity, [{ id; action; tier; policyError; settlement; timestamp = Time.now(); ticketId; note }]); id
  };
  func setBalance(value : T.Balance) {
    liveBalances := Array.append(Array.filter<T.Balance>(liveBalances, func (b) { b.token.id != value.token.id }), [value])
  };
  func pending() : [T.Ticket] { Array.filter<T.Ticket>(settlementTickets, func (t) { t.status == #pending }) };
  func hasStandard(xs : [{ name : Text; url : Text }], wanted : Text) : Bool { for (x in xs.vals()) { if (Text.equal(x.name, wanted)) return true }; false };
  // ICRC-2 extends ICRC-1, so any ledger advertising ICRC-2 necessarily supports the
  // ICRC-1 operations (balance_of/fee/transfer) the vault relies on. Accept either tag
  // so spec-compliant ICRC-2 ledgers that omit the redundant "ICRC-1" entry are not
  // wrongly rejected; a token that merely claims ICRC-2 without honoring it still fails
  // safely at the actual ledger call with a typed error.
  func supportsICRC1(xs : [{ name : Text; url : Text }]) : Bool { hasStandard(xs, "ICRC-1") or hasStandard(xs, "ICRC-2") };

  func sync(token : Principal) : async T.Result<T.Balance> {
    let ledger : L.Ledger = actor (Principal.toText(token));
    try {
      let standards = await ledger.icrc1_supported_standards();
      if (not supportsICRC1(standards)) return #err(#UnsupportedTokenStandard);
      let symbol = await ledger.icrc1_symbol();
      let decimals = await ledger.icrc1_decimals();
      let fee = await ledger.icrc1_fee();
      let amount = await ledger.icrc1_balance_of(L.account(Principal.fromActor(this)));
      let value = { token = { id = token; symbol; decimals; standard = if (hasStandard(standards, "ICRC-2")) "ICRC2" else "ICRC1"; fee }; amount; syncedAt = Time.now() };
      setBalance(value); #ok(value)
    } catch (e) { #err(#ExternalFailure({ code = "LEDGER_REJECT"; message = Error.message(e); partial = false })) }
  };

  func transfer(p : T.TransferProposal) : async T.Settlement {
    let ledger : L.Ledger = actor (Principal.toText(p.token));
    try {
      let balance = await ledger.icrc1_balance_of(L.account(Principal.fromActor(this)));
      let fee = await ledger.icrc1_fee();
      if (balance < p.amount + fee) return external("INSUFFICIENT_BALANCE", "vault balance does not cover amount and ledger fee", false);
      switch (await ledger.icrc1_transfer({ from_subaccount = null; to = L.account(p.recipient); amount = p.amount; fee = ?fee; memo = null; created_at_time = null })) {
        case (#Ok(index)) #success(#transfer({ token = p.token; blockIndex = index }));
        case (#Err(err)) external("LEDGER_ERROR", debug_show(err), false)
      }
    } catch (e) { external("LEDGER_REJECT", Error.message(e), false) }
  };

  func swap(p : T.SwapProposal) : async T.Settlement {
    if (p.slippageBps > 10_000) return external("INVALID_SLIPPAGE", "slippageBps must be at most 10000", false);
    if (Time.now() > p.quoteExpiresAt) return external("QUOTE_EXPIRED", "quote deadline passed before settlement", false);
    if (p.dex != dexConfig.factory) return external("DEX_NOT_CONFIGURED", "proposal dex does not match the configured ICPSwap factory", false);
    let fromLedger : L.Ledger = actor (Principal.toText(p.fromToken));
    let toLedger : L.Ledger = actor (Principal.toText(p.toToken));
    try {
      let fromStandards = await fromLedger.icrc1_supported_standards();
      if (not hasStandard(fromStandards, "ICRC-2")) return external("UNSUPPORTED_TOKEN", "ICPSwap depositFromAndSwap requires ICRC-2 input approval", false);
      let toStandards = await toLedger.icrc1_supported_standards();
      if (not supportsICRC1(toStandards)) return external("UNSUPPORTED_TOKEN", "output token does not support ICRC-1", false);
      let fromFee = await fromLedger.icrc1_fee(); let toFee = await toLedger.icrc1_fee();
      let factory : ICP.Factory = actor (Principal.toText(p.dex));
      switch (await factory.getPool({ fee = dexConfig.feeTier; token0 = { address = Principal.toText(p.fromToken); standard = "ICRC2" }; token1 = { address = Principal.toText(p.toToken); standard = if (hasStandard(toStandards, "ICRC-2")) "ICRC2" else "ICRC1" } })) {
        case (#err(err)) external("INVALID_PAIR", debug_show(err), false);
        case (#ok(data)) {
          let zeroForOne = data.token0.address == Principal.toText(p.fromToken);
          let pool : ICP.Pool = actor (Principal.toText(data.canisterId));
          switch (await pool.quote({ zeroForOne; amountIn = Nat.toText(p.amount); amountOutMinimum = "0" })) {
            case (#err(err)) external("QUOTE_FAILED", debug_show(err), false);
            case (#ok(quoted)) {
              // guard at function entry ensures slippageBps <= 10_000; subtracting in Int space keeps
              // the difference non-negative without the Nat-underflow trap warning. Nat is bignum, so
              // quoted * keepBps cannot overflow and needs no split-multiply.
              let keepBps : Nat = Int.abs((10_000 : Int) - p.slippageBps);
              let slippageFloor = quoted * keepBps / 10_000;
              if (p.minReturn < slippageFloor or p.minReturn > quoted) return external("INVALID_MIN_RETURN", "minReturn is outside the quote/slippage bounds", false);
              if (Time.now() > p.quoteExpiresAt) return external("QUOTE_EXPIRED", "quote deadline passed before approval", false);
              let icrc2 : L.ICRC2Ledger = actor (Principal.toText(p.fromToken));
              switch (await icrc2.icrc2_approve({ from_subaccount = null; spender = L.account(data.canisterId); amount = p.amount; expected_allowance = null; expires_at = null; fee = ?fromFee; memo = null; created_at_time = null })) {
                case (#Err(err)) external("APPROVAL_FAILED", debug_show(err), false);
                case (#Ok(approvalBlockIndex)) {
                  if (Time.now() > p.quoteExpiresAt) return external("QUOTE_EXPIRED_AFTER_APPROVAL", "quote deadline passed after approval", true);
                  switch (await pool.depositFromAndSwap({ amountIn = Nat.toText(p.amount); zeroForOne; amountOutMinimum = Nat.toText(p.minReturn); tokenInFee = fromFee; tokenOutFee = toFee })) {
                    case (#err(err)) external("SWAP_FAILED", debug_show(err), true);
                    case (#ok(amountOut)) {
                      // depositFromAndSwap returning #ok is the authoritative settlement signal: the input
                      // was pulled and the swap executed for `amountOut`. The pool does NOT push its
                      // OneStepSwap record synchronously — it enqueues the output withdrawal and only writes
                      // the terminal record to its sync buffer when the withdraw queue timer fires, after
                      // this call has already returned. So no synchronous lookup can correlate this swap to a
                      // pool transactionId (getPendingSyncData returns oldest-first and would surface a stale
                      // id from a prior swap, which is worse than none). The synchronous authoritative record
                      // is `amountOut` plus the approval block index; transactionId stays null.
                      #success(#swap({ dex = p.dex; pool = data.canisterId; transactionId = null; approvalBlockIndex; amountOut }))
                    }
                  }
                }
              }
            }
          }
        }
      }
    } catch (e) { external("DEX_REJECT", Error.message(e), false) }
  };

  func settle(action : T.Action) : async T.Settlement { switch (action) { case (#transfer(p)) await transfer(p); case (#swap(p)) await swap(p) } };
  func proposeAction(action : T.Action) : async T.Outcome {
    let hourly = P.spendIn(spend, Time.now(), 3_600_000_000_000); let daily = P.spendIn(spend, Time.now(), 86_400_000_000_000);
    let (tier, policyError) = P.classify(action, policy, hourly, daily);
    if (tier == #Forbidden) { let id = addAudit(action, tier, policyError, null, null, "policy rejected"); return { tier; error = policyError; ticketId = null; auditId = id; settlement = null } };
    if (tier == #Escalation) {
      let ticketId = nextId; nextId += 1;
      settlementTickets := Array.append(settlementTickets, [{ id = ticketId; action; createdAt = Time.now(); policyError; status = #pending }]);
      let id = addAudit(action, tier, policyError, null, ?ticketId, "pending approval");
      return { tier; error = policyError; ticketId = ?ticketId; auditId = id; settlement = null }
    };
    if (settlementInFlight) { let id = addAudit(action, tier, null, null, null, "settlement lock rejected"); return { tier; error = ?#SettlementInFlight; ticketId = null; auditId = id; settlement = null } };
    settlementInFlight := true; settlementLock := ?{ action; startedAt = Time.now() };
    let result = await settle(action);
    settlementInFlight := false; settlementLock := null;
    switch (result) { case (#success(_)) { spend := Array.append(spend, [{ timestamp = Time.now(); amount = amountOf(action) }]); policy := P.recordSuccess(policy) }; case (#failure(_)) { policy := P.recordFailure(policy) } };
    let id = addAudit(action, tier, null, ?result, null, "autonomous settlement");
    { tier; error = switch (result) { case (#failure(e)) ?#ExternalFailure(e); case (_) null }; ticketId = null; auditId = id; settlement = ?result }
  };

  public shared query ({ caller }) func getVaultState() : async T.Result<T.VaultState> { if (not agent(caller)) return #err(#Unauthorized); #ok({ balances = liveBalances; policy; hourlySpend = P.spendIn(spend, Time.now(), 3_600_000_000_000); dailySpend = P.spendIn(spend, Time.now(), 86_400_000_000_000); pending = pending(); audit = activity; settlementInFlight; settlementLock; approvedAgents; dexConfig }) };
  public shared query ({ caller }) func getActivityHistory(limit : Nat, offset : Nat) : async T.Result<[T.AuditEntry]> { if (not agent(caller)) return #err(#Unauthorized); let size = activity.size(); if (offset >= size) return #ok([]); let count = Nat.min(limit, size - offset); #ok(Array.tabulate<T.AuditEntry>(count, func(i) { activity[offset + i] })) };
  public shared query ({ caller }) func getPendingApprovals() : async T.Result<[T.Ticket]> { if (not agent(caller)) return #err(#Unauthorized); #ok(pending()) };
  public shared ({ caller }) func syncBalance(token : Principal) : async T.Result<T.Balance> { if (not agent(caller)) return #err(#Unauthorized); await sync(token) };
  public shared ({ caller }) func proposeTransfer(token : Principal, recipient : Principal, amount : Nat, reason : Text) : async T.Result<T.Outcome> { if (not agent(caller)) return #err(#Unauthorized); #ok(await proposeAction(#transfer({ token; recipient; amount; reason }))) };
  public shared ({ caller }) func proposeSwap(fromToken : Principal, toToken : Principal, dex : Principal, amount : Nat, minReturn : Nat, slippageBps : Nat, quoteExpiresAt : Int, reason : Text) : async T.Result<T.Outcome> { if (not agent(caller)) return #err(#Unauthorized); #ok(await proposeAction(#swap({ fromToken; toToken; dex; amount; minReturn; slippageBps; quoteExpiresAt; reason }))) };

  public shared ({ caller }) func approveTicket(ticketId : Nat) : async T.Result<T.Outcome> {
    if (not controller(caller)) return #err(#Unauthorized);
    var found : ?T.Ticket = null; for (ticket in settlementTickets.vals()) { if (ticket.id == ticketId) found := ?ticket };
    let ticket = switch (found) { case (null) return #err(#TicketNotFound); case (?value) value };
    if (ticket.status != #pending) return #err(#AlreadyResolved); if (settlementInFlight) return #err(#SettlementInFlight);
    let (tier, currentError) = P.classify(ticket.action, policy, P.spendIn(spend, Time.now(), 3_600_000_000_000), P.spendIn(spend, Time.now(), 86_400_000_000_000));
    if (tier == #Forbidden) return #err(switch (currentError) { case (?e) e; case (null) #CircuitBreakerActive });
    if (tier != #Escalation or currentError != ticket.policyError) return #err(switch (currentError) { case (?e) e; case (null) #AlreadyResolved });
    settlementInFlight := true; settlementLock := ?{ action = ticket.action; startedAt = Time.now() }; let result = await settle(ticket.action); settlementInFlight := false; settlementLock := null;
    switch (result) {
      case (#success(receipt)) {
        settlementTickets := Array.map<T.Ticket, T.Ticket>(settlementTickets, func(t) { if (t.id == ticketId) ({ id = t.id; action = t.action; createdAt = t.createdAt; policyError = t.policyError; status = #approved(receipt) }) else t });
        spend := Array.append(spend, [{ timestamp = Time.now(); amount = amountOf(ticket.action) }]); policy := P.recordSuccess(policy);
        let id = addAudit(ticket.action, tier, currentError, ?result, ?ticketId, "controller approved and settled");
        #ok({ tier; error = null; ticketId = ?ticketId; auditId = id; settlement = ?result })
      };
      case (#failure(e)) { policy := P.recordFailure(policy); ignore addAudit(ticket.action, tier, currentError, ?result, ?ticketId, "approval settlement failed"); #err(#ExternalFailure(e)) }
    }
  };
  public shared ({ caller }) func rejectTicket(ticketId : Nat, reason : Text) : async T.Result<Nat> {
    if (not controller(caller)) return #err(#Unauthorized); var found = false; var pendingTicket = false; var action : ?T.Action = null;
    for (ticket in settlementTickets.vals()) { if (ticket.id == ticketId) { found := true; pendingTicket := ticket.status == #pending; action := ?ticket.action } };
    if (not found) return #err(#TicketNotFound); if (not pendingTicket) return #err(#AlreadyResolved);
    settlementTickets := Array.map<T.Ticket, T.Ticket>(settlementTickets, func(t) { if (t.id == ticketId) ({ id = t.id; action = t.action; createdAt = t.createdAt; policyError = t.policyError; status = #rejected(reason) }) else t });
    let id = addAudit(switch (action) { case (?a) a; case (null) return #err(#TicketNotFound) }, #Escalation, null, null, ?ticketId, "controller rejected: " # reason); #ok(id)
  };
  public shared ({ caller }) func setApprovedAgents(agents : [Principal]) : async T.Result<()> { if (not controller(caller)) return #err(#Unauthorized); approvedAgents := agents; #ok(()) };
  public shared ({ caller }) func setDexConfig(next : T.DexConfig) : async T.Result<()> { if (not controller(caller)) return #err(#Unauthorized); if (next.feeTier == 0) return #err(#InvalidAmount); dexConfig := next; #ok(()) };
  public shared ({ caller }) func recoverSettlementLock() : async T.Result<()> {
    if (not controller(caller)) return #err(#Unauthorized);
    switch (settlementLock) {
      case null { settlementInFlight := false; #ok(()) };
      case (?lock) {
        if (Time.now() - lock.startedAt < 300_000_000_000) return #err(#SettlementLockNotStale);
        settlementInFlight := false; settlementLock := null;
        ignore addAudit(lock.action, #Forbidden, null, null, null, "controller recovered stale settlement lock"); #ok(())
      }
    }
  };
  public shared ({ caller }) func setPolicy(next : T.Policy) : async T.Result<()> { if (not controller(caller)) return #err(#Unauthorized); policy := next; #ok(()) };
  public shared ({ caller }) func setCircuitBreaker(active : Bool) : async T.Result<()> { if (not controller(caller)) return #err(#Unauthorized); policy := { policy with circuitBreaker = active }; #ok(()) };
}
