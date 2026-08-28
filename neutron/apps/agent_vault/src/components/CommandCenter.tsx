import React, { useEffect, useMemo, useState } from "react";
import type { AuditEntry, VaultState, Balance } from "../types";
import { bytesToHex, describeAction, formatAmount, formatRelativeTime, getTier, parseActionDetails, parseReceipt, shortenPrincipal, toBigInt } from "../utils";
import { IconActivity, IconAlertOctagon, IconArrowRight, IconCheck, IconClock, IconCopy, IconInbox, IconLayers, IconRefresh, IconShield, IconVault, IconZap } from "./Icons";
import { CopyButton } from "./CopyButton";
import { VelocityGauge } from "./VelocityGauge";
import { SwapForm } from "./SwapForm";

const STALENESS_MS = 300_000; // 5 minutes

function useRecoveryCountdown(startedAt: bigint | null): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    if (startedAt === null) { setRemaining(null); return; }
    const tick = () => {
      const startedMs = Number(startedAt / 1_000_000n);
      const left = STALENESS_MS - (Date.now() - startedMs);
      setRemaining(left > 0 ? left : 0);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return remaining;
}

function formatCountdown(ms: number): string {
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60).toString().padStart(2, "0");
  const s = (totalSec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

export function CommandCenter({ state, onNavigate, onRefresh, onSync, onSyncAll, onRecover, onProposeSwap, busy }: { state: VaultState; onNavigate: (view: string) => void; onRefresh: () => Promise<void>; onSync: (token: string) => Promise<void>; onSyncAll: () => Promise<void>; onRecover: () => Promise<void>; onProposeSwap: (params: { fromToken: string; toToken: string; dex: string; amount: bigint; minReturn: bigint; slippageBps: bigint; quoteExpiresAt: string; reason: string }) => Promise<void>; busy: string | null }) {
  const balances = useMemo(() => state.balances.slice().sort((a, b) => String(a.token.symbol).localeCompare(String(b.token.symbol))), [state.balances]);
  const recent = useMemo(() => state.audit.slice().reverse().slice(0, 5), [state.audit]);
  const pending = state.pending.slice(0, 3);
  const breaker = state.policy.circuitBreaker;
  const lock = state.settlementLock !== null && state.settlementLock !== undefined;
  const lockStartedAt = lock ? (state.settlementLock as { startedAt: bigint }).startedAt : null;
  const recoverRemaining = useRecoveryCountdown(lockStartedAt);
  const spendByToken = useMemo(() => {
    const map = new Map(state.spend.map((item) => [item.token, item]));
    for (const limit of state.policy.limits) {
      if (!map.has(limit.token)) map.set(limit.token, { token: limit.token, hourly: 0n, daily: 0n });
    }
    return map;
  }, [state.spend, state.policy.limits]);
  const balanceByToken = new Map(state.balances.map((item) => [item.token.id, item]));

  return <div className="workspace-stack command-workspace">
    <section className={`command-status ${breaker ? "is-danger" : lock ? "is-warning" : "is-live"}`}>
      <div className="status-mark">{breaker ? <IconAlertOctagon /> : lock ? <IconClock /> : <IconShield />}</div>
      <div className="status-copy">
        <span className="eyebrow">Custody posture</span>
        <strong>{breaker ? "Emergency breaker active" : lock ? "Settlement requires reconciliation" : "Vault operating normally"}</strong>
        <span>{breaker ? "Autonomous and owner-approved actions are halted until the breaker is reset." : lock ? "An external settlement outcome is still locked for explicit recovery." : "Isolated custody is live and agent proposals are governed by your policy."}</span>
      </div>
      <button type="button" className="button button-quiet" onClick={() => void onRefresh()}><IconRefresh /> Refresh state</button>
      {lock && recoverRemaining !== null && recoverRemaining > 0 && (
        <span className="recovery-countdown"><IconClock /> Recovery available in {formatCountdown(recoverRemaining)}</span>
      )}
      {lock && recoverRemaining !== null && recoverRemaining === 0 && (
        <button type="button" className="button button-warning" disabled={busy === "recover"} onClick={() => void onRecover()}><IconRefresh /> Recover lock</button>
      )}
      {lock && (state.settlementLock as { stage: string | null })?.stage && (
        <span className="recovery-stage"><IconClock /> Recovery stage: {(state.settlementLock as { stage: string | null }).stage}</span>
      )}
    </section>

    <section className="workspace-heading">
      <div><span className="eyebrow">Command center</span><h1>Daily oversight</h1><p>One clear view of custody, velocity, and decisions waiting on you.</p></div>
      <div className="heading-actions"><button type="button" className="button button-secondary" onClick={() => onNavigate("activity")}><IconActivity /> View activity</button><button type="button" className="button button-primary" onClick={() => onNavigate("approvals")}><IconInbox /> Review approvals {state.pending.length > 0 && <span className="button-count">{state.pending.length}</span>}</button></div>
    </section>

    <section className="command-grid command-grid-top">
      <div className="surface surface-balance"><div className="surface-label"><IconVault /> Custody balance</div><div className="balance-list">{balances.length === 0 ? <EmptyState title="No tracked assets" text="Fund the isolated account, then sync a supported token." action="Open policy" onClick={() => onNavigate("policy")} /> : balances.map((item) => <div className="balance-row" key={item.token.id}><div className="token-avatar">{item.token.symbol.slice(0, 2)}</div><div className="balance-name"><strong>{item.token.symbol}</strong><span>{item.token.standard} · fee {formatAmount(item.token.fee, item.token.decimals)}</span></div><strong className="balance-amount">{formatAmount(item.amount, item.token.decimals)} <small>{item.token.symbol}</small></strong><button type="button" className="icon-button" title={`Sync ${item.token.symbol}`} aria-label={`Sync ${item.token.symbol}`} disabled={busy === `sync-${item.token.id}`} onClick={() => void onSync(item.token.id)}><IconRefresh className={busy === `sync-${item.token.id}` ? "pb-spin" : ""} /></button></div>)}</div><div className="surface-footer"><span>{balances.length} live ledger{balances.length === 1 ? "" : "s"}</span><button type="button" className="text-button" onClick={() => void onSyncAll()} disabled={busy === "sync-all"} title="Sync all tracked balances">{busy === "sync-all" ? "Syncing…" : "Sync all"}</button><button type="button" className="text-button" onClick={() => onNavigate("policy")}>Manage policy <IconArrowRight /></button></div></div>
      <div className="surface surface-gauge"><div className="surface-label"><IconZap /> Velocity budgets</div>{state.policy.limits.length === 0 ? <EmptyState title="No budgets configured" text="Every proposal escalates until a token budget is added." action="Configure policy" onClick={() => onNavigate("policy")} /> : <div className="gauge-list">{state.policy.limits.slice(0, 3).map((limit) => { const spend = spendByToken.get(limit.token); const balance = balanceByToken.get(limit.token); const symbol = balance?.token.symbol ?? shortenPrincipal(limit.token); return <div className="gauge-block" key={limit.token}><div className="gauge-heading"><strong>{symbol}</strong><span title={limit.token}>{shortenPrincipal(limit.token)}</span></div>{spend ? <><VelocityGauge label="Hourly" spent={toBigInt(spend.hourly)} limit={toBigInt(limit.limits.maxHourlySpend)} decimals={balance?.token.decimals ?? null} symbol={symbol} /><VelocityGauge label="Daily" spent={toBigInt(spend.daily)} limit={toBigInt(limit.limits.maxDailySpend)} decimals={balance?.token.decimals ?? null} symbol={symbol} /></> : <span className="muted">Spend projection unavailable.</span>}</div> })}</div>}<div className="surface-footer"><span>{state.policy.limits.length} configured gate{state.policy.limits.length === 1 ? "" : "s"}</span><button type="button" className="text-button" onClick={() => onNavigate("policy")}>Manage policy <IconArrowRight /></button></div></div>
      <div className="surface surface-custody"><div className="surface-label"><IconShield /> Isolated custody</div><div className="custody-callout"><strong>Non-zero subaccount custody</strong><p>Funds remain separated from the canister default account.</p></div><div className="detail-row"><span>Owner</span><code title={state.depositAccount.owner}>{shortenPrincipal(state.depositAccount.owner)}</code><CopyButton text={state.depositAccount.owner} label="Copy" /></div><div className="detail-row"><span>Subaccount</span><code title={bytesToHex(state.depositAccount.subaccount)}>{bytesToHex(state.depositAccount.subaccount).slice(0, 12)}…</code><CopyButton text={bytesToHex(state.depositAccount.subaccount)} label="Copy" /></div><div className="surface-footer"><span>Deterministic 32-byte namespace</span></div></div>
    </section>

    <section className="command-grid command-grid-bottom">
      <div className="surface surface-activity"><div className="surface-header"><div><div className="surface-label"><IconActivity /> Recent activity</div><p>Latest proposals and settlement outcomes.</p></div><button type="button" className="text-button" onClick={() => onNavigate("activity")}>Open log <IconArrowRight /></button></div>{recent.length === 0 ? <EmptyState title="No activity yet" text="Agent proposals and owner decisions will appear here." /> : <div className="mini-list">{recent.map((item) => <ActivityRow key={String(item.id)} item={item} balances={state.balances} />)}</div>}</div>
      <div className="surface surface-approvals"><div className="surface-header"><div><div className="surface-label"><IconInbox /> Decisions waiting</div><p>Approval tickets require explicit owner action.</p></div><span className={`status-chip ${pending.length ? "warning" : "quiet"}`}>{state.pending.length} pending</span></div>{pending.length === 0 ? <EmptyState title="Nothing needs review" text="Escalated proposals will land here with their rationale and policy trigger." action="Open activity" onClick={() => onNavigate("activity")} /> : <div className="mini-list">{pending.map((ticket) => { const details = parseActionDetails(ticket.action, state.balances); return <button type="button" className="decision-row" key={String(ticket.id)} onClick={() => onNavigate("approvals")}><span className="decision-id">#{String(ticket.id)}</span><span className="decision-main"><strong>{details.type === "swap" ? "Swap" : "Transfer"}</strong><span>{details.reason || "Agent proposal"}</span></span><IconArrowRight /></button>; })}</div>}</div>
    </section>

    <SwapForm
      state={state}
      busy={busy}
      onPropose={onProposeSwap}
    />

    <details className="reference-panel"><summary><span><IconLayers /> How Agent Vault decides</span><span className="muted">Three execution tiers</span></summary><div className="reference-grid"><ReferenceTier tone="live" label="Autonomous" text="Allowlisted transfers within fee-inclusive token budgets settle immediately." /><ReferenceTier tone="warning" label="Escalation" text="Over-budget transfers, unlisted recipients, and all non-zero swaps wait for approval." /><ReferenceTier tone="danger" label="Forbidden" text="Invalid amounts, missing configuration, and active breakers stop before funds move." /></div></details>
  </div>;
}

function ActivityRow({ item, balances }: { item: AuditEntry; balances: Balance[] }) { const details = parseActionDetails(item.action, balances); const receipt = parseReceipt(item.settlement); const tierName = getTier(item.tier); const tone = tierName === "forbidden" ? "danger" : tierName === "escalation" ? "warning" : "live"; return <div className="activity-row"><span className={`status-dot ${tone}`} /><div className="activity-main"><strong>{details.type === "unknown" ? describeAction(item.action, balances) : details.type === "swap" ? "Swap proposal" : "Transfer proposal"}</strong><span>{details.reason || details.summary}</span></div><span className="activity-note">{receipt?.blockIndex ? `Block #${receipt.blockIndex}` : item.note || "Recorded"}</span><time>{formatRelativeTime(toBigInt(item.timestamp))}</time></div>; }
function EmptyState({ title, text, action, onClick }: { title: string; text: string; action?: string; onClick?: () => void }) { return <div className="empty-state"><div className="empty-icon"><IconInbox /></div><strong>{title}</strong><span>{text}</span>{action && onClick && <button type="button" className="text-button" onClick={onClick}>{action} <IconArrowRight /></button>}</div>; }
function ReferenceTier({ tone, label, text }: { tone: string; label: string; text: string }) { return <div className="reference-tier"><span className={`status-chip ${tone}`}>{label}</span><p>{text}</p></div>; }
