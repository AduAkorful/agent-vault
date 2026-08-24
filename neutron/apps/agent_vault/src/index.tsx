// Agent Vault — dashboard tile.
//
// Four-panel vault dashboard: Portfolio, Policy, Activity, and Approvals.
// Data flows exclusively through the Neutron kernel client.

import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { cx, nt } from "neutron-design-system";
import {
  loadTileContext,
  querySelf,
  updateSelf,
  type JsonValue,
} from "neutron-tools/app";
import "./style.scss";

// ---------------------------------------------------------------------------
// Wire types — mirrors of the Motoko backend types (Candid-decoded JSON).
// ---------------------------------------------------------------------------

interface Token {
  id: string;
  symbol: string;
  decimals: number;
  standard: string;
  fee: bigint;
}

interface Balance {
  token: Token;
  amount: bigint;
  syncedAt: bigint;
}

interface TokenLimits {
  maxPerTx: bigint;
  maxHourlySpend: bigint;
  maxDailySpend: bigint;
}

interface TokenLimit {
  token: string;
  limits: TokenLimits;
}

interface Allowlists {
  recipients: string[];
  dexes: string[];
  pairs: { from: string; to: string }[];
}

interface Policy {
  limits: TokenLimit[];
  allowlists: Allowlists;
  circuitBreaker: boolean;
  failureThreshold: bigint;
  consecutiveFailures: bigint;
}

interface AuditEntry {
  id: bigint;
  action: JsonValue;
  tier: JsonValue;
  policyError: JsonValue;
  settlement: JsonValue;
  timestamp: bigint;
  ticketId: JsonValue;
  note: string;
}

interface Ticket {
  id: bigint;
  action: JsonValue;
  createdAt: bigint;
  policyError: JsonValue;
  status: JsonValue;
}

interface TokenSpend {
  token: string;
  hourly: bigint;
  daily: bigint;
}

interface VaultState {
  balances: Balance[];
  policy: Policy;
  spend: TokenSpend[];
  pending: Ticket[];
  audit: AuditEntry[];
  settlementInFlight: boolean;
  settlementLock: JsonValue;
  dexConfig: JsonValue;
  depositAccount: { owner: string; subaccount: number[] };
}

interface PolicyDraft {
  limits: { token: string; maxPerTx: string; maxHourlySpend: string; maxDailySpend: string }[];
  recipients: string;
  dexes: string;
  pairs: string;
  failureThreshold: string;
}

// ---------------------------------------------------------------------------
// Formatting utilities & safe numeric conversions
// ---------------------------------------------------------------------------

function toBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^[0-9]+$/.test(v.trim())) {
    return BigInt(v.trim());
  }
  throw new Error("Backend returned an invalid natural-number value");
}

/** Format a base-unit amount with the token's decimals (e.g. 100000000 + 8 decimals → "1"). */
function formatAmount(value: unknown, decimals: number | null): string {
  const bi = toBigInt(value);
  const str = bi.toString();
  if (decimals === null) return `${groupDigits(str)} base units`;
  const safeDecimals = Math.max(0, Math.min(decimals, 255));
  if (safeDecimals === 0) return groupDigits(str);
  const padded = str.padStart(safeDecimals + 1, "0");
  const whole = padded.slice(0, -safeDecimals);
  const fraction = padded.slice(-safeDecimals).replace(/0+$/, "");
  return fraction ? `${groupDigits(whole)}.${fraction}` : groupDigits(whole);
}

function groupDigits(v: string): string {
  return v.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Convert nanosecond timestamp to a human-readable local time string. */
function formatTimestamp(ns: unknown): string {
  try {
    const bi = toBigInt(ns);
    if (bi === 0n) return "—";
    const ms = Number(bi / 1_000_000n);
    return new Date(ms).toLocaleString();
  } catch {
    return "—";
  }
}

/** Extract the tag name from a Candid variant (e.g. { Autonomous: null } → "Autonomous"). */
function variantTag(v: JsonValue): string {
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    const keys = Object.keys(v as Record<string, unknown>);
    if (keys.length > 0) return keys[0]!;
  }
  return v === null ? "Unavailable" : String(v);
}

