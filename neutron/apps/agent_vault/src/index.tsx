import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { loadTileContext, querySelf, updateSelf, type JsonValue } from "neutron-tools/app";
import type { Ticket, TileContext, VaultState, PolicyDraft, AuditEntry, TokenValuation } from "./types";
import { errorMessage, exportAuditToCsv, extractErrorMessage, shortenPrincipal, unwrapOk, makePolicyDraft, isPolicyDraftDirty, downloadFile } from "./utils";
import { IconActivity, IconAlertOctagon, IconDownload, IconInbox, IconRefresh, IconSliders, IconSwap, IconVault } from "./components/Icons";
import { CommandCenter } from "./components/CommandCenter";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PolicyPanel } from "./components/PolicyPanel";
import { ActivityPanel } from "./components/ActivityPanel";
import { ApprovalWorkspace } from "./components/ApprovalWorkspace";
import { SkillExport } from "./components/SkillExport";
import { SwapWorkspace } from "./components/SwapWorkspace";
import "./style.scss";

type Workspace = "command" | "policy" | "swap" | "activity" | "approvals" | "skill";

function Dashboard() {
  const [ctx, setCtx] = useState<TileContext | null>(null);
  const [state, setState] = useState<VaultState | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeView, setActiveView] = useState<Workspace>("command");
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ kind: "info" | "error" | "success"; text: string } | null>(null);
  const [pendingView, setPendingView] = useState<Workspace | null>(null);
  const [policyDraft, setPolicyDraft] = useState<PolicyDraft | null>(null);
  const [auditOffset, setAuditOffset] = useState(0);
  const [extraAudit, setExtraAudit] = useState<AuditEntry[]>([]);
  const [hasMoreActivity, setHasMoreActivity] = useState(false);
  const [portfolioValues, setPortfolioValues] = useState<TokenValuation[] | null>(null);
  const [syncPrices, setSyncPrices] = useState(false);
  const recoveryPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Clean up recovery polling when the lock clears
  useEffect(() => {
    if (state?.settlementLock === null && recoveryPollRef.current !== null) {
      clearInterval(recoveryPollRef.current);
      recoveryPollRef.current = null;
      if (busy === "recover-poll") {
        setBusy(null);
        setBanner({ kind: "success", text: "Settlement lock fully recovered." });
      }
    }
  }, [state?.settlementLock, busy]);

  // Clean up recovery polling on unmount
  useEffect(() => () => {
    if (recoveryPollRef.current !== null) clearInterval(recoveryPollRef.current);
  }, []);

  useEffect(() => { try { setCtx(loadTileContext() as TileContext); } catch { setCtx(null); } }, []);
  useEffect(() => {
    if (banner && banner.kind !== "error") {
      const timer = setTimeout(() => setBanner(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [banner]);
  const refreshState = useCallback(async (quiet = false) => {
    if (!quiet) setBusy("refresh");
    try {
      const liveState = (await querySelf("getVaultState", [null])) as unknown as VaultState;
      setState(liveState);
      setHasMoreActivity(liveState.audit.length >= 100);
      setPolicyDraft((currentDraft) => {
        if (currentDraft && isPolicyDraftDirty(liveState.policy, currentDraft, liveState.balances)) {
          return currentDraft;
        }
        return makePolicyDraft(liveState.policy, liveState.balances);
      });
      if (!quiet) setBanner({ kind: "success", text: "On-chain state refreshed." });
      try {
        const raw = (await updateSelf("getPortfolioValue", [null])) as unknown as TokenValuation[];
        setPortfolioValues(raw ?? []);
      } catch {
        // USD pricing depends on live pool availability — don't block on it.
      }
    }
    catch (error) {
      if (!quiet) setBanner({ kind: "error", text: `Could not refresh vault state: ${errorMessage(error)}` });
    }
    finally {
      setLoading(false);
      if (!quiet) setBusy(null);
    }
  }, []);
  useEffect(() => { void refreshState(true); }, [refreshState]);
  useEffect(() => {
    const interval = setInterval(() => {
      if (busy === null) {
        void refreshState(true);
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [refreshState, busy]);

  const safeUnwrap = <T,>(result: unknown): T => {
    if (result === null || result === undefined) return null as T;
    if (typeof result === "object" && result !== null && !Array.isArray(result)) {
      const rec = result as Record<string, unknown>;
      if ("err" in rec) throw new Error(extractErrorMessage(rec.err));
      if ("Err" in rec) throw new Error(extractErrorMessage(rec.Err));
      if ("ok" in rec) return rec.ok as T;
      if ("Ok" in rec) return rec.Ok as T;
    }
    return result as T;
  };

  const handleUpdate = async (method: string, args: JsonValue[], key: string) => {
    setBusy(key); setBanner(null);
    try { safeUnwrap(await updateSelf(method, args)); await updateSelf("syncAllBalances", [null]); await refreshState(); setBanner({ kind: "success", text: "Policy saved on-chain." }); }
    catch (error) { setBanner({ kind: "error", text: errorMessage(error) }); }
    finally { setBusy(null); }
  };
  const handleSyncToken = async (token: string) => {
    setBusy(`sync-${token}`); setBanner(null);
    try { safeUnwrap(await updateSelf("syncBalance", [token])); await refreshState(); setBanner({ kind: "success", text: `Updated ${shortenPrincipal(token)} from its live ledger.` }); }
    catch (error) { setBanner({ kind: "error", text: `Token sync failed: ${errorMessage(error)}` }); }
    finally { setBusy(null); }
  };
  const handleSyncAll = async () => {
    setBusy("sync-all"); setBanner(null);
    try {
      const results = await updateSelf("syncAllBalances", [null]) as unknown as Array<{ ok?: unknown; err?: JsonValue }>;
      await refreshState();
      const failures = results
        .map((r, i) => (r && "err" in r && r.err !== undefined ? { index: i, err: r.err } : null))
        .filter((r): r is { index: number; err: JsonValue } => r !== null);
      if (failures.length > 0) {
        const failedDetails = failures.map((f) => `token #${f.index}: ${errorMessage(f.err)}`).join("; ");
        setBanner({ kind: "error", text: `Sync completed with ${failures.length} failure(s): ${failedDetails}` });
      } else {
        setBanner({ kind: "success", text: `All balances synchronized from live ledgers.` });
      }
    }
    catch (error) { setBanner({ kind: "error", text: `Sync all failed: ${errorMessage(error)}` }); }
    finally { setBusy(null); }
  };
  const handleApproveTicket = async (ticket: Ticket) => {
    setBusy(`ticket-${ticket.id}`); setBanner(null);
    try {
      const result = await updateSelf("approveTicket", [String(ticket.id)]);
      safeUnwrap(result);
      await refreshState();
      const liveState = (await querySelf("getVaultState", [null])) as unknown as VaultState;
      const liveTicket = liveState.pending.find((t) => t.id === ticket.id);
      if (liveTicket?.timelockUntil != null) {
        setBanner({ kind: "info", text: `Ticket #${ticket.id} approved. Settlement deferred until timelock expires.` });
      } else {
        setBanner({ kind: "success", text: `Ticket #${ticket.id} approved and settled.` });
      }
    }
    catch (error) { setBanner({ kind: "error", text: `Ticket #${ticket.id} was not settled: ${errorMessage(error)}` }); }
    finally { setBusy(null); }
  };
  const handleRejectTicket = async (ticket: Ticket, reason: string = "Owner rejected") => {
    setBusy(`ticket-${ticket.id}`); setBanner(null);
    try { safeUnwrap(await updateSelf("rejectTicket", [[String(ticket.id), reason]])); await refreshState(); setBanner({ kind: "info", text: `Ticket #${ticket.id} rejected.` }); }
    catch (error) { setBanner({ kind: "error", text: `Ticket #${ticket.id} could not be rejected: ${errorMessage(error)}` }); }
    finally { setBusy(null); }
  };
  const handleExecuteTimelocked = async (ticket: Ticket) => {
    setBusy(`ticket-${ticket.id}`); setBanner(null);
    try { safeUnwrap(await updateSelf("executeTimelockedTicket", [String(ticket.id)])); await refreshState(); setBanner({ kind: "success", text: `Ticket #${ticket.id} executed and settled.` }); }
    catch (error) { setBanner({ kind: "error", text: `Ticket #${ticket.id} could not be executed: ${errorMessage(error)}` }); }
    finally { setBusy(null); }
  };
  const handleCancelTimelocked = async (ticket: Ticket, reason: string = "Owner canceled timelock") => {
    setBusy(`ticket-${ticket.id}`); setBanner(null);
    try { safeUnwrap(await updateSelf("cancelTimelockedTicket", [[String(ticket.id), reason]])); await refreshState(); setBanner({ kind: "info", text: `Ticket #${ticket.id} timelock canceled.` }); }
    catch (error) { setBanner({ kind: "error", text: `Ticket #${ticket.id} could not be canceled: ${errorMessage(error)}` }); }
    finally { setBusy(null); }
  };
  const handleRecoverLock = async () => {
    setBusy("recover"); setBanner(null);
    try {
      unwrapOk(await updateSelf("recoverSettlementLock", []));
      await refreshState();
      // Re-read state (the closure variable is stale after refreshState)
      const liveState = (await querySelf("getVaultState", [null])) as unknown as VaultState;
      if (liveState.settlementLock === null) {
        setBanner({ kind: "success", text: "Settlement lock recovered." });
        setBusy(null);
      } else {
        // Multi-stage recovery — keep polling until the lock clears
        setBanner({ kind: "info", text: "Recovery step complete. Monitoring for additional stages…" });
        setBusy("recover-poll");
        recoveryPollRef.current = setInterval(() => {
          if (recoveryPollRef.current !== null) {
            void (async () => {
              try {
                unwrapOk(await updateSelf("recoverSettlementLock", []));
                await refreshState();
              } catch (error) {
                // Polling error — keep going; the useEffect cleanup handles lock clearance
              }
            })();
          }
        }, 10000);
      }
    } catch (error) {
      setBanner({ kind: "error", text: `Recovery failed: ${errorMessage(error)}` });
      setBusy(null);
    }
  };
  const handleUpdateLabels = async (labels: [string, string][]) => {
    setBusy("labels"); setBanner(null);
    try {
      safeUnwrap(await updateSelf("setRecipientLabels", [labels]));
      await refreshState();
      setBanner({ kind: "success", text: "Recipient labels saved on-chain." });
    } catch (error) {
      setBanner({ kind: "error", text: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };
  const handleProposeSwap = async (params: {
    fromToken: string;
    toToken: string;
    dex: string;
    amount: bigint;
    minReturn: bigint;
    slippageBps: bigint;
    quoteExpiresAt: string;
    reason: string;
  }) => {
    setBusy("swap"); setBanner(null);
    try {
      unwrapOk(await updateSelf("proposeSwap", [[
        params.fromToken, params.toToken, params.dex,
        params.amount.toString(), params.minReturn.toString(), params.slippageBps.toString(),
        params.quoteExpiresAt, params.reason,
      ]]));
      await refreshState();
      setBanner({ kind: "info", text: "Swap proposal created and parked for owner approval." });
    } catch (error) {
      setBanner({ kind: "error", text: `Swap proposal failed: ${errorMessage(error)}` });
    } finally {
      setBusy(null);
    }
  };
  const handleSyncPrices = async () => {
    setSyncPrices(true); setBanner(null);
    try {
      const raw = (await updateSelf("getPortfolioValue", [null])) as unknown as TokenValuation[];
      setPortfolioValues(raw ?? []);
    } catch (error) {
      setBanner({ kind: "error", text: `Could not refresh prices: ${errorMessage(error)}` });
    } finally {
      setSyncPrices(false);
    }
  };
  const handleProposeTransfers = async (proposals: { token: string; recipient: string; amount: string; reason: string }[]) => {
    setBusy("transfers"); setBanner(null);
    try {
      unwrapOk(await updateSelf("proposeTransfers", [proposals]));
      await refreshState();
      setBanner({ kind: "info", text: "Batch transfer proposal created and parked for owner approval." });
    } catch (error) {
      setBanner({ kind: "error", text: `Batch transfer proposal failed: ${errorMessage(error)}` });
    } finally {
      setBusy(null);
    }
  };
  const handleLoadMoreActivity = useCallback(async () => {
    setBusy("load-more"); setBanner(null);
    try {
      const raw = await querySelf("getActivityHistory", [[String(100), String(auditOffset)]]);
      const page = (raw as unknown as AuditEntry[]) ?? [];
      setExtraAudit((prev) => [...page, ...prev]);
      setAuditOffset((prev) => prev + 100);
      setHasMoreActivity(page.length === 100);
    } catch (error) {
      setBanner({ kind: "error", text: `Could not load activity history: ${errorMessage(error)}` });
    } finally {
      setBusy(null);
    }
  }, [auditOffset]);

  const handleExportCsv = useCallback(async () => {
    setBusy("export-csv"); setBanner(null);
    try {
      let all: AuditEntry[] = [];
      let offset = 0;
      while (true) {
        const raw = await querySelf("getActivityHistory", [[String(100), String(offset)]]);
        const page = safeUnwrap<AuditEntry[]>(raw) ?? (Array.isArray(raw) ? (raw as unknown as AuditEntry[]) : []);
        all = all.concat(page);
        if (page.length < 100) break;
        offset += 100;
      }
      const csv = exportAuditToCsv(all, state?.balances ?? [], state?.recipientLabels ?? []);
      downloadFile(`agent-vault-audit-${Date.now()}.csv`, csv, "text/csv");
    } catch (error) {
      console.error("CSV Export Error:", error);
    } finally {
      setBusy(null);
    }
  }, [state?.balances]);

  const handleSelectView = (view: Workspace) => {
    if (activeView === "policy" && policyDraft && state) {
      if (isPolicyDraftDirty(state.policy, policyDraft, state.balances)) {
        setPendingView(view);
        return;
      }
    }
    setActiveView(view);
    if (state) {
      setPolicyDraft(makePolicyDraft(state.policy, state.balances));
    }
  };

  if (loading || !state) return <div className="console-app loading-screen"><div className="app-loading"><div className="loading-mark"><IconVault className="pb-spin" /></div><div className="loading-copy"><span className="eyebrow">Agent Vault</span><strong>Connecting to live custody</strong><span>Loading on-chain state through the Neutron kernel…</span></div></div></div>;

  const hasLock = state.settlementLock !== null;
  const viewIndex = activeView === "command" ? 0 : activeView === "policy" ? 1 : activeView === "swap" ? 2 : activeView === "activity" ? 3 : activeView === "approvals" ? 4 : 5;

  return <div className="console-app" data-context={ctx?.tileType ?? "dashboard"}>
    <div className="fluid-orb-1" />
    <div className="fluid-orb-2" />
    <header className="console-topbar">
      <button type="button" className="brand-lockup" onClick={() => handleSelectView("command")} aria-label="Open command center"><span className="brand-glyph"><IconVault /></span><span><strong>Agent Vault</strong><small>operator console</small></span></button>
      <div className="topbar-status"><span className={`status-dot ${state.policy.circuitBreaker ? "danger" : "live"}`} /><span>{state.policy.circuitBreaker ? "Breaker active" : "Guard active"}</span><code title={state.depositAccount.owner}>{shortenPrincipal(state.depositAccount.owner)}</code></div>
      <button type="button" className="icon-button topbar-refresh" title="Refresh on-chain state" aria-label="Refresh on-chain state" onClick={() => void refreshState()} disabled={busy !== null}><IconRefresh className={busy ? "pb-spin" : ""} /></button>
    </header>
    <div className="console-body">
      <aside className="desktop-nav" aria-label="Workspace navigation">
        <div className="active-indicator" style={{ transform: `translateY(${viewIndex * 47}px)` }} />
        <NavButton view="command" active={activeView} onSelect={handleSelectView} icon={<IconVault />} label="Command center" />
        <NavButton view="policy" active={activeView} onSelect={handleSelectView} icon={<IconSliders />} label="Policy" />
        <NavButton view="swap" active={activeView} onSelect={handleSelectView} icon={<IconSwap />} label="Swap" />
        <NavButton view="activity" active={activeView} onSelect={handleSelectView} icon={<IconActivity />} label="Activity" badge={state.audit.length} />
        <NavButton view="approvals" active={activeView} onSelect={handleSelectView} icon={<IconInbox />} label="Approvals" badge={state.pending.length} />
        <NavButton view="skill" active={activeView} onSelect={handleSelectView} icon={<IconDownload />} label="Agent Skill" />
      </aside>
      <main className="console-main">
        {state.settlementInFlight && <div className="global-alert warning"><IconRefresh className="pb-spin" /><span>A settlement is in flight. Keep this console open until the outcome is known.</span></div>}
        {hasLock && <div className="global-alert danger"><IconInbox /><span>Settlement reconciliation is locked. Review the recorded activity before recovery.</span><button type="button" className="text-button" onClick={() => handleSelectView("activity")}>Open activity</button></div>}
        {banner && <div className={`notice-banner ${banner.kind}`} role={banner.kind === "error" ? "alert" : "status"}><span>{banner.text}</span><button type="button" className="icon-button" onClick={() => setBanner(null)} aria-label="Dismiss notification">×</button></div>}
        {activeView === "command" && <CommandCenter state={state} onNavigate={(view) => handleSelectView(view as Workspace)} onRefresh={refreshState} onSync={handleSyncToken} onSyncAll={handleSyncAll} onRecover={handleRecoverLock} onProposeSwap={handleProposeSwap} onProposeTransfers={handleProposeTransfers} portfolioValue={portfolioValues} syncPrices={syncPrices} onSyncPrices={handleSyncPrices} busy={busy} />}
        {activeView === "policy" && policyDraft && <PolicyPanel state={state} busy={busy} onUpdate={handleUpdate} onUpdateLabels={handleUpdateLabels} draft={policyDraft} onChangeDraft={setPolicyDraft as unknown as React.Dispatch<React.SetStateAction<PolicyDraft>>} />}
        {activeView === "swap" && <SwapWorkspace state={state} busy={busy} onProposeSwap={handleProposeSwap} />}
        {activeView === "activity" && <ActivityPanel audit={state.audit} extraAudit={extraAudit} balances={state.balances} labels={state.recipientLabels ?? []} onLoadMore={handleLoadMoreActivity} hasMore={hasMoreActivity} onExportCsv={handleExportCsv} />}
        {activeView === "approvals" && <ApprovalWorkspace tickets={state.pending} busy={busy} onApprove={handleApproveTicket} onReject={handleRejectTicket} onExecuteTimelocked={handleExecuteTimelocked} onCancelTimelocked={handleCancelTimelocked} balances={state.balances} labels={state.recipientLabels ?? []} />}
        {activeView === "skill" && <SkillExport state={state} />}
        <footer className="console-footer"><span>Agent Vault · Neutron custody protocol</span><span>Live ledger prices · USD via ICPSwap pools</span></footer>
      </main>
    </div>
    <nav className="mobile-nav" aria-label="Mobile workspace navigation">
      <div className="active-indicator-mobile" style={{ transform: `translateX(${viewIndex * 100}%)` }} />
      <NavButton view="command" active={activeView} onSelect={handleSelectView} icon={<IconVault />} label="Command" />
      <NavButton view="policy" active={activeView} onSelect={handleSelectView} icon={<IconSliders />} label="Policy" />
      <NavButton view="swap" active={activeView} onSelect={handleSelectView} icon={<IconSwap />} label="Swap" />
      <NavButton view="activity" active={activeView} onSelect={handleSelectView} icon={<IconActivity />} label="Activity" badge={state.audit.length} />
      <NavButton view="approvals" active={activeView} onSelect={handleSelectView} icon={<IconInbox />} label="Approvals" badge={state.pending.length} />
      <NavButton view="skill" active={activeView} onSelect={handleSelectView} icon={<IconDownload />} label="Skill" />
    </nav>
    {pendingView && (
      <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
        <div className="modal-container">
          <div className="modal-header">
            <IconAlertOctagon />
            <h3 id="confirm-dialog-title">Unsaved Policy Changes</h3>
          </div>
          <div className="modal-body">
            You have made changes to the vault guardrails. Do you want to discard your edits and leave the policy tab?
          </div>
          <div className="modal-actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setPendingView(null)}
            >
              Keep editing
            </button>
            <button
              type="button"
              className="button button-danger"
              onClick={() => {
                const target = pendingView;
                setPendingView(null);
                setActiveView(target);
                if (state) {
                  setPolicyDraft(makePolicyDraft(state.policy, state.balances));
                }
              }}
            >
              Discard changes
            </button>
          </div>
        </div>
      </div>
    )}
  </div>;
}

function NavButton({ view, active, onSelect, icon, label, badge }: { view: Workspace; active: Workspace; onSelect: (view: Workspace) => void; icon: React.ReactNode; label: string; badge?: number }) {
  return <button type="button" className={`nav-button ${active === view ? "active" : ""}`} onClick={() => onSelect(view)} aria-current={active === view ? "page" : undefined}>{icon}<span>{label}</span>{badge !== undefined && badge > 0 && <b>{badge}</b>}</button>;
}

const container = document.getElementById("root");
if (container) createRoot(container).render(
  <ErrorBoundary>
    <Dashboard />
  </ErrorBoundary>,
);
