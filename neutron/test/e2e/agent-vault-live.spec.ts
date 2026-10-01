import { expect, test } from "@playwright/test";
import { Actor, HttpAgent, type Identity } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { readFileSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createLocalFixtureClient,
  LOCAL_LEDGER_FIXTURES,
  localFixtureMinterIdentity,
  resolveLocalFixtureArtifacts,
  type LocalFixtureAccount,
  type LocalLedgerFixture,
} from "../../packages/neutron-provision/src/local_fixtures.ts";
import { localIdentityFromSeed } from "../../packages/neutron-provision/src/kernel.ts";
import { resolveLocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";

const execFileAsync = promisify(execFile);

async function reinstallLiveRuntime(): Promise<void> {
  await execFileAsync("bun", ["packages/neutron-provision/src/index.ts", "agent-vault-live.ndeploy.json", "reinstall"], { cwd: path.resolve(process.cwd()) });
}

test("Agent Vault settles an approved transfer from the isolated subaccount", async ({ page }) => {
  await reinstallLiveRuntime();
  const runtime = resolveLocalNeutronRuntime({ configPath: "agent-vault-live.ndeploy.json" });
  const fixture = requiredFixture("ckusdc");
  const rootKeyBase64 = readRuntimeRootKey(runtime.sessionPath);
  const minterClient = await createLocalFixtureClient({
    gatewayUrl: runtime.gatewayUrl,
    expectedRootKeyBase64: rootKeyBase64,
    identity: localFixtureMinterIdentity(),
  });
  await minterClient.ensureManagedLedgerPair(
    fixture,
    await resolveLocalFixtureArtifacts({
      cacheDirectory: path.join(path.dirname(runtime.sessionPath), ".neutron", "cache", "fixtures"),
    }),
  );

  const vault = await createVaultActor(runtime.gatewayUrl, rootKeyBase64, runtime.canisterId);
  const initialState = unwrap(await vault.app_agent_vault__getVaultState(null));
  const vaultAccount: LocalFixtureAccount = {
    owner: initialState.depositAccount.owner,
    subaccount: [Uint8Array.from(initialState.depositAccount.subaccount)],
  };
  expect(vaultAccount.owner.toText()).toBe(runtime.canisterId);
  expect(vaultAccount.subaccount[0]).toHaveLength(32);
  expect(vaultAccount.subaccount[0]?.some((byte) => byte !== 0)).toBe(true);

  const recipient = localIdentityFromSeed(9).getPrincipal();
  const amount = 1_000_000n;
  const fee = await minterClient.feeOf(fixture);
  const requiredBalance = amount + fee;
  await minterClient.fundLedgerAccount(fixture, vaultAccount, requiredBalance);
  const vaultBefore = await minterClient.balanceOf(fixture, vaultAccount);
  const recipientAccount: LocalFixtureAccount = { owner: recipient, subaccount: [] };
  const recipientBefore = await minterClient.balanceOf(fixture, recipientAccount);
  const defaultAccount: LocalFixtureAccount = { owner: Principal.fromText(runtime.canisterId), subaccount: [] };
  const defaultBefore = await minterClient.balanceOf(fixture, defaultAccount);

  const proposed = unwrap(await vault.app_agent_vault__proposeTransfer([
    Principal.fromText(fixture.canisterId),
    recipient,
    amount,
    "PocketIC isolated-subaccount approval test",
  ]));
  expect(proposed.tier).toEqual({ Escalation: null });
  expect(proposed.ticketId).toHaveLength(1);

  await page.goto(`http://${runtime.canisterId}.localhost:8000/`);
  await expect(page.locator('[data-tid="login-button"]')).toBeVisible();
  await page.evaluate(async (seed) => {
    const login = (window as typeof window & { __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: (value: number) => Promise<string> }).__NEUTRON_PLAYWRIGHT_LOGIN_AS__;
    if (!login) throw new Error("Local Playwright login is unavailable");
    await login(seed);
  }, runtime.developerIdentitySeed);
  await page.locator('[data-tid="launcher-open"]').click();
  await page.locator('[data-tid="launcher-tile-agent_vault-dashboard"]').click();
  const tile = page.frameLocator('iframe[data-app-id="agent_vault"][data-tile-id="dashboard"]');
  await expect(tile.locator(".workspace-stack")).toBeVisible();
  await tile.getByRole("button", { name: /Approvals \d+/, exact: true }).click();
  const ticket = tile.locator(".approval-item", { hasText: `#${proposed.ticketId[0]}` });
  await expect(ticket).toBeVisible();
  await tile.getByRole("button", { name: "Approve & settle" }).click();
  await expect(ticket).toHaveCount(0);

  await expect.poll(() => minterClient.balanceOf(fixture, vaultAccount)).toBe(vaultBefore - requiredBalance);
  await expect.poll(() => minterClient.balanceOf(fixture, recipientAccount)).toBe(recipientBefore + amount);
  await expect.poll(() => minterClient.balanceOf(fixture, defaultAccount)).toBe(defaultBefore);
});

test("Agent Vault enforces the complete transfer policy lifecycle on a real local ledger", async () => {
  await reinstallLiveRuntime();
  const runtime = resolveLocalNeutronRuntime({ configPath: "agent-vault-live.ndeploy.json" });
  const fixture = requiredFixture("ckusdc");
  const rootKeyBase64 = readRuntimeRootKey(runtime.sessionPath);
  const minterClient = await createLocalFixtureClient({
    gatewayUrl: runtime.gatewayUrl,
    expectedRootKeyBase64: rootKeyBase64,
    identity: localFixtureMinterIdentity(),
  });
  await minterClient.ensureManagedLedgerPair(
    fixture,
    await resolveLocalFixtureArtifacts({
      cacheDirectory: path.join(path.dirname(runtime.sessionPath), ".neutron", "cache", "fixtures"),
    }),
  );

  const owner = await createVaultActor(runtime.gatewayUrl, rootKeyBase64, runtime.canisterId, localIdentityFromSeed(2));
  // The minimal deployment authorizes the configured developer principals only;
  // this identity intentionally exercises the same authorized owner surface.
  const agent = owner;
  const state = unwrap(await owner.app_agent_vault__getVaultState(null));
  expect(state.balances).toEqual([]);
  expect(state.pending).toEqual([]);
  expect(state.audit).toEqual([]);
  expect(state.settlementInFlight).toBe(false);
  expect(state.settlementLock).toEqual([]);
  expect(state.policies).toHaveLength(1);
  expect(state.activePolicyId).toBe(0n);
  const profilePolicy: Policy = {
    limits: [],
    allowlists: { recipients: [], dexes: [], pairs: [] },
    circuitBreaker: false,
    failureThreshold: 3n,
    consecutiveFailures: 0n,
  };
  const profileId = unwrap(await owner.app_agent_vault__createPolicyProfile(["Approval Review", profilePolicy]));
  unwrap(await owner.app_agent_vault__setActivePolicyProfile(profileId));
  const profileState = unwrap(await owner.app_agent_vault__getVaultState(null));
  expect(profileState.activePolicyId).toBe(profileId);
  const profileProposal = unwrap(await owner.app_agent_vault__proposeSwap([
    Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai"),
    Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai"),
    Principal.fromText("4mmnk-kiaaa-aaaag-qbllq-cai"),
    1n,
    1n,
    100n,
    BigInt(Date.now()) * 1_000_000n + 60_000_000_000n,
    "profile revision binding test",
  ]));
  const profileTicketId = only(profileProposal.ticketId);
  const profilePending = unwrap(await owner.app_agent_vault__getVaultState(null));
  const profileTicket = profilePending.pending.find((candidate) => candidate.id === profileTicketId);
  expect(profileTicket?.evaluation[0]?.profileId).toBe(profileId);
  unwrap(await owner.app_agent_vault__updatePolicyProfile([profileId, "Approval Review v2", profilePolicy]));
  await expectVaultError(owner.app_agent_vault__approveTicket(profileTicketId), "PolicyRevisionChanged");
  unwrap(await owner.app_agent_vault__rejectTicket([profileTicketId, "Revision changed; proposal must be resubmitted"]));
  unwrap(await owner.app_agent_vault__setActivePolicyProfile(0n));

  const vaultAccount: LocalFixtureAccount = {
    owner: state.depositAccount.owner,
    subaccount: [Uint8Array.from(state.depositAccount.subaccount)],
  };
  const defaultAccount: LocalFixtureAccount = {
    owner: Principal.fromText(runtime.canisterId),
    subaccount: [],
  };
  const recipient = localIdentityFromSeed(9).getPrincipal();
  const secondRecipient = localIdentityFromSeed(10).getPrincipal();
  const recipientAccount: LocalFixtureAccount = { owner: recipient, subaccount: [] };
  const secondRecipientAccount: LocalFixtureAccount = { owner: secondRecipient, subaccount: [] };
  const fee = await minterClient.feeOf(fixture);
  const autonomousAmount = 1_000_000n;
  const approvedAmount = 2_000_000n;
  const fundingTarget = autonomousAmount + approvedAmount + fee * 4n;
  await minterClient.fundLedgerAccount(fixture, vaultAccount, fundingTarget);

  const synced = unwrap(await agent.app_agent_vault__syncBalance(Principal.fromText(fixture.canisterId)));
  expect(synced.token.symbol).toBe(fixture.symbol);
  expect(synced.token.decimals).toBe(fixture.decimals);
  expect(synced.token.fee).toBe(fee);
  expect(synced.amount).toBe(await minterClient.balanceOf(fixture, vaultAccount));

  const maxPerTx = autonomousAmount + fee;
  unwrap(await owner.app_agent_vault__setPolicy({
    limits: [{ token: Principal.fromText(fixture.canisterId), limits: { maxPerTx, maxHourlySpend: maxPerTx, maxDailySpend: maxPerTx } }],
    allowlists: { recipients: [recipient], dexes: [], pairs: [] },
    circuitBreaker: false,
    failureThreshold: 3n,
    consecutiveFailures: 0n,
  }));

  const vaultBeforeAutonomous = await minterClient.balanceOf(fixture, vaultAccount);
  const recipientBeforeAutonomous = await minterClient.balanceOf(fixture, recipientAccount);
  const defaultBeforeAutonomous = await minterClient.balanceOf(fixture, defaultAccount);
  const autonomous = unwrap(await agent.app_agent_vault__proposeTransfer([
    Principal.fromText(fixture.canisterId), recipient, autonomousAmount, "PocketIC autonomous boundary test",
  ]));
  expect(autonomous.tier).toEqual({ Autonomous: null });
  expect(autonomous.error).toEqual([]);
  expect(autonomous.ticketId).toEqual([]);
  expect(autonomous.settlement).toHaveLength(1);
  expect(await minterClient.balanceOf(fixture, vaultAccount)).toBe(vaultBeforeAutonomous - autonomousAmount - fee);
  expect(await minterClient.balanceOf(fixture, recipientAccount)).toBe(recipientBeforeAutonomous + autonomousAmount);
  expect(await minterClient.balanceOf(fixture, defaultAccount)).toBe(defaultBeforeAutonomous);

  const overWindow = unwrap(await agent.app_agent_vault__proposeTransfer([
    Principal.fromText(fixture.canisterId), recipient, 1n, "PocketIC fee-inclusive hourly limit test",
  ]));
  expect(overWindow.tier).toEqual({ Escalation: null });
  expect(overWindow.error).toEqual([{ HourlyLimit: null }]);
  const rejectTicketId = only(overWindow.ticketId);
  unwrap(await owner.app_agent_vault__rejectTicket([rejectTicketId, "Owner rejected limit breach"]));
  await expectVaultError(owner.app_agent_vault__rejectTicket([rejectTicketId, "Cannot reject twice"]), "AlreadyResolved");

  const notAllowed = unwrap(await agent.app_agent_vault__proposeTransfer([
    Principal.fromText(fixture.canisterId), secondRecipient, approvedAmount, "PocketIC owner approval test",
  ]));
  expect(notAllowed.tier).toEqual({ Escalation: null });
  expect(notAllowed.error).toEqual([{ RecipientNotAllowed: null }]);
  const approvalTicketId = only(notAllowed.ticketId);

  unwrap(await owner.app_agent_vault__setCircuitBreaker(true));
  await expectVaultError(owner.app_agent_vault__approveTicket(approvalTicketId), "PolicyRevisionChanged");
  const breakerBlocked = unwrap(await agent.app_agent_vault__proposeTransfer([
    Principal.fromText(fixture.canisterId), recipient, 1n, "PocketIC circuit breaker test",
  ]));
  expect(breakerBlocked.tier).toEqual({ Forbidden: null });
  expect(breakerBlocked.error).toEqual([{ CircuitBreakerActive: null }]);
  unwrap(await owner.app_agent_vault__setCircuitBreaker(false));
  const freshApproval = unwrap(await agent.app_agent_vault__proposeTransfer([
    Principal.fromText(fixture.canisterId), secondRecipient, approvedAmount, "PocketIC owner approval test after breaker reset",
  ]));
  expect(freshApproval.error).toEqual([{ RecipientNotAllowed: null }]);
  const freshApprovalTicketId = only(freshApproval.ticketId);

  const vaultBeforeApproval = await minterClient.balanceOf(fixture, vaultAccount);
  const secondBeforeApproval = await minterClient.balanceOf(fixture, secondRecipientAccount);
  const approved = unwrap(await owner.app_agent_vault__approveTicket(freshApprovalTicketId));
  expect(approved.tier).toEqual({ Escalation: null });
  expect(approved.error).toEqual([]);
  expect(await minterClient.balanceOf(fixture, vaultAccount)).toBe(vaultBeforeApproval - approvedAmount - fee);
  expect(await minterClient.balanceOf(fixture, secondRecipientAccount)).toBe(secondBeforeApproval + approvedAmount);
  await expectVaultError(owner.app_agent_vault__approveTicket(freshApprovalTicketId), "AlreadyResolved");
  unwrap(await owner.app_agent_vault__rejectTicket([approvalTicketId, "Superseded after profile revision changed"]));

  const zero = unwrap(await agent.app_agent_vault__proposeTransfer([
    Principal.fromText(fixture.canisterId), recipient, 0n, "PocketIC zero amount test",
  ]));
  expect(zero.tier).toEqual({ Forbidden: null });
  expect(zero.error).toEqual([{ InvalidAmount: null }]);

  await expectVaultError(owner.app_agent_vault__setPolicy({
    limits: [{ token: Principal.fromText(fixture.canisterId), limits: { maxPerTx: 0n, maxHourlySpend: 1n, maxDailySpend: 1n } }],
    allowlists: { recipients: [], dexes: [], pairs: [] },
    circuitBreaker: false,
    failureThreshold: 0n,
    consecutiveFailures: 0n,
  }), "InvalidPolicy");

  const swap = unwrap(await owner.app_agent_vault__proposeSwap([
    Principal.fromText(fixture.canisterId),
    Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai"),
    Principal.fromText("4mmnk-kiaaa-aaaag-qbllq-cai"),
    1n,
    1n,
    100n,
    BigInt(Date.now()) * 1_000_000n + 60_000_000_000n,
    "PocketIC swap escalation policy test",
  ]));
  expect(swap.tier).toEqual({ Escalation: null });
  expect(swap.error).toEqual([{ SwapRequiresApproval: null }]);
  unwrap(await owner.app_agent_vault__rejectTicket([only(swap.ticketId), "No local ICPSwap pool graph in the minimal runtime"]));

  const finalState = unwrap(await owner.app_agent_vault__getVaultState(null));
  expect(finalState.pending).toEqual([]);
  expect(finalState.settlementInFlight).toBe(false);
  expect(finalState.settlementLock).toEqual([]);
  expect(await minterClient.balanceOf(fixture, defaultAccount)).toBe(0n);
  expect(finalState.audit.length).toBeGreaterThanOrEqual(8);
  expect(new Set(finalState.audit.map(({ id }) => id.toString())).size).toBe(finalState.audit.length);
});

test("Agent Vault rejects deleting the active policy profile and syncs all balances", async () => {
  await reinstallLiveRuntime();
  const runtime = resolveLocalNeutronRuntime({ configPath: "agent-vault-live.ndeploy.json" });
  const fixture = requiredFixture("ckusdc");
  const rootKeyBase64 = readRuntimeRootKey(runtime.sessionPath);
  const minterClient = await createLocalFixtureClient({
    gatewayUrl: runtime.gatewayUrl,
    expectedRootKeyBase64: rootKeyBase64,
    identity: localFixtureMinterIdentity(),
  });
  await minterClient.ensureManagedLedgerPair(
    fixture,
    await resolveLocalFixtureArtifacts({
      cacheDirectory: path.join(path.dirname(runtime.sessionPath), ".neutron", "cache", "fixtures"),
    }),
  );

  const owner = await createVaultActor(runtime.gatewayUrl, rootKeyBase64, runtime.canisterId, localIdentityFromSeed(2));
  const vaultAccount: LocalFixtureAccount = {
    owner: (unwrap(await owner.app_agent_vault__getVaultState(null))).depositAccount.owner,
    subaccount: [Uint8Array.from((unwrap(await owner.app_agent_vault__getVaultState(null))).depositAccount.subaccount)],
  };
  const fee = await minterClient.feeOf(fixture);
  await minterClient.fundLedgerAccount(fixture, vaultAccount, fee * 2n);

  unwrap(await owner.app_agent_vault__syncBalance(Principal.fromText(fixture.canisterId)));
  const allBalances = unwrap(await owner.app_agent_vault__syncAllBalances(null));
  expect(allBalances.length).toBeGreaterThan(0);
  expect(allBalances[0].ok).toBeDefined();

  const activeId = unwrap(await owner.app_agent_vault__getVaultState(null)).activePolicyId;
  await expectVaultError(owner.app_agent_vault__deletePolicyProfile(activeId), "ActivePolicyDeletion");

  const newProfileId = unwrap(await owner.app_agent_vault__createPolicyProfile(["Temp Profile", {
    limits: [],
    allowlists: { recipients: [], dexes: [], pairs: [] },
    circuitBreaker: false,
    failureThreshold: 3n,
    consecutiveFailures: 0n,
  }]));
  unwrap(await owner.app_agent_vault__deletePolicyProfile(newProfileId));
  const finalState = unwrap(await owner.app_agent_vault__getVaultState(null));
  expect(finalState.policies.find((p) => p.id === newProfileId)).toBeUndefined();
});

test("Agent Vault blocks concurrent proposals when a settlement is in flight", async () => {
  await reinstallLiveRuntime();
  const runtime = resolveLocalNeutronRuntime({ configPath: "agent-vault-live.ndeploy.json" });
  const fixture = requiredFixture("ckusdc");
  const rootKeyBase64 = readRuntimeRootKey(runtime.sessionPath);
  const minterClient = await createLocalFixtureClient({
    gatewayUrl: runtime.gatewayUrl,
    expectedRootKeyBase64: rootKeyBase64,
    identity: localFixtureMinterIdentity(),
  });
  await minterClient.ensureManagedLedgerPair(
    fixture,
    await resolveLocalFixtureArtifacts({
      cacheDirectory: path.join(path.dirname(runtime.sessionPath), ".neutron", "cache", "fixtures"),
    }),
  );

  const owner = await createVaultActor(runtime.gatewayUrl, rootKeyBase64, runtime.canisterId, localIdentityFromSeed(2));
  const state = unwrap(await owner.app_agent_vault__getVaultState(null));
  const vaultAccount: LocalFixtureAccount = {
    owner: state.depositAccount.owner,
    subaccount: [Uint8Array.from(state.depositAccount.subaccount)],
  };
  const fee = await minterClient.feeOf(fixture);
  const recipient = localIdentityFromSeed(9).getPrincipal();
  await minterClient.fundLedgerAccount(fixture, vaultAccount, fee * 3n);

  unwrap(await owner.app_agent_vault__setPolicy({
    limits: [{ token: Principal.fromText(fixture.canisterId), limits: { maxPerTx: 1n, maxHourlySpend: 100n, maxDailySpend: 100n } }],
    allowlists: { recipients: [recipient], dexes: [], pairs: [] },
    circuitBreaker: false,
    failureThreshold: 3n,
    consecutiveFailures: 0n,
  }));

  const first = unwrap(await owner.app_agent_vault__proposeTransfer([
    Principal.fromText(fixture.canisterId), recipient, 1n, "first proposal",
  ]));
  expect(first.tier).toEqual({ Autonomous: null });
  expect(first.settlement).toHaveLength(1);

  const second = unwrap(await owner.app_agent_vault__proposeTransfer([
    Principal.fromText(fixture.canisterId), recipient, 1n, "second proposal during settlement",
  ]));
  expect(second.error).toHaveLength(1);
  expect(second.error[0]).toHaveProperty("SettlementInFlight");
  expect(second.tier).toEqual({ Forbidden: null });

  const lockedState = unwrap(await owner.app_agent_vault__getVaultState(null));
  expect(lockedState.settlementLock).toHaveLength(0);
});

function requiredFixture(key: string): LocalLedgerFixture {
  const fixture = LOCAL_LEDGER_FIXTURES.find((candidate) => candidate.key === key);
  if (!fixture) throw new Error(`Missing canonical local ledger fixture: ${key}`);
  return fixture;
}

function readRuntimeRootKey(sessionPath: string): string {
  const session = JSON.parse(readFileSync(sessionPath, "utf8")) as { runtime?: { kind?: string; rootKeyBase64?: string } };
  if (session.runtime?.kind !== "pocketic" || !session.runtime.rootKeyBase64) throw new Error("Live PocketIC session has no verified root key");
  return session.runtime.rootKeyBase64;
}

async function createVaultActor(gatewayUrl: string, rootKeyBase64: string, canisterId: string, identity: Identity = localIdentityFromSeed(2)): Promise<VaultActor> {
  const agent = await HttpAgent.create({ host: gatewayUrl, identity, verifyQuerySignatures: false });
  const rootKey = await agent.fetchRootKey();
  expect(Buffer.from(rootKey).toString("base64")).toBe(rootKeyBase64);
  return Actor.createActor<VaultActor>(vaultIdl, { agent, canisterId: Principal.fromText(canisterId) });
}

function only<T>(value: [] | [T]): T {
  if (value.length !== 1) throw new Error("Expected one optional value");
  return value[0];
}

async function expectVaultError(result: Promise<{ ok: unknown } | { err: unknown }>, tag: string): Promise<void> {
  const value = await result;
  if (!("err" in value)) throw new Error(`Expected ${tag}, received success`);
  expect(value.err).toHaveProperty(tag);
}

function unwrap<T extends { ok: unknown } | { err: unknown }>(result: T): T extends { ok: infer Value } ? Value : never {
  if ("err" in result) throw new Error(`Agent Vault call failed: ${JSON.stringify(result.err)}`);
  return result.ok as T extends { ok: infer Value } ? Value : never;
}

type VaultActor = {
  app_agent_vault__getVaultState: (request: null) => Promise<VaultStateResult>;
  app_agent_vault__proposeTransfer: (request: [Principal, Principal, bigint, string]) => Promise<OutcomeResult>;
  app_agent_vault__proposeSwap: (request: [Principal, Principal, Principal, bigint, bigint, bigint, bigint, string]) => Promise<OutcomeResult>;
  app_agent_vault__syncBalance: (request: Principal) => Promise<BalanceResult>;
  app_agent_vault__syncAllBalances: (request: null) => Promise<ArrayResult<BalanceResult>>;
  app_agent_vault__approveTicket: (request: bigint) => Promise<OutcomeResult>;
  app_agent_vault__rejectTicket: (request: [bigint, string]) => Promise<IdResult>;
  app_agent_vault__setPolicy: (request: Policy) => Promise<UnitResult>;
  app_agent_vault__setCircuitBreaker: (request: boolean) => Promise<UnitResult>;
  app_agent_vault__createPolicyProfile: (request: [string, Policy]) => Promise<IdResult>;
  app_agent_vault__updatePolicyProfile: (request: [bigint, string, Policy]) => Promise<UnitResult>;
  app_agent_vault__setActivePolicyProfile: (request: bigint) => Promise<UnitResult>;
  app_agent_vault__deletePolicyProfile: (request: bigint) => Promise<UnitResult>;
};
type VaultStateResult = { ok: VaultState } | { err: unknown };
type OutcomeResult = { ok: Outcome } | { err: unknown };
type BalanceResult = { ok: Balance } | { err: VaultError };
type IdResult = { ok: bigint } | { err: VaultError };
type ArrayResult<T> = { ok: T[] } | { err: VaultError };
type UnitResult = { ok: null } | { err: VaultError };
type VaultState = {
  balances: Balance[];
  policies: Array<{ id: bigint; name: string; revision: bigint; policy: Policy }>;
  activePolicyId: bigint;
  pending: Array<{ id: bigint; evaluation: [] | [{ profileId: bigint; profileName: string; revision: bigint }] }>;
  audit: Array<{ id: bigint }>;
  settlementInFlight: boolean;
  settlementLock: [] | [{ profile: [] | [{ id: bigint; name: string; revision: bigint }] }];
  depositAccount: { owner: Principal; subaccount: number[] };
};
type Balance = { token: { symbol: string; decimals: number; fee: bigint }; amount: bigint };
type Outcome = { tier: unknown; error: [] | [VaultError]; ticketId: [] | [bigint]; settlement: [] | [unknown] };
type Policy = {
  limits: Array<{ token: Principal; limits: { maxPerTx: bigint; maxHourlySpend: bigint; maxDailySpend: bigint } }>;
  allowlists: { recipients: Principal[]; dexes: Principal[]; pairs: Array<{ from: Principal; to: Principal }> };
  circuitBreaker: boolean;
  failureThreshold: bigint;
  consecutiveFailures: bigint;
};
type VaultError = Record<string, unknown>;

const vaultIdl = ({ IDL: idl }: { IDL: any }) => {
  const externalError = idl.Record({ code: idl.Text, message: idl.Text, partial: idl.Bool });
  const vaultError = idl.Variant({ ActivePolicyDeletion: idl.Null, AlreadyResolved: idl.Null, CircuitBreakerActive: idl.Null, DailyLimit: idl.Null, DexNotAllowed: idl.Null, ExternalFailure: externalError, HourlyLimit: idl.Null, InsufficientBalance: idl.Null, InvalidAmount: idl.Null, InvalidPolicy: idl.Null, InvalidPolicyName: idl.Null, InvalidQuote: idl.Null, InvalidSlippage: idl.Null, OutsideAllowedHours: idl.Null, PerTransactionLimit: idl.Null, PolicyProfileNotActive: idl.Null, PolicyProfileNotFound: idl.Null, PolicyRevisionChanged: idl.Null, QuoteExpired: idl.Null, RecipientNotAllowed: idl.Null, SettlementInFlight: idl.Null, SettlementLockNotStale: idl.Null, SwapRequiresApproval: idl.Null, TicketNotFound: idl.Null, TimelockInProgress: idl.Null, TokenLimitNotConfigured: idl.Null, TokenPairNotAllowed: idl.Null, TooManyPendingTickets: idl.Null, UnsupportedTokenStandard: idl.Null });
  const token = idl.Record({ id: idl.Principal, symbol: idl.Text, decimals: idl.Nat8, standard: idl.Text, fee: idl.Nat });
  const balance = idl.Record({ token, amount: idl.Nat, syncedAt: idl.Int });
  const tokenSpend = idl.Record({ token: idl.Principal, hourly: idl.Nat, daily: idl.Nat });
  const tokenPair = idl.Record({ from: idl.Principal, to: idl.Principal });
  const tokenLimits = idl.Record({ maxPerTx: idl.Nat, maxHourlySpend: idl.Nat, maxDailySpend: idl.Nat });
  const tokenLimit = idl.Record({ token: idl.Principal, limits: tokenLimits });
  const timeWindow = idl.Record({ start: idl.Nat, end: idl.Nat, days: idl.Vec(idl.Nat) });
  const allowlists = idl.Record({ recipients: idl.Vec(idl.Principal), dexes: idl.Vec(idl.Principal), pairs: idl.Vec(tokenPair), tokenRecipients: idl.Vec(idl.Tuple(idl.Principal, idl.Vec(idl.Principal))) });
  const policy = idl.Record({ limits: idl.Vec(tokenLimit), allowlists, circuitBreaker: idl.Bool, failureThreshold: idl.Nat, consecutiveFailures: idl.Nat, allowedHours: idl.Vec(idl.Tuple(idl.Principal, timeWindow)), approvalTimelock: idl.Nat });
  const transferProposal = idl.Record({ token: idl.Principal, recipient: idl.Principal, amount: idl.Nat, reason: idl.Text });
  const swapProposal = idl.Record({ fromToken: idl.Principal, toToken: idl.Principal, dex: idl.Principal, amount: idl.Nat, minReturn: idl.Nat, slippageBps: idl.Nat, quoteExpiresAt: idl.Int, reason: idl.Text });
  const action = idl.Variant({ transfer: transferProposal, swap: swapProposal });
  const tier = idl.Variant({ Autonomous: idl.Null, Escalation: idl.Null, Forbidden: idl.Null });
  const receipt = idl.Variant({ transfer: idl.Record({ token: idl.Principal, blockIndex: idl.Nat, fee: idl.Nat }), swap: idl.Record({ dex: idl.Principal, pool: idl.Principal, transactionId: idl.Opt(idl.Nat), approvalBlockIndex: idl.Nat, amountOut: idl.Nat, fee: idl.Nat }) });
  const settlement = idl.Variant({ success: receipt, failure: externalError });
  const profile = idl.Record({ id: idl.Nat, name: idl.Text, revision: idl.Nat, policy });
  const evaluation = idl.Record({ profileId: idl.Nat, profileName: idl.Text, revision: idl.Nat, fee: idl.Opt(idl.Nat), hourlyBefore: idl.Opt(idl.Nat), dailyBefore: idl.Opt(idl.Nat), hourlyAfter: idl.Opt(idl.Nat), dailyAfter: idl.Opt(idl.Nat), tier, policyError: idl.Opt(vaultError) });
  const outcome = idl.Record({ tier, error: idl.Opt(vaultError), ticketId: idl.Opt(idl.Nat), auditId: idl.Nat, settlement: idl.Opt(settlement) });
  const ticket = idl.Record({ id: idl.Nat, action, createdAt: idl.Int, policyError: idl.Opt(vaultError), evaluation: idl.Opt(evaluation), status: idl.Variant({ pending: idl.Null, approved: receipt, rejected: idl.Text }), timelockUntil: idl.Opt(idl.Int) });
  const audit = idl.Record({ id: idl.Nat, action, tier, policyError: idl.Opt(vaultError), evaluation: idl.Opt(evaluation), settlement: idl.Opt(settlement), timestamp: idl.Int, ticketId: idl.Opt(idl.Nat), note: idl.Text });
  const settlementLock = idl.Record({ action, startedAt: idl.Int, profile: idl.Opt(idl.Record({ id: idl.Nat, name: idl.Text, revision: idl.Nat })) });
  const depositAccount = idl.Record({ owner: idl.Principal, subaccount: idl.Vec(idl.Nat8) });
  const vaultState = idl.Record({ balances: idl.Vec(balance), policies: idl.Vec(profile), activePolicyId: idl.Nat, policy, spend: idl.Vec(tokenSpend), pending: idl.Vec(ticket), audit: idl.Vec(audit), settlementInFlight: idl.Bool, settlementLock: idl.Opt(settlementLock), dexConfig: idl.Record({ factory: idl.Principal, feeTier: idl.Nat }), depositAccount, recipientLabels: idl.Vec(idl.Tuple(idl.Principal, idl.Text)) });
  return idl.Service({
    app_agent_vault__getVaultState: idl.Func([idl.Null], [idl.Variant({ ok: vaultState, err: vaultError })], ["query"]),
    app_agent_vault__proposeTransfer: idl.Func([idl.Tuple(idl.Principal, idl.Principal, idl.Nat, idl.Text)], [idl.Variant({ ok: outcome, err: vaultError })], []),
    app_agent_vault__proposeSwap: idl.Func([idl.Tuple(idl.Principal, idl.Principal, idl.Principal, idl.Nat, idl.Nat, idl.Nat, idl.Int, idl.Text)], [idl.Variant({ ok: outcome, err: vaultError })], []),
    app_agent_vault__syncBalance: idl.Func([idl.Principal], [idl.Variant({ ok: balance, err: vaultError })], []),
    app_agent_vault__syncAllBalances: idl.Func([idl.Null], [idl.Variant({ ok: idl.Vec(idl.Variant({ ok: balance, err: vaultError })), err: vaultError })], []),
    app_agent_vault__approveTicket: idl.Func([idl.Nat], [idl.Variant({ ok: outcome, err: vaultError })], []),
    app_agent_vault__rejectTicket: idl.Func([idl.Tuple(idl.Nat, idl.Text)], [idl.Variant({ ok: idl.Nat, err: vaultError })], []),
    app_agent_vault__setPolicy: idl.Func([policy], [idl.Variant({ ok: idl.Null, err: vaultError })], []),
    app_agent_vault__setCircuitBreaker: idl.Func([idl.Bool], [idl.Variant({ ok: idl.Null, err: vaultError })], []),
    app_agent_vault__setRecipientLabels: idl.Func([idl.Vec(idl.Tuple(idl.Principal, idl.Text))], [idl.Variant({ ok: idl.Null, err: vaultError })], []),
    app_agent_vault__createPolicyProfile: idl.Func([idl.Tuple(idl.Text, policy)], [idl.Variant({ ok: idl.Nat, err: vaultError })], []),
    app_agent_vault__updatePolicyProfile: idl.Func([idl.Tuple(idl.Nat, idl.Text, policy)], [idl.Variant({ ok: idl.Null, err: vaultError })], []),
    app_agent_vault__setActivePolicyProfile: idl.Func([idl.Nat], [idl.Variant({ ok: idl.Null, err: vaultError })], []),
    app_agent_vault__deletePolicyProfile: idl.Func([idl.Nat], [idl.Variant({ ok: idl.Null, err: vaultError })], []),
  });
};