/** Extract action details from a transfer or swap variant. */
function actionSummary(action: JsonValue): { type: string; detail: string } {
  if (typeof action !== "object" || action === null || Array.isArray(action)) {
    return { type: "Unavailable", detail: "Action data unavailable" };
  }
  const obj = action as Record<string, JsonValue>;
  if ("transfer" in obj) {
    const t = obj.transfer as Record<string, JsonValue>;
    return {
      type: "Transfer",
      detail: `${String(t.amount ?? "Amount unavailable")} → ${shortenPrincipal(String(t.recipient ?? "Recipient unavailable"))}`,
    };
  }
  if ("swap" in obj) {
    const s = obj.swap as Record<string, JsonValue>;
    return {
      type: "Swap",
      detail: `${String(s.amount ?? "Amount unavailable")} on ${shortenPrincipal(String(s.dex ?? "DEX unavailable"))}`,
    };
  }
  return { type: variantTag(action), detail: "Action data unavailable" };
}

function shortenPrincipal(p: string): string {
  return p.length > 15 ? `${p.slice(0, 6)}…${p.slice(-4)}` : p;
}

function formatSubaccount(bytes: number[]): string {
  return bytes.map((byte) => Number(byte).toString(16).padStart(2, "0")).join("");
}

/** Check if a Candid optional ([T] | []) has a value. */
function optionalValue<T>(v: JsonValue): T | null {
  if (Array.isArray(v) && v.length > 0) return v[0] as T;
  return null;
}

function makePolicyDraft(policy: Policy): PolicyDraft {
  return {
    limits: policy.limits.map((entry) => ({
      token: entry.token,
      maxPerTx: toBigInt(entry.limits.maxPerTx).toString(),
      maxHourlySpend: toBigInt(entry.limits.maxHourlySpend).toString(),
      maxDailySpend: toBigInt(entry.limits.maxDailySpend).toString(),
    })),
    recipients: policy.allowlists.recipients.join("\n"),
    dexes: policy.allowlists.dexes.join("\n"),
    pairs: policy.allowlists.pairs.map((pair) => `${pair.from},${pair.to}`).join("\n"),
    failureThreshold: toBigInt(policy.failureThreshold).toString(),
  };
}

function parsePrincipalLines(value: string, label: string): string[] {
  const values = value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  for (const principal of values) {
    if (!/^[a-z0-9][a-z0-9-]{3,62}$/.test(principal)) throw new Error(`${label} contains an invalid principal: ${principal}`);
  }
  return [...new Set(values)];
}

function requireNatDraft(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) throw new Error(`${label} must be a positive integer in base units`);
  return normalized;
}

function policyArg(policy: Policy, draft: PolicyDraft): JsonValue {
  const limits = draft.limits.map((entry, index) => {
    const token = parsePrincipalLines(entry.token, `Token ${index + 1}`)[0];
    if (!token) throw new Error(`Token ${index + 1} principal is required`);
    const maxPerTx = requireNatDraft(entry.maxPerTx, `Token ${index + 1} per-transaction limit`);
    const maxHourlySpend = requireNatDraft(entry.maxHourlySpend, `Token ${index + 1} hourly limit`);
    const maxDailySpend = requireNatDraft(entry.maxDailySpend, `Token ${index + 1} daily limit`);
    if (BigInt(maxPerTx) > BigInt(maxHourlySpend) || BigInt(maxHourlySpend) > BigInt(maxDailySpend)) {
      throw new Error(`Token ${index + 1} limits must satisfy per transaction ≤ hourly ≤ daily`);
    }
    return { token, limits: { maxPerTx, maxHourlySpend, maxDailySpend } };
  });
  if (new Set(limits.map((entry) => entry.token)).size !== limits.length) throw new Error("Each token may have only one limit entry");

  const pairs = draft.pairs.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).map((line, index) => {
    const [from, to, ...rest] = line.split(",").map((value) => value.trim());
    if (!from || !to || rest.length > 0) throw new Error(`Pair ${index + 1} must be fromPrincipal,toPrincipal`);
    return {
      from: parsePrincipalLines(from, `Pair ${index + 1} input`)[0]!,
      to: parsePrincipalLines(to, `Pair ${index + 1} output`)[0]!,
    };
  });

  return {
    limits,
    allowlists: {
      recipients: parsePrincipalLines(draft.recipients, "Recipients"),
      dexes: parsePrincipalLines(draft.dexes, "DEX allowlist"),
      pairs,
    },
    circuitBreaker: policy.circuitBreaker,
    failureThreshold: requireNatDraft(draft.failureThreshold, "Failure threshold"),
    consecutiveFailures: toBigInt(policy.consecutiveFailures).toString(),
  };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

