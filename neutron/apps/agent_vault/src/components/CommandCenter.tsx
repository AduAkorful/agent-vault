import React, { useEffect, useMemo, useState } from "react";
import type { AuditEntry, VaultState, Balance, TokenValuation } from "../types";
import { bytesToHex, describeAction, formatAmount, formatAmountSafe, formatBaseUnit, formatRelativeTime, getTier, getTokenDecimals, parseActionDetails, parseReceipt, shortenPrincipal, toBigInt } from "../utils";
import { IconActivity, IconAlertOctagon, IconArrowRight, IconCheck, IconClock, IconCopy, IconInbox, IconLayers, IconPlus, IconRefresh, IconShield, IconTrash, IconVault, IconX, IconZap } from "./Icons";
import { CopyButton } from "./CopyButton";
import { VelocityGauge } from "./VelocityGauge";
import { SwapForm } from "./SwapForm";
import { AllocationChart } from "./AllocationChart";

const STALENESS_MS = 300_000; // 5 minutes

function useRecoveryCountdown(startedAt: bigint | null): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    if (startedAt === null || startedAt === undefined) { setRemaining(null); return; }
    const tick = () => {
      try {
        const bi = typeof startedAt === "bigint" ? startedAt : BigInt(startedAt);
        const startedMs = Number(bi / 1_000_000n);
        const left = STALENESS_MS - (Date.now() - startedMs);
        setRemaining(left > 0 ? left : 0);
      } catch {
        setRemaining(0);
      }
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

export function CommandCenter({ state, onNavigate, onRefresh, onSync, onSyncAll, onRecover, onProposeSwap, onProposeTransfers, portfolioValue, syncPrices, onSyncPrices, busy }: { state: VaultState; onNavigate: (view: string) => void; onRefresh: () => Promise<void>; onSync: (token: string) => Promise<void>; onSyncAll: () => Promise<void>; onRecover: () => Promise<void>; onProposeSwap: (params: { fromToken: string; toToken: string; dex: string; amount: bigint; minReturn: bigint; slippageBps: bigint; quoteExpiresAt: string; reason: string }) => Promise<void>; onProposeTransfers: (proposals: { token: string; recipient: string; amount: string; reason: string }[]) => Promise<void>; portfolioValue: TokenValuation[] | null; syncPrices: boolean; onSyncPrices: () => Promise<void>; busy: string | null }) {
  const balances = useMemo(() => state.balances.slice().sort((a, b) => String(a.token.symbol).localeCompare(String(b.token.symbol))), [state.balances]);
  const recent = useMemo(() => state.audit.slice().reverse().slice(0, 5), [state.audit]);
  const pending = state.pending.slice(0, 3);
  const breaker = state.policy.circuitBreaker;
  const rawLock = Array.isArray(state.settlementLock)
    ? (state.settlementLock.length > 0 ? state.settlementLock[0] : null)
    : state.settlementLock;
  const lock = rawLock !== null && rawLock !== undefined && typeof rawLock === "object";
  const lockStartedAt = lock && "startedAt" in (rawLock as object) ? toBigInt((rawLock as { startedAt: unknown }).startedAt) : null;
  const lockStage = lock && "stage" in (rawLock as object) ? (rawLock as { stage?: string | null }).stage ?? null : null;
  const isPreSubmitLock = lock && lockStage === null;
  const countdown = useRecoveryCountdown(lockStartedAt);
  const recoverRemaining = isPreSubmitLock ? 0 : countdown;
  const spendByToken = useMemo(() => {
    const map = new Map(state.spend.map((item) => [item.token, item]));
    for (const limit of state.policy.limits) {
      if (!map.has(limit.token)) map.set(limit.token, { token: limit.token, hourly: 0n, daily: 0n });
    }
    return map;
  }, [state.spend, state.policy.limits]);
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [batchRows, setBatchRows] = useState<Array<{ token: string; recipient: string; amount: string; reason: string }>>([{ token: "", recipient: "", amount: "", reason: "" }]);

  const addBatchRow = () => setBatchRows((prev) => [...prev, { token: "", recipient: "", amount: "", reason: "" }]);
  const removeBatchRow = (index: number) => setBatchRows((prev) => prev.filter((_, i) => i !== index));
  const updateBatchRow = (index: number, field: string, value: string) => setBatchRows((prev) => prev.map((row, i) => i === index ? { ...row, [field as keyof typeof row]: value } : row));
  const clearBatch = () => setBatchRows([{ token: "", recipient: "", amount: "", reason: "" }]);
  const submitBatch = async () => {
    const validRows = batchRows.filter((r) => r.token.trim() && r.recipient.trim() && r.amount.trim());
    if (validRows.length === 0) return;
    setShowBatchModal(false);
    clearBatch();
    await onProposeTransfers(validRows);
  };

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
      <div className="heading-actions"><button type="button" className="button button-secondary" onClick={() => onNavigate("activity")}><IconActivity /> View activity</button><button type="button" className="button button-secondary" onClick={() => setShowBatchModal(true)}><IconLayers /> Batch transfer</button><button type="button" className="button button-primary" onClick={() => onNavigate("approvals")}><IconInbox /> Review approvals {state.pending.length > 0 && <span className="button-count">{state.pending.length}</span>}</button></div>
    </section>

    <section className="command-grid command-grid-top">
      <div className="surface surface-balance"><div className="surface-label"><IconVault /> Custody balance</div><div className="balance-list">{balances.length === 0 ? <EmptyState title="No tracked assets" text="Fund the isolated account, then sync a supported token." action="Open policy" onClick={() => onNavigate("policy")} /> : balances.map((item) => <div className="balance-row" key={item.token.id}><div className="token-avatar">{item.token.symbol.slice(0, 2)}</div><div className="balance-name"><strong>{item.token.symbol}</strong><span>{item.token.standard} · fee {formatAmount(item.token.fee, item.token.decimals)}</span></div><strong className="balance-amount">{formatAmount(item.amount, item.token.decimals)} <small>{item.token.symbol}</small></strong><button type="button" className="icon-button" title={`Sync ${item.token.symbol}`} aria-label={`Sync ${item.token.symbol}`} disabled={busy === `sync-${item.token.id}`} onClick={() => void onSync(item.token.id)}><IconRefresh className={busy === `sync-${item.token.id}` ? "pb-spin" : ""} /></button></div>)}</div><div className="surface-footer"><span>{balances.length} live ledger{balances.length === 1 ? "" : "s"}</span><button type="button" className="text-button" onClick={() => void onSyncAll()} disabled={busy === "sync-all"} title="Sync all tracked balances">{busy === "sync-all" ? "Syncing…" : "Sync all"}</button><button type="button" className="text-button" onClick={() => onNavigate("policy")}>Manage policy <IconArrowRight /></button></div></div>
      <div className="surface surface-allocation"><div className="surface-label"><IconLayers /> Portfolio allocation</div><AllocationChart balances={balances} valuations={portfolioValue} syncPrices={syncPrices} onSyncPrices={onSyncPrices} /><div className="surface-footer"><span>USD via ICPSwap live reserves</span></div></div>
      <div className="surface surface-gauge"><div className="surface-label"><IconZap /> Velocity budgets</div>{state.policy.limits.length === 0 ? <EmptyState title="No budgets configured" text="Every proposal escalates until a token budget is added." action="Configure policy" onClick={() => onNavigate("policy")} /> : <div className="gauge-list">{state.policy.limits.slice(0, 3).map((limit) => { const spend = spendByToken.get(limit.token); const balance = balanceByToken.get(limit.token); const symbol = balance?.token.symbol ?? shortenPrincipal(limit.token); const decimals = balance?.token.decimals ?? getTokenDecimals(limit.token, state.balances); return <div className="gauge-block" key={limit.token}><div className="gauge-heading"><strong>{symbol}</strong><span title={limit.token}>{shortenPrincipal(limit.token)}</span></div>{spend ? <><VelocityGauge label="Hourly" spent={toBigInt(spend.hourly)} limit={toBigInt(limit.limits.maxHourlySpend)} decimals={decimals} symbol={symbol} /><VelocityGauge label="Daily" spent={toBigInt(spend.daily)} limit={toBigInt(limit.limits.maxDailySpend)} decimals={decimals} symbol={symbol} /></> : <span className="muted">Spend projection unavailable.</span>}</div> })}</div>}<div className="surface-footer"><span>{state.policy.limits.length} configured gate{state.policy.limits.length === 1 ? "" : "s"}</span><button type="button" className="text-button" onClick={() => onNavigate("policy")}>Manage policy <IconArrowRight /></button></div></div>
      <div className="surface surface-custody"><div className="surface-label"><IconShield /> Isolated custody</div><div className="custody-callout"><strong>Non-zero subaccount custody</strong><p>Funds remain separated from the canister default account.</p></div><div className="detail-row"><span>Owner</span><code title={state.depositAccount.owner}>{shortenPrincipal(state.depositAccount.owner)}</code><CopyButton text={state.depositAccount.owner} label="Copy" /></div><div className="detail-row"><span>Subaccount</span><code title={bytesToHex(state.depositAccount.subaccount)}>{bytesToHex(state.depositAccount.subaccount).slice(0, 12)}…</code><CopyButton text={bytesToHex(state.depositAccount.subaccount)} label="Copy" /></div><div className="surface-footer"><span>Deterministic 32-byte namespace</span></div></div>
    </section>

    <section className="command-grid command-grid-bottom">
      <div className="surface surface-activity"><div className="surface-header"><div><div className="surface-label"><IconActivity /> Recent activity</div><p>Latest proposals and settlement outcomes.</p></div><button type="button" className="text-button" onClick={() => onNavigate("activity")}>Open log <IconArrowRight /></button></div>{recent.length === 0 ? <EmptyState title="No activity yet" text="Agent proposals and owner decisions will appear here." /> : <div className="mini-list">{recent.map((item) => <ActivityRow key={String(item.id)} item={item} balances={state.balances} labels={state.recipientLabels ?? []} />)}</div>}</div>
      <div className="surface surface-approvals"><div className="surface-header"><div><div className="surface-label"><IconInbox /> Decisions waiting</div><p>Approval tickets require explicit owner action.</p></div><span className={`status-chip ${pending.length ? "warning" : "quiet"}`}>{state.pending.length} pending</span></div>{pending.length === 0 ? <EmptyState title="Nothing needs review" text="Escalated proposals will land here with their rationale and policy trigger." action="Open activity" onClick={() => onNavigate("activity")} /> : <div className="mini-list">{pending.map((ticket) => { const details = parseActionDetails(ticket.action, state.balances, state.recipientLabels ?? []); return <button type="button" className="decision-row" key={String(ticket.id)} onClick={() => onNavigate("approvals")}><span className="decision-id">#{String(ticket.id)}</span><span className="decision-main"><strong>{details.type === "swap" ? "Swap" : "Transfer"}</strong><span>{details.reason || "Agent proposal"}</span></span><IconArrowRight /></button>; })}</div>}</div>
    </section>

    <details className="reference-panel"><summary><span><IconLayers /> How Agent Vault decides</span><span className="muted">Three execution tiers</span></summary><div className="reference-grid"><ReferenceTier tone="live" label="Autonomous" text="Allowlisted transfers within fee-inclusive token budgets settle immediately." /><ReferenceTier tone="warning" label="Escalation" text="Over-budget transfers, unlisted recipients, and all non-zero swaps wait for approval." /><ReferenceTier tone="danger" label="Forbidden" text="Invalid amounts, missing configuration, and active breakers stop before funds move." /></div></details>

    <BatchTransferModal
      show={showBatchModal}
      onClose={() => setShowBatchModal(false)}
      balances={balances}
      rows={batchRows}
      setRows={setBatchRows}
      addRow={addBatchRow}
      removeRow={removeBatchRow}
      updateRow={updateBatchRow}
      onSubmit={submitBatch}
      busy={busy}
    />
  </div>;
}

function BatchTransferModal({ show, onClose, balances, rows, setRows, addRow, removeRow, updateRow, onSubmit, busy }: { show: boolean; onClose: () => void; balances: Balance[]; rows: Array<{ token: string; recipient: string; amount: string; reason: string }>; setRows: React.Dispatch<React.SetStateAction<Array<{ token: string; recipient: string; amount: string; reason: string }>>>; addRow: () => void; removeRow: (index: number) => void; updateRow: (index: number, field: string, value: string) => void; onSubmit: () => Promise<void>; busy: string | null }) {
  if (!show) return null;

  const tokenOptions = balances.slice().sort((a, b) => String(a.token.symbol).localeCompare(String(b.token.symbol)));

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="batch-modal-title" onClick={onClose}>
      <div className="modal-container" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 id="batch-modal-title">Batch transfer</h3>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}><IconX /></button>
        </div>
        <div className="modal-body">
          <p className="modal-body-text">Add up to 50 transfers. Each is classified independently against the active policy — autonomous transfers settle immediately; escalated ones park as approval tickets.</p>
          <div className="batch-rows">
            {rows.map((row, index) => (
              <div className="batch-row" key={index}>
                <select
                  className="batch-input batch-token"
                  value={row.token}
                  onChange={(e) => updateRow(index, "token", e.target.value)}
                  disabled={busy !== null}
                >
                  <option value="">Select token</option>
                  {tokenOptions.map((b) => (
                    <option key={b.token.id} value={b.token.id}>{b.token.symbol}</option>
                  ))}
                </select>
                <input
                  type="text"
                  className="batch-input batch-recipient"
                  placeholder="Recipient principal"
                  value={row.recipient}
                  onChange={(e) => updateRow(index, "recipient", e.target.value)}
                  disabled={busy !== null}
                />
                <input
                  type="text"
                  className="batch-input batch-amount"
                  placeholder="Amount (base units)"
                  value={row.amount}
                  onChange={(e) => updateRow(index, "amount", e.target.value)}
                  disabled={busy !== null}
                  inputMode="numeric"
                />
                <input
                  type="text"
                  className="batch-input batch-reason"
                  placeholder="Reason (optional)"
                  value={row.reason}
                  onChange={(e) => updateRow(index, "reason", e.target.value)}
                  disabled={busy !== null}
                />
                {rows.length > 1 && (
                  <button
                    type="button"
                    className="icon-button danger-icon"
                    title="Remove row"
                    disabled={busy !== null}
                    onClick={() => removeRow(index)}
                  >
                    <IconTrash />
                  </button>
                )}
              </div>
            ))}
          </div>
          {rows.length < 50 && (
            <button type="button" className="button button-secondary button-sm" onClick={addRow} disabled={busy !== null}>
              <IconPlus /> Add recipient
            </button>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy !== null}>
            Cancel
          </button>
          <button
            type="submit"
            className="button button-primary"
            disabled={busy !== null || rows.every((r) => !r.token || !r.recipient || !r.amount)}
            onClick={() => void onSubmit()}
          >
            <IconCheck /> Propose batch
          </button>
        </div>
      </div>
    </div>
  );
}

function ActivityRow({ item, balances, labels }: { item: AuditEntry; balances: Balance[]; labels: [string, string][] }) {
  const details = parseActionDetails(item.action, balances, labels);
  const receipt = parseReceipt(item.settlement);
  const tierName = getTier(item.tier);
  const tone = tierName === "forbidden" ? "danger" : tierName === "escalation" ? "warning" : "live";
  const amountOutDecimals = receipt?.type === "swap"
    ? balances.find((b) => b.token.id === (details as { toToken?: string }).toToken)?.token.decimals ?? null
    : null;
  const swapReference = (() => {
    if (!receipt) return null;
    if (receipt.type === "transfer") return formatBaseUnit(receipt.blockIndex ?? "");
    if (receipt.type === "swap") return formatAmountSafe(receipt.amountOut ?? "", amountOutDecimals, (details as { toToken?: string }).toToken, "swap.amountOut");
    return null;
  })();
  return (
    <div className="activity-row">
      <span className={`status-dot ${tone}`} />
      <div className="activity-main">
        <strong>{details.type === "unknown" ? describeAction(item.action, balances, labels) : details.type === "swap" ? "Swap proposal" : "Transfer proposal"}</strong>
        <span>{details.reason || details.summary}</span>
      </div>
      <span className="activity-note">
        {receipt?.type === "transfer" && receipt.blockIndex ? `Block #${formatBaseUnit(receipt.blockIndex)}` : null}
        {receipt?.type === "swap" && receipt.amountOut ? `Out ${swapReference ?? "unreadable"}` : null}
        {!receipt ? item.note || "Recorded" : null}
      </span>
      <time>{formatRelativeTime(toBigInt(item.timestamp))}</time>
    </div>
  );
}
function EmptyState({ title, text, action, onClick }: { title: string; text: string; action?: string; onClick?: () => void }) { return <div className="empty-state"><div className="empty-icon"><IconInbox /></div><strong>{title}</strong><span>{text}</span>{action && onClick && <button type="button" className="text-button" onClick={onClick}>{action} <IconArrowRight /></button>}</div>; }
function ReferenceTier({ tone, label, text }: { tone: string; label: string; text: string }) { return <div className="reference-tier"><span className={`status-chip ${tone}`}>{label}</span><p>{text}</p></div>; }
