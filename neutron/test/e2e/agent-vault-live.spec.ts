import { expect, test } from "@playwright/test";
import { Actor, HttpAgent } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { readFileSync } from "node:fs";
import path from "node:path";
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

test("Agent Vault settles an approved transfer from the isolated subaccount", async ({ page }) => {
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
  await expect(tile.locator(".vault-shell")).toBeVisible();
  await tile.getByRole("button", { name: "Approvals" }).click();
  const ticket = tile.locator(".vault-ticket", { hasText: `Ticket #${proposed.ticketId[0]}` });
  await expect(ticket).toBeVisible();
  await ticket.getByRole("button", { name: "✓ Approve" }).click();
  await expect(ticket).toHaveCount(0);

  await expect.poll(() => minterClient.balanceOf(fixture, vaultAccount)).toBe(vaultBefore - requiredBalance);
  await expect.poll(() => minterClient.balanceOf(fixture, recipientAccount)).toBe(recipientBefore + amount);
  await expect.poll(() => minterClient.balanceOf(fixture, defaultAccount)).toBe(defaultBefore);
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

async function createVaultActor(gatewayUrl: string, rootKeyBase64: string, canisterId: string): Promise<VaultActor> {
  const agent = await HttpAgent.create({ host: gatewayUrl, identity: localIdentityFromSeed(2), verifyQuerySignatures: false });
  const rootKey = await agent.fetchRootKey();
  expect(Buffer.from(rootKey).toString("base64")).toBe(rootKeyBase64);
  return Actor.createActor<VaultActor>(vaultIdl, { agent, canisterId: Principal.fromText(canisterId) });
}

function unwrap<T extends { ok: unknown } | { err: unknown }>(result: T): T extends { ok: infer Value } ? Value : never {
  if ("err" in result) throw new Error(`Agent Vault call failed: ${JSON.stringify(result.err)}`);
  return result.ok as T extends { ok: infer Value } ? Value : never;
}

type VaultActor = {
  app_agent_vault__getVaultState: (request: null) => Promise<VaultStateResult>;
  app_agent_vault__proposeTransfer: (request: [Principal, Principal, bigint, string]) => Promise<OutcomeResult>;
};
type VaultStateResult = { ok: VaultState } | { err: unknown };
type OutcomeResult = { ok: Outcome } | { err: unknown };
type VaultState = { depositAccount: { owner: Principal; subaccount: number[] } };
type Outcome = { tier: unknown; ticketId: [] | [bigint] };

const vaultIdl = ({ IDL: idl }: { IDL: any }) => {
  const externalError = idl.Record({ code: idl.Text, message: idl.Text, partial: idl.Bool });
  const vaultError = idl.Variant({ AlreadyResolved: idl.Null, CircuitBreakerActive: idl.Null, DailyLimit: idl.Null, DexNotAllowed: idl.Null, ExternalFailure: externalError, HourlyLimit: idl.Null, InsufficientBalance: idl.Null, InvalidAmount: idl.Null, InvalidPolicy: idl.Null, InvalidQuote: idl.Null, InvalidSlippage: idl.Null, PerTransactionLimit: idl.Null, QuoteExpired: idl.Null, RecipientNotAllowed: idl.Null, SettlementInFlight: idl.Null, SettlementLockNotStale: idl.Null, SwapRequiresApproval: idl.Null, TicketNotFound: idl.Null, TokenLimitNotConfigured: idl.Null, TokenPairNotAllowed: idl.Null, UnsupportedTokenStandard: idl.Null });
  const token = idl.Record({ id: idl.Principal, symbol: idl.Text, decimals: idl.Nat8, standard: idl.Text, fee: idl.Nat });
  const balance = idl.Record({ token, amount: idl.Nat, syncedAt: idl.Int });
  const tokenSpend = idl.Record({ token: idl.Principal, hourly: idl.Nat, daily: idl.Nat });
  const tokenPair = idl.Record({ from: idl.Principal, to: idl.Principal });
  const tokenLimits = idl.Record({ maxPerTx: idl.Nat, maxHourlySpend: idl.Nat, maxDailySpend: idl.Nat });
  const tokenLimit = idl.Record({ token: idl.Principal, limits: tokenLimits });
  const allowlists = idl.Record({ recipients: idl.Vec(idl.Principal), dexes: idl.Vec(idl.Principal), pairs: idl.Vec(tokenPair) });
  const policy = idl.Record({ limits: idl.Vec(tokenLimit), allowlists, circuitBreaker: idl.Bool, failureThreshold: idl.Nat, consecutiveFailures: idl.Nat });
  const transferProposal = idl.Record({ token: idl.Principal, recipient: idl.Principal, amount: idl.Nat, reason: idl.Text });
  const swapProposal = idl.Record({ fromToken: idl.Principal, toToken: idl.Principal, dex: idl.Principal, amount: idl.Nat, minReturn: idl.Nat, slippageBps: idl.Nat, quoteExpiresAt: idl.Int, reason: idl.Text });
  const action = idl.Variant({ transfer: transferProposal, swap: swapProposal });
  const tier = idl.Variant({ Autonomous: idl.Null, Escalation: idl.Null, Forbidden: idl.Null });
  const receipt = idl.Variant({ transfer: idl.Record({ token: idl.Principal, blockIndex: idl.Nat, fee: idl.Nat }), swap: idl.Record({ dex: idl.Principal, pool: idl.Principal, transactionId: idl.Opt(idl.Nat), approvalBlockIndex: idl.Nat, amountOut: idl.Nat, fee: idl.Nat }) });
  const settlement = idl.Variant({ success: receipt, failure: externalError });
  const outcome = idl.Record({ tier, error: idl.Opt(vaultError), ticketId: idl.Opt(idl.Nat), auditId: idl.Nat, settlement: idl.Opt(settlement) });
  const settlementLock = idl.Record({ action, startedAt: idl.Int });
  const depositAccount = idl.Record({ owner: idl.Principal, subaccount: idl.Vec(idl.Nat8) });
  const vaultState = idl.Record({ balances: idl.Vec(balance), policy, spend: idl.Vec(tokenSpend), pending: idl.Vec(idl.Record({ id: idl.Nat, action, createdAt: idl.Int, policyError: idl.Opt(vaultError), status: idl.Variant({ pending: idl.Null, approved: receipt, rejected: idl.Text }) })), audit: idl.Vec(idl.Record({ id: idl.Nat, action, tier, policyError: idl.Opt(vaultError), settlement: idl.Opt(settlement), timestamp: idl.Int, ticketId: idl.Opt(idl.Nat), note: idl.Text })), settlementInFlight: idl.Bool, settlementLock: idl.Opt(settlementLock), dexConfig: idl.Record({ factory: idl.Principal, feeTier: idl.Nat }), depositAccount });
  return idl.Service({
    app_agent_vault__getVaultState: idl.Func([idl.Null], [idl.Variant({ ok: vaultState, err: vaultError })], ["query"]),
    app_agent_vault__proposeTransfer: idl.Func([idl.Tuple(idl.Principal, idl.Principal, idl.Nat, idl.Text)], [idl.Variant({ ok: outcome, err: vaultError })], []),
  });
};