type View = "portfolio" | "policy" | "activity" | "approvals";

const VIEWS: { id: View; label: string; icon: string }[] = [
  { id: "portfolio", label: "Portfolio", icon: "◈" },
  { id: "policy", label: "Policy", icon: "⛨" },
  { id: "activity", label: "Activity", icon: "◷" },
  { id: "approvals", label: "Approvals", icon: "✓" },
];

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------

export const App = () => {
  const [state, setState] = useState<VaultState | null>(null);
  const [view, setView] = useState<View>("portfolio");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tileContext] = useState(() => loadTileContext());

  // Fetch vault state whenever mounted or refreshed.
  const refresh = useCallback(async () => {
    try {
      const raw = await querySelf("getVaultState", [null]);
      const unwrapped = unwrapResult(raw);
      setState(unwrapped as unknown as VaultState);
      setError(null);
    } catch (err: unknown) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Helpers for update calls.
  const doUpdate = useCallback(
    async (method: string, args: JsonValue[], key: string) => {
      setBusy(key);
      setError(null);
      try {
        unwrapResult(await updateSelf(method, args));
        await refresh();
      } catch (err: unknown) {
        setError(errorMessage(err));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const pendingCount = state ? state.pending.length : 0;

  return (
    <main className={cx(nt.appFill, "vault-app")}>
      <div className="vault-shell">
        {/* Navigation bar */}
        <nav className="vault-nav" aria-label="Dashboard views">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              className={cx("vault-nav-btn", { "vault-nav-btn--active": view === v.id })}
              onClick={() => setView(v.id)}
              aria-current={view === v.id ? "page" : undefined}
            >
              <span className="vault-nav-icon">{v.icon}</span>
              <span className="vault-nav-label">{v.label}</span>
              {v.id === "approvals" && pendingCount > 0 && (
                <span className="vault-badge">{pendingCount}</span>
              )}
            </button>
          ))}
        </nav>

        {/* Error banner */}
        {error && (
          <div className="vault-error" role="alert">
            <span className="vault-error-icon">⚠</span>
            <span>{error}</span>
            <button type="button" className="vault-error-dismiss" onClick={() => setError(null)}>✕</button>
          </div>
        )}

        {/* Settlement lock banner */}
        {state?.settlementInFlight && (
          <div className="vault-banner vault-banner--lock" role="status">
            ⏳ Settlement in flight — new proposals are rejected until the current operation is reconciled.
          </div>
        )}

        {/* Loading state */}
        {!state && !error && (
          <div className="vault-loading">
            <div className="vault-spinner" />
            <p className="nt-text">Loading vault state…</p>
          </div>
        )}

        {/* Panels */}
        {state && (
          <div className="vault-content">
            {view === "portfolio" && (
              <PortfolioPanel
                state={state}
                busy={busy}
                onSync={(token) => void doUpdate("syncBalance", [token], `sync-${token}`)}
              />
            )}
            {view === "policy" && (
              <PolicyPanel state={state} busy={busy} onUpdate={doUpdate} />
            )}
            {view === "activity" && (
              <ActivityPanel state={state} />
            )}
            {view === "approvals" && (
              <ApprovalsPanel state={state} busy={busy} onUpdate={doUpdate} />
            )}
          </div>
        )}

        {/* Footer */}
        <footer className="vault-footer">
          <dl className="nt-kv vault-context" aria-label="Tile context">
            {tileContext.app && <><dt>App</dt><dd>{tileContext.app}</dd></>}
            {tileContext.tile && <><dt>Tile</dt><dd>{tileContext.tile}</dd></>}
          </dl>
          <button
            type="button"
            className="nt-button nt-button--sm vault-refresh-btn"
            disabled={busy !== null}
            onClick={() => void refresh()}
          >
            ↻ Refresh
          </button>
        </footer>
      </div>
    </main>
  );
};

// ---------------------------------------------------------------------------
// Panel: Portfolio Overview
// ---------------------------------------------------------------------------

function PortfolioPanel({
  state,
  busy,
  onSync,
}: {
  state: VaultState;
  busy: string | null;
  onSync: (token: string) => void;
}) {
  const balances = state.balances;
  const policy = state.policy;
  const limits = policy.limits;
  const spend = state.spend;
  const balanceByToken = new Map<string, Balance>(balances.map((b) => [b.token.id, b]));
  const spendByToken = new Map<string, TokenSpend>(spend.map((s) => [s.token, s]));

  return (
    <section className="vault-panel" aria-label="Portfolio Overview">
      <header className="vault-panel-header">
        <h2 className="nt-title vault-panel-title">Portfolio Overview</h2>
        <div className="nt-tag-list">
          <span className="nt-tag">{balances.length} token{balances.length !== 1 ? "s" : ""}</span>
          {policy?.circuitBreaker && <span className="nt-tag nt-tag--danger">Circuit Breaker Active</span>}
        </div>
      </header>

      {/* Per-token spend budgets. Only tokens with configured limits have a
          budget to measure against; anything else always escalates. Each token's
          window is rendered in that token's own base units — never mixed. */}
      {limits.length === 0 ? (
        <div className="vault-empty vault-budgets-empty">
          <p className="nt-text">No per-token velocity limits configured — every proposal escalates to you for approval. Set limits in the Policy panel to enable autonomous settlement.</p>
        </div>
      ) : (
        <div className="vault-budgets">
          {limits.map((tl) => {
            const bal = balanceByToken.get(tl.token);
            const sp = spendByToken.get(tl.token);
            const decimals = bal ? bal.token.decimals : null;
            const symbol = bal ? bal.token.symbol : shortenPrincipal(tl.token);
            return (
              <div key={tl.token} className="vault-token-budget">
                <div className="vault-token-budget-head">
                  <span className="vault-token-symbol">{symbol}</span>
                  <span className="vault-token-principal" title={tl.token}>{shortenPrincipal(tl.token)}</span>
                </div>
                {sp ? (
                  <>
                    <BudgetBar label="Hourly" spent={toBigInt(sp.hourly)} limit={toBigInt(tl.limits.maxHourlySpend)} decimals={decimals} />
                    <BudgetBar label="Daily" spent={toBigInt(sp.daily)} limit={toBigInt(tl.limits.maxDailySpend)} decimals={decimals} />
                  </>
                ) : <span className="vault-field-help">Spend projection unavailable for this token.</span>}
              </div>
            );
          })}
        </div>
      )}

      <div className="vault-deposit-account">
        <div>
          <h3 className="vault-section-title">Vault Deposit Account</h3>
          <p className="nt-text vault-deposit-copy">Send supported ICRC tokens to this owner and subaccount. The subaccount keeps vault custody separate from the shared canister default account.</p>
        </div>
        <dl className="nt-kv vault-deposit-values">
          <dt>Owner</dt><dd className="vault-mono">{state.depositAccount.owner}</dd>
          <dt>Subaccount</dt><dd className="vault-mono vault-subaccount">{formatSubaccount(state.depositAccount.subaccount)}</dd>
        </dl>
      </div>

      {/* Token balances */}
      {balances.length === 0 ? (
        <div className="vault-empty">
          <p className="nt-text">No tokens synced yet. Use the agent tool <code>sync_balance</code> or add a token manually.</p>
        </div>
      ) : (
        <div className="vault-token-grid">
          {balances.map((b) => (
            <article key={b.token.id} className="vault-token-card">
              <div className="vault-token-header">
                <span className="vault-token-symbol">{b.token.symbol}</span>
                <span className="nt-tag nt-tag--sm">{b.token.standard}</span>
              </div>
              <div className="vault-token-amount">{formatAmount(b.amount, b.token.decimals)}</div>
              <div className="vault-token-meta">
                <span className="vault-token-principal" title={b.token.id}>{shortenPrincipal(b.token.id)}</span>
                <span className="vault-token-synced">Synced {formatTimestamp(b.syncedAt)}</span>
              </div>
              <button
                type="button"
                className="nt-button nt-button--sm vault-sync-btn"
                disabled={busy === `sync-${b.token.id}`}
                onClick={() => onSync(b.token.id)}
              >
                {busy === `sync-${b.token.id}` ? "Syncing…" : "↻ Sync"}
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function BudgetBar({
  label,
  spent,
  limit,
  decimals,
}: {
  label: string;
  spent: bigint;
  limit: bigint;
  decimals: number | null;
}) {
  const pct = limit > 0n ? Math.min(100, Number((spent * 100n) / limit)) : 0;
  const warn = pct >= 80;
  return (
    <div className="vault-budget">
      <div className="vault-budget-label">
        <span>{label}</span>
        <span className="vault-budget-ratio">
          {formatAmount(spent, decimals)} / {formatAmount(limit, decimals)}
        </span>
      </div>
      <div className="vault-budget-track">
        <div
          className={cx("vault-budget-fill", { "vault-budget-fill--warn": warn })}
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={label}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel: Policy Control Matrix
// ---------------------------------------------------------------------------

function PolicyPanel({
  state,
  busy,
  onUpdate,
}: {
  state: VaultState;
  busy: string | null;
  onUpdate: (method: string, args: JsonValue[], key: string) => Promise<void>;
}) {
  const policy = state.policy;
  const [draft, setDraft] = useState<PolicyDraft>(() => makePolicyDraft(policy));
  const [draftError, setDraftError] = useState<string | null>(null);
  const limits = policy.limits;
  const balances = state.balances;
  const failures = toBigInt(policy.consecutiveFailures);
  const threshold = toBigInt(policy.failureThreshold);
  const recipients = policy.allowlists.recipients;
  const dexes = policy.allowlists.dexes;
  const pairs = policy.allowlists.pairs;
  const toggleCircuitBreaker = () => {
    void onUpdate("setCircuitBreaker", [!policy.circuitBreaker], "circuit-breaker");
  };

  const savePolicy = async () => {
    setDraftError(null);
    try {
      await onUpdate("setPolicy", [policyArg(policy, draft)], "policy");
    } catch (error) {
      setDraftError(errorMessage(error));
    }
  };

  const updateLimit = (index: number, field: keyof PolicyDraft["limits"][number], value: string) => {
    setDraft((current) => ({
      ...current,
      limits: current.limits.map((entry, entryIndex) => entryIndex === index ? { ...entry, [field]: value } : entry),
    }));
  };

  const addLimit = () => {
    setDraft((current) => ({
      ...current,
      limits: [...current.limits, { token: "", maxPerTx: "", maxHourlySpend: "", maxDailySpend: "" }],
    }));
  };

  const removeLimit = (index: number) => {
    setDraft((current) => ({ ...current, limits: current.limits.filter((_, entryIndex) => entryIndex !== index) }));
  };

  return (
    <section className="vault-panel" aria-label="Policy Control Matrix">
      <header className="vault-panel-header">
        <h2 className="nt-title vault-panel-title">Policy Control Matrix</h2>
        <button type="button" className="nt-button nt-button--sm vault-btn-success" disabled={busy === "policy"} onClick={() => void savePolicy()}>
          {busy === "policy" ? "Saving…" : "Save policy"}
        </button>
      </header>

      {draftError && <div className="vault-inline-error" role="alert">{draftError}</div>}

      <div className="vault-safety-note">
        <strong>Execution boundary</strong>
        <span>Allowlisted transfers inside every token budget may settle autonomously. Swaps always require your approval.</span>
      </div>

      <div className="vault-policy-section">
        <h3 className="vault-section-title">Per-Token Velocity Limits</h3>
        {draft.limits.length === 0 ? (
          <div className="vault-empty">
            <p className="nt-text">No per-token limits configured. Every proposal escalates until you add a token budget.</p>
          </div>
        ) : (
          <div className="vault-token-limits">
            {draft.limits.map((entry, index) => (
              <article key={`${entry.token}-${index}`} className="vault-token-limit">
                <div className="vault-limit-editor-head">
                  <label className="vault-field"><span>Token principal</span><input value={entry.token} onChange={(event) => updateLimit(index, "token", event.target.value)} /></label>
                  <button type="button" className="nt-button nt-button--sm vault-btn-danger" onClick={() => removeLimit(index)}>Remove</button>
                </div>
                <div className="vault-policy-editor-grid">
                  <label className="vault-field"><span>Per transaction</span><input inputMode="numeric" value={entry.maxPerTx} onChange={(event) => updateLimit(index, "maxPerTx", event.target.value)} /></label>
                  <label className="vault-field"><span>Hourly spend</span><input inputMode="numeric" value={entry.maxHourlySpend} onChange={(event) => updateLimit(index, "maxHourlySpend", event.target.value)} /></label>
                  <label className="vault-field"><span>Daily spend</span><input inputMode="numeric" value={entry.maxDailySpend} onChange={(event) => updateLimit(index, "maxDailySpend", event.target.value)} /></label>
                </div>
                <span className="vault-field-help">Limits are token base units. Current balance metadata is queried live.</span>
              </article>
            ))}
          </div>
        )}
        <button type="button" className="nt-button nt-button--sm" onClick={addLimit}>Add token budget</button>
      </div>

      {/* Allowlists */}
      <div className="vault-policy-section">
        <h3 className="vault-section-title">Allowlists</h3>
        <label className="vault-field"><span>Recipients, one principal per line</span><textarea value={draft.recipients} onChange={(event) => setDraft((current) => ({ ...current, recipients: event.target.value }))} rows={3} /></label>
        <label className="vault-field"><span>DEXs, one principal per line</span><textarea value={draft.dexes} onChange={(event) => setDraft((current) => ({ ...current, dexes: event.target.value }))} rows={2} /></label>
        <label className="vault-field"><span>Token pairs, one fromPrincipal,toPrincipal per line</span><textarea value={draft.pairs} onChange={(event) => setDraft((current) => ({ ...current, pairs: event.target.value }))} rows={2} /></label>
        <div className="vault-policy-grid">
          <PolicyMetric label="Recipients" value={String(recipients.length)} unit="saved" />
          <PolicyMetric label="DEXs" value={String(dexes.length)} unit="saved" />
          <PolicyMetric label="Token Pairs" value={String(pairs.length)} unit="saved" />
        </div>
      </div>

      <div className="vault-policy-section">
        <h3 className="vault-section-title">Failure Threshold</h3>
        <label className="vault-field"><span>Consecutive settlement failures before the breaker trips</span><input inputMode="numeric" value={draft.failureThreshold} onChange={(event) => setDraft((current) => ({ ...current, failureThreshold: event.target.value }))} /></label>
      </div>

      {/* Circuit breaker */}
      <div className="vault-policy-section">
        <h3 className="vault-section-title">Circuit Breaker</h3>
        <div className="vault-circuit-breaker">
          <div className="vault-cb-status">
            <span className={cx("vault-cb-indicator", {
              "vault-cb-indicator--active": policy.circuitBreaker,
              "vault-cb-indicator--inactive": !policy.circuitBreaker,
            })} />
            <span>{policy.circuitBreaker ? "ACTIVE — All agent execution paused" : "Inactive — Agents operating normally"}</span>
          </div>
          <button
            type="button"
            className={cx("nt-button nt-button--sm", {
              "vault-btn-danger": !policy.circuitBreaker,
              "vault-btn-success": policy.circuitBreaker,
            })}
            disabled={busy === "circuit-breaker"}
            onClick={toggleCircuitBreaker}
          >
            {policy.circuitBreaker ? "Deactivate" : "Activate"}
          </button>
        </div>
        <div className="vault-failure-counter">
          Consecutive failures: <strong>{failures.toString()}</strong> / {threshold.toString()} (threshold)
        </div>
      </div>
    </section>
  );
}

function PolicyMetric({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <article className="nt-metric vault-policy-metric">
      <span className="nt-metric-label">{label}</span>
      <strong className="nt-metric-value">{groupDigits(value)}</strong>
      <span className="nt-metric-detail">{unit}</span>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Panel: Live Agent Audit Feed
// ---------------------------------------------------------------------------

function ActivityPanel({ state }: { state: VaultState }) {
  const audit = state.audit;
  const entries = useMemo(
    () => [...audit].reverse(),
    [audit],
  );

  return (
    <section className="vault-panel" aria-label="Agent Activity Feed">
      <header className="vault-panel-header">
        <h2 className="nt-title vault-panel-title">Agent Activity Feed</h2>
        <span className="nt-tag">{entries.length} entries</span>
      </header>

      {entries.length === 0 ? (
        <div className="vault-empty">
          <p className="nt-text">No activity yet. Agent proposals will appear here.</p>
        </div>
      ) : (
        <div className="vault-activity-list">
          {entries.map((entry) => (
            <ActivityRow key={String(entry.id)} entry={entry} />
          ))}
        </div>
      )}
    </section>
  );
}

function ActivityRow({ entry }: { entry: AuditEntry }) {
  const tier = variantTag(entry.tier);
  const { type, detail } = actionSummary(entry.action);
  const settlement = entry.settlement;
  const settlementTag = variantTag(settlement);
  const ticketId = optionalValue<bigint>(entry.ticketId);

  let statusClass = "vault-tier--autonomous";
  if (tier === "Escalation") statusClass = "vault-tier--escalation";
  if (tier === "Forbidden") statusClass = "vault-tier--forbidden";

  return (
    <article className="vault-activity-row">
      <div className="vault-activity-head">
        <span className={cx("vault-tier-badge", statusClass)}>{tier}</span>
        <span className="vault-activity-type">{type}</span>
        <time className="vault-activity-time">{formatTimestamp(entry.timestamp)}</time>
      </div>
      <div className="vault-activity-body">
        <span className="vault-activity-detail">{detail}</span>
        {ticketId !== null && (
          <span className="nt-tag nt-tag--sm">Ticket #{String(ticketId)}</span>
        )}
        {settlement && typeof settlement === "object" && !Array.isArray(settlement) && (
          <span className={cx("nt-tag nt-tag--sm", {
            "nt-tag--success": settlementTag === "success",
            "nt-tag--danger": settlementTag === "failure",
          })}>
            {settlementTag === "success" ? "✓ Settled" : "✕ Failed"}
          </span>
        )}
      </div>
      {entry.note && <div className="vault-activity-note">{entry.note}</div>}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Panel: Pending Approvals Inbox
// ---------------------------------------------------------------------------

function ApprovalsPanel({
  state,
  busy,
  onUpdate,
}: {
  state: VaultState;
  busy: string | null;
  onUpdate: (method: string, args: JsonValue[], key: string) => Promise<void>;
}) {
  const pending = state.pending;

  return (
    <section className="vault-panel" aria-label="Pending Approvals">
      <header className="vault-panel-header">
        <h2 className="nt-title vault-panel-title">Pending Approvals</h2>
        <span className="nt-tag">{pending.length} pending</span>
      </header>

      {pending.length === 0 ? (
        <div className="vault-empty">
          <p className="nt-text">No pending approvals. Tier-2 proposals will appear here for your review.</p>
        </div>
      ) : (
        <div className="vault-approvals-list">
          {pending.map((ticket) => (
            <TicketCard
              key={String(ticket.id)}
              ticket={ticket}
              busy={busy}
              onApprove={() => void onUpdate("approveTicket", [String(ticket.id)], `approve-${ticket.id}`)}
              onReject={() => void onUpdate("rejectTicket", [String(ticket.id), "Owner rejected"], `reject-${ticket.id}`)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function TicketCard({
  ticket,
  busy,
  onApprove,
  onReject,
}: {
  ticket: Ticket;
  busy: string | null;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { type, detail } = actionSummary(ticket.action);
  const policyErr = optionalValue<Record<string, unknown>>(ticket.policyError);
  const ticketKey = String(ticket.id);

  return (
    <article className="vault-ticket">
      <div className="vault-ticket-header">
        <span className="vault-ticket-id">Ticket #{ticketKey}</span>
        <span className="vault-ticket-type nt-tag nt-tag--sm">{type}</span>
        <time className="vault-ticket-time">{formatTimestamp(ticket.createdAt)}</time>
      </div>
      <div className="vault-ticket-detail">{detail}</div>
      {policyErr && (
        <div className="vault-ticket-reason">
          Policy: <code>{variantTag(policyErr as unknown as JsonValue)}</code>
        </div>
      )}
      <div className="vault-ticket-actions">
        <button
          type="button"
          className="nt-button nt-button--sm vault-btn-success"
          disabled={busy === `approve-${ticket.id}` || busy === `reject-${ticket.id}`}
          onClick={onApprove}
        >
          {busy === `approve-${ticket.id}` ? "Approving…" : "✓ Approve"}
        </button>
        <button
          type="button"
          className="nt-button nt-button--sm vault-btn-danger"
          disabled={busy === `approve-${ticket.id}` || busy === `reject-${ticket.id}`}
          onClick={onReject}
        >
          {busy === `reject-${ticket.id}` ? "Rejecting…" : "✕ Reject"}
        </button>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function unwrapResult(value: JsonValue): JsonValue {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, JsonValue>;
    if ("ok" in obj) return obj.ok!;
    if ("err" in obj) {
      const err = obj.err;
      const message =
        typeof err === "object" && err !== null && "message" in (err as Record<string, unknown>)
          ? String((err as Record<string, unknown>).message)
          : JSON.stringify(err);
      throw new Error(message);
    }
  }
  return value;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element not found");
}

const root = createRoot(container);
root.render(<App />);
