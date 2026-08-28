import React, { useMemo, useState } from "react";
import type { AuditEntry, Balance } from "../types";
import { describeAction, formatRelativeTime, formatVaultError, getTier, isSettlementSuccess, parseActionDetails, parseReceipt, toBigInt } from "../utils";
import { IconActivity, IconCheckCircle, IconClock, IconDownload, IconInbox } from "./Icons";

type Filter = "all" | "settled" | "escalation" | "forbidden";

export function ActivityPanel({ audit, extraAudit, balances, onLoadMore, hasMore, onExportCsv }: { audit: AuditEntry[]; extraAudit: AuditEntry[]; balances: Balance[]; onLoadMore: () => Promise<void>; hasMore: boolean; onExportCsv: () => Promise<void> }) {
  const [filter, setFilter] = useState<Filter>("all");
  const allAudit = useMemo(() => {
    const seen = new Set<string>();
    return [...extraAudit, ...audit].filter((entry) => {
      if (seen.has(String(entry.id))) return false;
      seen.add(String(entry.id));
      return true;
    });
  }, [audit, extraAudit]);
  const filtered = useMemo(() => allAudit.slice().reverse().filter((item) => {
    if (filter === "all") return true;
    const tierName = getTier(item.tier);
    const summary = describeAction(item.action, balances).toLowerCase();
    if (filter === "settled") return tierName === "autonomous" || isSettlementSuccess(item.settlement);
    if (filter === "escalation") return tierName === "escalation";
    return tierName === "forbidden" || summary.includes("reject") || summary.includes("breaker");
  }), [allAudit, filter, balances]);

  return <div className="workspace-stack activity-workspace"><section className="workspace-heading"><div><span className="eyebrow">Activity</span><h1>Decision log</h1><p>Immutable audit entries for proposals, approvals, settlements, and failures.</p></div><span className="status-chip quiet"><IconActivity /> {audit.length} records</span></section><div className="activity-toolbar" role="tablist" aria-label="Activity filters">{(["all", "settled", "escalation", "forbidden"] as Filter[]).map((value) => <button type="button" role="tab" aria-selected={filter === value} className={`filter-button ${filter === value ? "active" : ""}`} key={value} onClick={() => setFilter(value)}>{value === "all" ? `All ${audit.length ? `(${audit.length})` : ""}` : value === "settled" ? "Settled" : value === "escalation" ? "Escalations" : "Forbidden"}</button>)}</div>{filtered.length === 0 ? <div className="empty-state empty-large"><div className="empty-icon"><IconClock /></div><strong>{audit.length ? "No matching records" : "No activity yet"}</strong><span>{audit.length ? "Choose another filter to inspect the full decision log." : "Agent proposals and owner decisions will appear here as live on-chain activity."}</span></div> : <div className="activity-table" role="list">{filtered.map((entry) => <ActivityEntry key={String(entry.id)} entry={entry} balances={balances} />)}</div>}{hasMore && <div className="activity-load-more"><button type="button" className="button button-secondary" onClick={() => void onLoadMore()}>Load more</button></div>}<div className="activity-export"><button type="button" className="button button-secondary" onClick={() => void onExportCsv()}><IconDownload /> Export CSV</button></div></div>;
}

function ActivityEntry({ entry, balances }: { entry: AuditEntry; balances: Balance[] }) {
  const [open, setOpen] = useState(false);
  const details = parseActionDetails(entry.action, balances);
  const receipt = parseReceipt(entry.settlement);
  const tierName = getTier(entry.tier);
  const tone = tierName === "forbidden" ? "danger" : tierName === "escalation" ? "warning" : "live";
  return <article className={`activity-entry ${open ? "open" : ""}`} role="listitem"><button type="button" className="activity-entry-summary" onClick={() => setOpen((value) => !value)} aria-expanded={open}><span className={`status-dot ${tone}`} /><span className="activity-entry-main"><strong>{details.type === "swap" ? "Token swap" : details.type === "transfer" ? "Token transfer" : details.summary}</strong><span>{details.reason || details.summary}</span></span><span className={`status-chip ${tone}`}>{tierName === "forbidden" ? "Forbidden" : tierName === "escalation" ? "Escalation" : "Autonomous"}</span><time>{formatRelativeTime(toBigInt(entry.timestamp))}</time><span className="activity-chevron">{open ? "−" : "+"}</span></button>{open && <div className="activity-entry-detail"><div className="detail-grid"><div><span>Action</span><strong>{details.actionLabel || (details.type === "swap" ? "Token swap" : details.type === "transfer" ? "ICRC transfer" : "Unknown")}</strong></div><div><span>Audit ID</span><code>#{String(entry.id)}</code></div><div><span>Policy decision</span><strong>{formatVaultError(entry.policyError)}</strong></div>{entry.evaluation && <><div><span>Policy profile</span><strong>{entry.evaluation.profileName}</strong></div><div><span>Policy revision</span><code>{String(entry.evaluation.revision)}</code></div></>}{details.token && <div><span>Token</span><code>{details.token}</code></div>}{details.recipient && <div><span>Recipient</span><code>{details.recipient}</code></div>}{details.fromToken && <div><span>From token</span><code>{details.fromToken}</code></div>}{details.toToken && <div><span>To token</span><code>{details.toToken}</code></div>}{details.amount && <div><span>Amount</span><code>{details.amount}</code></div>}{receipt?.type === "transfer" && <>{receipt.blockIndex && <div><span>Ledger block</span><code><IconCheckCircle /> {receipt.blockIndex}</code></div>}{receipt.fee && <div><span>Ledger fee</span><code>{receipt.fee}</code></div>}</>}{receipt?.type === "swap" && <>{receipt.approvalBlockIndex && <div><span>Approval block</span><code><IconCheckCircle /> {receipt.approvalBlockIndex}</code></div>}{receipt.pool && <div><span>Pool</span><code>{receipt.pool}</code></div>}{receipt.amountOut && <div><span>Amount out</span><code>{receipt.amountOut}</code></div>}{receipt.fee && <div><span>Settlement fees</span><code>{receipt.fee}</code></div>}<div><span>Swap transaction</span><code>{receipt.transactionId ?? "Not returned by protocol"}</code></div></>}{entry.note && <div><span>Note</span><strong>{entry.note}</strong></div>}</div><p className="detail-caption"><IconInbox /> Exact protocol values stay available here; human-readable summaries above never replace them.</p></div>}</article>;
}
