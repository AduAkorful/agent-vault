import React, { useMemo, useState } from "react";
import type { VaultState, Balance } from "../types";
import { formatAmountSafe, parseFriendlyAmount, shortenPrincipal, toPrincipalText } from "../utils";
import { IconArrowDown, IconChevronDown, IconGear, IconInfo, IconSearch, IconSwap, IconX } from "./Icons";

interface SwapFormProps {
  state: VaultState;
  busy: string | null;
  onPropose: (params: {
    fromToken: string;
    toToken: string;
    dex: string;
    amount: bigint;
    minReturn: bigint;
    slippageBps: bigint;
    quoteExpiresAt: string;
    reason: string;
  }) => Promise<void>;
}

export function SwapForm({ state, busy, onPropose }: SwapFormProps) {
  const [fromToken, setFromToken] = useState("");
  const [toToken, setToToken] = useState("");
  const [amount, setAmount] = useState("");
  const [minReturn, setMinReturn] = useState("");
  const [slippage, setSlippage] = useState("1.0");
  const [expiryMinutes, setExpiryMinutes] = useState("5");
  const [reason, setReason] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [tokenModalTarget, setTokenModalTarget] = useState<"from" | "to" | null>(null);
  const [tokenSearch, setTokenSearch] = useState("");

  const dexes = state.policy.allowlists.dexes;
  const dex = dexes[0] ? toPrincipalText(dexes[0]) : "";

  // Token candidates are derived only from the user's synced balances and the
  // policy's allowlisted pairs — never from a hardcoded list. If a principal
  // is in the allowlist but has no synced Balance yet, it still appears so
  // the user can see what they have allowlisted, but the row is marked
  // "Sync required" and the swap button stays disabled until sync happens.
  const allAvailableTokens = useMemo(() => {
    const set = new Set<string>();
    for (const b of state.balances) {
      set.add(toPrincipalText(b.token.id));
    }
    for (const pair of state.policy.allowlists.pairs) {
      set.add(toPrincipalText(pair.from));
      set.add(toPrincipalText(pair.to));
    }
    return Array.from(set);
  }, [state.balances, state.policy.allowlists.pairs]);

  const actualFromToken = fromToken;
  const actualToToken = toToken;

  const fromBalance = state.balances.find(
    (b) => toPrincipalText(b.token.id) === actualFromToken,
  );
  const fromDecimals = fromBalance?.token.decimals ?? null;
  const fromSymbol = fromBalance?.token.symbol ?? (actualFromToken ? shortenPrincipal(actualFromToken) : "Select token");
  const amountBase = parseFriendlyAmount(amount, fromDecimals);

  const toBalance = state.balances.find(
    (b) => toPrincipalText(b.token.id) === actualToToken,
  );
  const toDecimals = toBalance?.token.decimals ?? null;
  const toSymbol = toBalance?.token.symbol ?? (actualToToken ? shortenPrincipal(actualToToken) : "Select token");
  const minReturnBase = parseFriendlyAmount(minReturn, toDecimals);

  const handleFlipDirection = () => {
    const prevFrom = fromToken;
    const prevTo = toToken;
    const prevAmt = amount;
    const prevMin = minReturn;

    setFromToken(prevTo);
    setToToken(prevFrom);
    setAmount(prevMin);
    setMinReturn(prevAmt);
  };

  const handleSetMax = () => {
    if (fromBalance) {
      setAmount(formatAmountSafe(fromBalance.amount, fromDecimals, actualFromToken, "swap.max"));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalFrom = actualFromToken || fromToken;
    const finalTo = actualToToken || toToken;
    const finalReason = reason.trim() || `Swap ${fromSymbol} for ${toSymbol}`;
    if (!finalFrom || !finalTo || !dex || !amount || !minReturn) return;
    if (amountBase <= 0n) return;
    if (minReturnBase <= 0n) return;
    const slippageNum = Number(slippage);
    const expiryNum = Number(expiryMinutes);
    if (Number.isNaN(slippageNum) || slippageNum <= 0 || slippageNum > 100) return;
    if (Number.isNaN(expiryNum) || expiryNum < 1 || expiryNum > 60) return;
    const expiryNs = String(BigInt(Math.floor((Date.now() + Math.round(expiryNum) * 60_000)) * 1_000_000));
    await onPropose({
      fromToken: finalFrom,
      toToken: finalTo,
      dex,
      amount: amountBase,
      minReturn: minReturnBase,
      slippageBps: BigInt(Math.round(slippageNum * 100)),
      quoteExpiresAt: expiryNs,
      reason: finalReason,
    });
  };

  // Filter tokens for selection modal. Exclude the token already selected on
  // the opposite side. A search hit for a valid principal that isn't already
  // in the list is still added so the user can pick a freshly-typed principal
  // (the input boundary accepts it but the swap will fail at classification
  // until it is synced / allowlisted — same as in the unfiltered case).
  const filteredModalTokens = useMemo(() => {
    const query = tokenSearch.trim().toLowerCase();
    const list = allAvailableTokens.filter((principal) => {
      if (tokenModalTarget === "from" && principal === toToken) return false;
      if (tokenModalTarget === "to" && principal === fromToken) return false;
      const sym = (state.balances.find((b) => toPrincipalText(b.token.id) === principal)?.token.symbol ?? "").toLowerCase();
      const p = principal.toLowerCase();
      return !query || sym.includes(query) || p.includes(query);
    });
    if (query && query.includes("-") && !list.includes(query)) {
      return [...list, query];
    }
    return list;
  }, [allAvailableTokens, tokenSearch, state.balances, tokenModalTarget, fromToken, toToken]);

  const selectModalToken = (principal: string) => {
    if (tokenModalTarget === "from") {
      setFromToken(principal);
      if (toToken === principal) setToToken("");
    } else if (tokenModalTarget === "to") {
      setToToken(principal);
    }
    setTokenModalTarget(null);
    setTokenSearch("");
  };

  const submitDisabled =
    busy === "swap" ||
    !dex ||
    !actualFromToken ||
    !actualToToken ||
    !fromBalance ||
    !toBalance ||
    !amount ||
    amountBase <= 0n ||
    !minReturn ||
    minReturnBase <= 0n;

  const submitLabel = useMemo(() => {
    if (busy === "swap") return "Proposing swap…";
    if (!dex) return "No DEX allowlisted";
    if (!actualFromToken) return "Select a token";
    if (!actualToToken) return "Select destination token";
    if (!fromBalance) return "Sync source token first";
    if (!toBalance) return "Sync destination token first";
    if (!amount || amountBase <= 0n) return "Enter an amount";
    if (!minReturn || minReturnBase <= 0n) return "Enter minimum return";
    return "Propose Swap (Escalates to Approval)";
  }, [busy, dex, actualFromToken, actualToToken, fromBalance, toBalance, amount, amountBase, minReturn, minReturnBase]);

  return (
    <div className="surface surface-swap uniswap-widget-container">
      {/* Uniswap Header */}
      <div className="uniswap-header">
        <div className="uniswap-tabs">
          <button type="button" className="uniswap-tab is-active">
            Swap
          </button>
          <button type="button" className="uniswap-tab" onClick={() => setShowSettings(!showSettings)}>
            Limit
          </button>
          <button type="button" className="uniswap-tab" onClick={() => setShowSettings(!showSettings)}>
            Send
          </button>
        </div>
        <button
          type="button"
          className={`uniswap-gear-btn ${showSettings ? "is-open" : ""}`}
          title="Swap settings"
          onClick={() => setShowSettings(!showSettings)}
        >
          <IconGear />
        </button>
      </div>

      {/* Uniswap Settings Popover Panel */}
      {showSettings && (
        <div className="uniswap-settings-popover">
          <div className="uniswap-settings-header">
            <strong>Swap settings</strong>
            <button type="button" className="icon-button" onClick={() => setShowSettings(false)}>
              <IconX />
            </button>
          </div>
          <div className="uniswap-setting-item">
            <label>Slippage tolerance (%)</label>
            <div className="uniswap-preset-row">
              {["0.1", "0.5", "1.0", "2.0"].map((val) => (
                <button
                  type="button"
                  key={val}
                  className={`uniswap-chip ${slippage === val ? "is-selected" : ""}`}
                  onClick={() => setSlippage(val)}
                >
                  {val}%
                </button>
              ))}
              <input
                type="text"
                className="uniswap-chip-input"
                placeholder="Custom"
                value={slippage}
                onChange={(e) => setSlippage(e.target.value)}
              />
            </div>
          </div>

          <div className="uniswap-setting-item">
            <label>Quote expiry (minutes)</label>
            <div className="uniswap-preset-row">
              {["5", "10", "30"].map((val) => (
                <button
                  type="button"
                  key={val}
                  className={`uniswap-chip ${expiryMinutes === val ? "is-selected" : ""}`}
                  onClick={() => setExpiryMinutes(val)}
                >
                  {val}m
                </button>
              ))}
              <input
                type="number"
                min="1"
                max="60"
                className="uniswap-chip-input"
                value={expiryMinutes}
                onChange={(e) => setExpiryMinutes(e.target.value)}
              />
            </div>
          </div>

          <div className="uniswap-setting-item">
            <label>Proposal rationale</label>
            <input
              type="text"
              className="uniswap-setting-text"
              placeholder="Why is this swap proposed?"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>
      )}

      <form className="uniswap-form" onSubmit={handleSubmit}>
        {/* Sell / Source Token Card */}
        <div className="uniswap-card uniswap-card-sell">
          <div className="uniswap-card-top">
            <span className="uniswap-card-label">Sell</span>
            {fromBalance && (
              <span className="uniswap-balance-info">
                Balance: {formatAmountSafe(fromBalance.amount, fromDecimals, actualFromToken, "swap.sourceBalance")}{" "}
                <button type="button" className="uniswap-max-btn" onClick={handleSetMax}>
                  MAX
                </button>
              </span>
            )}
          </div>
          <div className="uniswap-input-row">
            <input
              type="text"
              inputMode="decimal"
              className="uniswap-amount-input"
              placeholder="0"
              value={amount}
              disabled={busy === "swap"}
              onChange={(e) => setAmount(e.target.value)}
            />
            <button
              type="button"
              className={`uniswap-token-pill ${!actualFromToken ? "is-unselected" : ""}`}
              onClick={() => setTokenModalTarget("from")}
            >
              {actualFromToken ? (
                <>
                  <span className="uniswap-token-badge">{fromSymbol.slice(0, 2)}</span>
                  <span className="uniswap-token-symbol">{fromSymbol}</span>
                  <IconChevronDown />
                </>
              ) : (
                <>
                  <span>Select token</span>
                  <IconChevronDown />
                </>
              )}
            </button>
          </div>
        </div>

        {/* Direction Flip Button */}
        <div className="uniswap-flip-container">
          <button
            type="button"
            className="uniswap-flip-btn"
            title="Swap direction"
            onClick={handleFlipDirection}
          >
            <IconArrowDown />
          </button>
        </div>

        {/* Buy / Target Token Card */}
        <div className="uniswap-card uniswap-card-buy">
          <div className="uniswap-card-top">
            <span className="uniswap-card-label">Buy (Min Return)</span>
            <span className="uniswap-est-tag">Est. output after fees</span>
          </div>
          <div className="uniswap-input-row">
            <input
              type="text"
              inputMode="decimal"
              className="uniswap-amount-input"
              placeholder="0"
              value={minReturn}
              disabled={busy === "swap"}
              onChange={(e) => setMinReturn(e.target.value)}
            />
            <button
              type="button"
              className={`uniswap-token-pill ${!actualToToken ? "is-unselected" : ""}`}
              onClick={() => setTokenModalTarget("to")}
            >
              {actualToToken ? (
                <>
                  <span className="uniswap-token-badge">{toSymbol.slice(0, 2)}</span>
                  <span className="uniswap-token-symbol">{toSymbol}</span>
                  <IconChevronDown />
                </>
              ) : (
                <>
                  <span>Select token</span>
                  <IconChevronDown />
                </>
              )}
            </button>
          </div>
        </div>

        {!dex && (
          <div className="swap-warning">
            <IconInfo /> No DEX is allowlisted. Add the ICPSwap factory in Policy → Approved counterparties.
          </div>
        )}

        {/* Action Submit Button */}
        <button
          type="submit"
          className="button uniswap-submit-btn"
          disabled={submitDisabled}
          onClick={(e) => void handleSubmit(e)}
        >
          {submitLabel}
        </button>
      </form>

      {/* Token Selection Modal */}
      {tokenModalTarget !== null && (
        <div className="uniswap-modal-backdrop" onClick={() => setTokenModalTarget(null)}>
          <div className="uniswap-modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="uniswap-modal-header">
              <h3>Select a token</h3>
              <button
                type="button"
                className="icon-button"
                onClick={() => setTokenModalTarget(null)}
              >
                <IconX />
              </button>
            </div>
            <div className="uniswap-modal-search-wrapper">
              <IconSearch />
              <input
                type="text"
                className="uniswap-modal-search"
                placeholder="Search name or principal"
                value={tokenSearch}
                onChange={(e) => setTokenSearch(e.target.value)}
                autoFocus
              />
            </div>
            <div className="uniswap-token-list">
              {filteredModalTokens.length === 0 ? (
                <div className="uniswap-no-tokens">
                  No allowlisted token pairs match your search.
                </div>
              ) : (
                filteredModalTokens.map((principal) => {
                  const bal = state.balances.find((b) => toPrincipalText(b.token.id) === principal);
                  const symbol = bal?.token.symbol ?? shortenPrincipal(principal);
                  const isSynced = bal !== undefined;
                  return (
                    <button
                      type="button"
                      key={principal}
                      className={`uniswap-token-option ${isSynced ? "" : "is-unsynced"}`}
                      onClick={() => selectModalToken(principal)}
                      title={isSynced ? undefined : "Sync this token to enable swaps"}
                    >
                      <div className="uniswap-token-option-avatar">
                        {symbol.slice(0, 2).toUpperCase()}
                      </div>
                      <div className="uniswap-token-option-main">
                        <strong>{symbol}</strong>
                        <span>{shortenPrincipal(principal)}</span>
                      </div>
                      {isSynced ? (
                        <div className="uniswap-token-option-bal">
                          {formatAmountSafe(bal.amount, bal.token.decimals, principal, "swap.candidateBalance")}
                        </div>
                      ) : (
                        <div className="uniswap-token-option-bal">Sync required</div>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
