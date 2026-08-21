import Principal "mo:base/Principal";
import Array "mo:base/Array";
import Auth "../src/Authorization";
import Engine "../src/Engine";
import Policy "../src/Policy";
import T "../src/Types";

let owner = Principal.fromText("aaaaa-aa");
let recipient = Principal.fromText("2vxsx-fae");
let tokenA = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let tokenB = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
let dex = Principal.fromText("r7inp-6aaaa-aaaaa-aaabq-cai");

func policy(breaker : Bool) : T.Policy {
  {
    limits = { maxPerTx = 100; maxHourlySpend = 300; maxDailySpend = 500 };
    allowlists = {
      recipients = [recipient];
      dexes = [dex];
      pairs = [{ from = tokenA; to = tokenB }];
    };
    circuitBreaker = breaker;
    failureThreshold = 3;
    consecutiveFailures = 0;
  }
};

func transfer(amount : Nat, to : Principal) : T.Action {
  #transfer({ token = tokenA; recipient = to; amount; reason = "test transfer" })
};

func swap(from : Principal, to : Principal, onDex : Principal, amount : Nat) : T.Action {
  #swap({ fromToken = from; toToken = to; dex = onDex; amount; minReturn = 1; slippageBps = 50; quoteExpiresAt = 200_000_000_000_000; reason = "test swap" })
};

func expect(action : T.Action, hourly : Nat, daily : Nat, expectedTier : T.Tier, expectedError : ?T.VaultError) {
  let (tier, error) = Policy.classify(action, policy(false), hourly, daily);
  assert (tier == expectedTier);
  assert (error == expectedError);
};

// Exact caps remain autonomous; only values above a cap escalate.
expect(transfer(100, recipient), 0, 0, #Autonomous, null);
expect(transfer(100, recipient), 200, 0, #Autonomous, null);
expect(transfer(100, recipient), 0, 400, #Autonomous, null);
expect(transfer(101, recipient), 0, 0, #Escalation, ?#PerTransactionLimit);
expect(transfer(100, recipient), 201, 0, #Escalation, ?#HourlyLimit);
expect(transfer(100, recipient), 0, 401, #Escalation, ?#DailyLimit);

expect(transfer(1, owner), 0, 0, #Escalation, ?#RecipientNotAllowed);
expect(swap(tokenA, tokenB, dex, 1), 0, 0, #Autonomous, null);
expect(swap(tokenA, tokenB, owner, 1), 0, 0, #Escalation, ?#DexNotAllowed);
expect(swap(tokenB, tokenA, dex, 1), 0, 0, #Escalation, ?#TokenPairNotAllowed);
expect(transfer(0, recipient), 0, 0, #Forbidden, ?#InvalidAmount);

let (breakerTier, breakerError) = Policy.classify(transfer(1, recipient), policy(true), 0, 0);
assert (breakerTier == #Forbidden);
assert (breakerError == ?#CircuitBreakerActive);

let afterOneFailure = Policy.recordFailure(policy(false));
let afterTwoFailures = Policy.recordFailure(afterOneFailure);
let afterThreeFailures = Policy.recordFailure(afterTwoFailures);
assert (not afterOneFailure.circuitBreaker);
assert (not afterTwoFailures.circuitBreaker);
assert (afterThreeFailures.circuitBreaker);
assert (Policy.recordSuccess(afterTwoFailures).consecutiveFailures == 0);

let hour : Int = 3_600_000_000_000;
let now : Int = 100_000_000_000_000;
let spend : [T.Spend] = [
  { timestamp = now - hour; amount = 10 },
  { timestamp = now - hour - 1; amount = 20 },
  { timestamp = now + 1; amount = 40 },
  { timestamp = now; amount = 30 },
];
assert (Policy.spendIn(spend, now, hour) == 40);

let empty : Engine.State = { spend = []; tickets = []; audit = []; nextId = 0 };
let autonomous = Engine.apply(empty, transfer(50, recipient), policy(false), now);
assert (autonomous.outcome.tier == #Autonomous);
assert (Array.size(autonomous.state.spend) == 0);
assert (Array.size(autonomous.state.audit) == 1);
assert (Array.size(autonomous.state.tickets) == 0);

let escalated = Engine.apply(autonomous.state, transfer(101, recipient), policy(false), now);
assert (escalated.outcome.tier == #Escalation);
assert (escalated.outcome.ticketId == ?2);
assert (Array.size(escalated.state.tickets) == 1);
assert (Array.size(escalated.state.audit) == 2);
assert (Array.size(escalated.state.spend) == 0);
assert (escalated.state.tickets[0].status == #pending);

let forbidden = Engine.apply(escalated.state, transfer(1, recipient), policy(true), now);
assert (forbidden.outcome.tier == #Forbidden);
assert (Array.size(forbidden.state.tickets) == 1);
assert (Array.size(forbidden.state.audit) == 3);

assert (Auth.isController(owner, owner));
assert (not Auth.isController(recipient, owner));
assert (Auth.isAgent(owner, owner, []));
assert (Auth.isAgent(recipient, owner, [recipient]));
assert (not Auth.isAgent(tokenA, owner, [recipient]));
