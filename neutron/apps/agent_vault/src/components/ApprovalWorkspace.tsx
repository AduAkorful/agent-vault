import React, { useEffect, useState } from "react";
import type { Ticket, Balance } from "../types";
import { formatAmount, formatRelativeTime, formatVaultError, getTokenDecimals, parseActionDetails, shortenPrincipal, toBigInt } from "../utils";
import { IconAlertOctagon, IconArrowRight, IconCheck, IconClock, IconInbox, IconMessageSquare, IconShield, IconTrash, IconX } from "./Icons";

export function ApprovalWorkspace({
  tickets,
  busy,
  onApprove,
  onReject,
  balances,
}: {
  tickets: Ticket[];
  busy: string | null;
  onApprove: (ticket: Ticket) => Promise<void>;
  onReject: (ticket: Ticket, reason: string) => Promise<void>;
  balances: Balance[];
}) {
  const [selected, setSelected] = useState<Ticket | null>(tickets[0] ?? null);
  const [selectedBulk, setSelectedBulk] = useState<Set<bigint>>(new Set());
  const [bulkRejectReason, setBulkRejectReason] = useState("");
  const [showBulkReject, setShowBulkReject] = useState(false);

  useEffect(() => {
    if (selected && !tickets.find((t) => t.id === selected.id)) {
      setSelected(tickets[0] ?? null);
    }
  }, [tickets, selected]);

  const toggleBulk = (id: bigint) =>
    setSelectedBulk((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectAll = () =>
    tickets.length === selectedBulk.size
      ? setSelectedBulk(new Set())
      : setSelectedBulk(new Set(tickets.map((t) => t.id)));

  const clearBulk = () => {
    setSelectedBulk(new Set());
    setBulkRejectReason("");
  };

  const handleBulkApprove = async () => {
    const ids = Array.from(selectedBulk);
    for (const id of ids) {
      const ticket = tickets.find((t) => t.id === id);
      if (ticket) await onApprove(ticket);
    }
    clearBulk();
  };

  const handleBulkReject = async () => {
    const ids = Array.from(selectedBulk);
    for (const id of ids) {
      const ticket = tickets.find((t) => t.id === id);
      if (ticket) await onReject(ticket, bulkRejectReason || "Owner rejected");
    }
    clearBulk();
    setShowBulkReject(false);
  };

  return (
    <div className="workspace-stack approval-workspace">
      <div className="workspace-heading">
        <div>
          <span className="eyebrow">Approvals</span>
          <h1>Decisions waiting</h1>
          <p>Review the agent's intent, policy trigger, and exact settlement parameters before authorizing.</p>
        </div>
        <span className={`status-chip ${tickets.length ? "warning" : "quiet"}`}>
          <IconInbox /> {tickets.length} pending
        </span>
      </div>

      {tickets.length === 0 ? (
        <div className="empty-state empty-large">
          <div className="empty-icon">
            <IconCheck />
          </div>
          <strong>No decisions waiting</strong>
          <span>
            When an operation needs you, it will appear here with a clear reason and review trail. This does not imply
            that all future proposals will settle autonomously.
          </span>
        </div>
      ) : (
        <div className={`approval-layout-container ${selected ? "has-selected" : ""}`}>
          <div className="approval-queue-col">
            <div className="approval-queue-header">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={tickets.length > 0 && selectedBulk.size === tickets.length}
                  onChange={selectAll}
                  disabled={busy !== null}
                  aria-label="Select all tickets"
                />
                Select all
              </label>

              {selectedBulk.size > 0 && (
                <div className="bulk-actions-group">
                  <button
                    type="button"
                    className="button button-primary button-sm"
                    disabled={busy !== null}
                    onClick={() => void handleBulkApprove()}
                  >
                    <IconCheck /> Approve ({selectedBulk.size})
                  </button>
                  <button
                    type="button"
                    className="button button-danger button-sm"
                    disabled={busy !== null}
                    onClick={() => setShowBulkReject(true)}
                  >
                    <IconTrash /> Reject ({selectedBulk.size})
                  </button>
                  {showBulkReject && (
                    <div className="bulk-reject-box">
                      <textarea
                        className="reject-reason-text"
                        placeholder="Rejection reason (optional)..."
                        value={bulkRejectReason}
                        onChange={(e) => setBulkRejectReason(e.target.value)}
                        disabled={busy !== null}
                      />
                      <button
                        type="button"
                        className="button button-danger button-sm"
                        disabled={busy !== null}
                        onClick={() => void handleBulkReject()}
                      >
                        Confirm
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="approval-queue">
              {tickets.map((ticket) => {
                const details = parseActionDetails(ticket.action, balances);
                const isSelected = selected?.id === ticket.id;
                return (
                  <button
                    type="button"
                    className={`approval-item ${isSelected ? "selected" : ""}`}
                    key={String(ticket.id)}
                    onClick={() => {
                      setSelected(ticket);
                      setSelectedBulk(new Set());
                    }}
                  >
                    <span className="approval-item-checkbox">
                      <input
                        type="checkbox"
                        checked={selectedBulk.has(ticket.id)}
                        onChange={() => toggleBulk(ticket.id)}
                        onClick={(e) => e.stopPropagation()}
                        disabled={busy !== null}
                        aria-label={`Select ticket #${ticket.id}`}
                      />
                    </span>
                    <div className="approval-item-body">
                      <div className="approval-item-top">
                        <span className="decision-id">Ticket #{String(ticket.id)}</span>
                        <span className={`status-chip ${details.type === "swap" ? "warning" : "live"}`}>
                          {details.type === "swap" ? "Swap" : "Transfer"}
                        </span>
                        <time className="approval-time">{formatRelativeTime(toBigInt(ticket.createdAt))}</time>
                      </div>
                      <strong className="approval-title">{details.reason || details.summary}</strong>
                      <span className="approval-trigger">{formatVaultError(ticket.policyError)}</span>
                    </div>
                    <span className="approval-item-arrow">
                      <IconArrowRight />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {selected && (
            <ReviewDrawer
              ticket={selected}
              busy={busy === `ticket-${selected.id}`}
              onClose={() => setSelected(null)}
              onApprove={() => void onApprove(selected)}
              onReject={(reason: string) => void onReject(selected, reason)}
              balances={balances}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ReviewDrawer({
  ticket,
  busy,
  onClose,
  onApprove,
  onReject,
  balances,
}: {
  ticket: Ticket;
  busy: boolean;
  onClose: () => void;
  onApprove: () => void;
  onReject: (reason: string) => void;
  balances: Balance[];
}) {
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const details = parseActionDetails(ticket.action, balances);

  return (
    <aside className="review-drawer">
      <div className="drawer-header">
        <div>
          <span className="eyebrow">Ticket #{String(ticket.id)}</span>
          <h2>Review proposal</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close review"
          title="Close review"
          onClick={onClose}
        >
          <IconX />
        </button>
      </div>

      <div className="drawer-scroll">
        <div className="review-trigger">
          <IconAlertOctagon />
          <div>
            <span className="eyebrow">Why this is waiting</span>
            <strong>{formatVaultError(ticket.policyError)}</strong>
          </div>
        </div>

        {ticket.evaluation && (
          <div className="review-section">
            <span className="section-label">
              <IconShield /> Policy context
            </span>
            <div className="parameter-list">
              <div>
                <span>Profile</span>
                <strong>{ticket.evaluation.profileName}</strong>
              </div>
              <div>
                <span>Revision</span>
                <code>{String(ticket.evaluation.revision)}</code>
              </div>
              {ticket.evaluation.fee !== null && (
                <div>
                  <span>Fee</span>
                  <code>
                    {formatAmount(
                      ticket.evaluation.fee,
                      getTokenDecimals(details.token || details.fromToken || "", balances)
                    )}
                  </code>
                </div>
              )}
              {ticket.evaluation.hourlyBefore !== null && ticket.evaluation.hourlyAfter !== null && (
                <div>
                  <span>Hourly spend</span>
                  <code>
                    {formatAmount(
                      ticket.evaluation.hourlyBefore,
                      getTokenDecimals(details.token || details.fromToken || "", balances)
                    )}{" "}
                    →{" "}
                    {formatAmount(
                      ticket.evaluation.hourlyAfter,
                      getTokenDecimals(details.token || details.fromToken || "", balances)
                    )}
                  </code>
                </div>
              )}
              {ticket.evaluation.dailyBefore !== null && ticket.evaluation.dailyAfter !== null && (
                <div>
                  <span>Daily spend</span>
                  <code>
                    {formatAmount(
                      ticket.evaluation.dailyBefore,
                      getTokenDecimals(details.token || details.fromToken || "", balances)
                    )}{" "}
                    →{" "}
                    {formatAmount(
                      ticket.evaluation.dailyAfter,
                      getTokenDecimals(details.token || details.fromToken || "", balances)
                    )}
                  </code>
                </div>
              )}
            </div>
          </div>
        )}

        {!ticket.evaluation && (
          <div className="review-note">
            This ticket predates policy evaluation snapshots. Re-propose it to obtain complete approval context.
          </div>
        )}

        <div className="review-section">
          <span className="section-label">
            <IconMessageSquare /> Agent rationale
          </span>
          <blockquote className="agent-rationale-quote">
            {details.reason ? `“${details.reason}”` : "No rationale was included with this proposal."}
          </blockquote>
        </div>

        <div className="review-section">
          <span className="section-label">
            <IconClock /> Parameters
          </span>
          <div className="parameter-list">
            <div>
              <span>Action</span>
              <strong>{details.actionLabel || (details.type === "swap" ? "Token swap" : "ICRC transfer")}</strong>
            </div>
            <div>
              <span>Amount</span>
              <strong>{details.amount}</strong>
            </div>
            {details.token && (
              <div>
                <span>Token</span>
                <code title={details.token}>{shortenPrincipal(details.token)}</code>
              </div>
            )}
            {details.recipient && (
              <div>
                <span>Recipient</span>
                <code title={details.recipient}>{shortenPrincipal(details.recipient)}</code>
              </div>
            )}
            {details.fromToken && (
              <div>
                <span>From token</span>
                <code title={details.fromToken}>{shortenPrincipal(details.fromToken)}</code>
              </div>
            )}
            {details.toToken && (
              <div>
                <span>To token</span>
                <code title={details.toToken}>{shortenPrincipal(details.toToken)}</code>
              </div>
            )}
            <div>
              <span>Created</span>
              <strong>{formatRelativeTime(toBigInt(ticket.createdAt))}</strong>
            </div>
          </div>
        </div>

        <div className="review-note">
          Approval authorizes the exact staged intent shown here. Swaps never settle autonomously.
        </div>
      </div>

      <div className="drawer-actions">
        {showReject ? (
          <div className="reject-confirm">
            <textarea
              className="reject-reason-text"
              placeholder="Rejection reason (optional)..."
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              disabled={busy}
              autoFocus
            />
            <div className="reject-confirm-buttons">
              <button
                type="button"
                className="button button-secondary button-sm"
                onClick={() => setShowReject(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button button-danger button-sm"
                disabled={busy}
                onClick={() => {
                  void onReject(rejectReason.trim() || "Owner rejected");
                  setShowReject(false);
                  setRejectReason("");
                }}
              >
                <IconTrash /> Confirm
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={() => setShowReject(true)}
          >
            <IconTrash /> Reject
          </button>
        )}
        {!showReject && (
          <button
            type="button"
            className="button button-primary"
            disabled={busy}
            onClick={onApprove}
          >
            <IconCheck /> {busy ? "Settling…" : "Approve & settle"}
          </button>
        )}
      </div>
    </aside>
  );
}
