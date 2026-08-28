import React, { useState } from "react";
import type { VaultState, Balance } from "../types";
import { formatAmount, parseFriendlyAmount, shortenPrincipal, toPrincipalText } from "../utils";
import { IconInfo, IconSwap } from "./Icons";

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
  const [slippage, setSlippage] = useState("1");
  const [minReturn, setMinReturn] = useState("");
  const [expiryMinutes, setExpiryMinutes] = useState("5");
  const [reason, setReason] = useState("");

  const dexes = state.policy.allowlists.dexes;
  const dex = dexes[0] ?? "";
  const dexLabel = dex ? `${shortenPrincipal(dex)} (ICPSwap)` : "No DEX configured";

  // Build pair options from allowlisted pairs
  const pairOptions = state.policy.allowlists.pairs.map((pair) => ({
    from: toPrincipalText(pair.from),
    to: toPrincipalText(pair.to),
  }));
  const fromOptions = Array.from(new Set(pairOptions.map((p) => p.from)));
  const toOptions = Array.from(
    new Set(pairOptions.filter((p) => p.from === fromToken).map((p) => p.to)),
  );

  const fromBalance = state.balances.find(
    (b) => toPrincipalText(b.token.id) === fromToken,
  );
  const fromDecimals = fromBalance?.token.decimals ?? null;
  const fromSymbol = fromBalance?.token.symbol ?? shortenPrincipal(fromToken);
  const amountBase = parseFriendlyAmount(amount, fromDecimals);

  const toBalance = state.balances.find(
    (b) => toPrincipalText(b.token.id) === toToken,
  );
  const toDecimals = toBalance?.token.decimals ?? null;
  const toSymbol = toBalance?.token.symbol ?? shortenPrincipal(toToken);
  const minReturnBase = parseFriendlyAmount(minReturn, toDecimals);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fromToken || !toToken || !dex || !amount || !minReturn || !reason) return;
    if (amountBase <= 0n) return;
    if (minReturnBase <= 0n) return;
    const slippageNum = Number(slippage);
    const expiryNum = Number(expiryMinutes);
    if (Number.isNaN(slippageNum) || slippageNum <= 0 || slippageNum > 10000) return;
    if (Number.isNaN(expiryNum) || expiryNum < 1 || expiryNum > 60) return;
    const expiryNs = String(BigInt(Math.floor((Date.now() + Math.round(expiryNum) * 60_000)) * 1_000_000));
    await onPropose({
      fromToken,
      toToken,
      dex,
      amount: amountBase,
      minReturn: minReturnBase,
      slippageBps: BigInt(Math.round(slippageNum * 100)),
      quoteExpiresAt: expiryNs,
      reason: reason || `Swap ${fromSymbol} for ${toSymbol}`,
    });
  };

  return (
    <div className="surface surface-swap">
      <div className="surface-header">
        <div>
          <div className="surface-label">
            <IconSwap /> Propose Token Swap
          </div>
          <p>
            Swaps always escalate for owner approval. Provide your
            minimum-return estimate; the backend validates it against a live DEX
            quote at settlement time.
          </p>
        </div>
      </div>

      <form className="swap-form" onSubmit={handleSubmit}>
        <div className="swap-field">
          <label>From Token</label>
          <select
            value={fromToken}
            disabled={busy === "swap"}
            onChange={(e) => {
              setFromToken(e.target.value);
              setToToken("");
            }}
          >
            <option value="">Select source token</option>
            {fromOptions.map((principal) => (
              <option key={principal} value={principal}>
                {shortenPrincipal(principal)} — {balanceSymbol(principal, state.balances)}
              </option>
            ))}
          </select>
        </div>

        {fromToken && (
          <div className="swap-field">
            <label>To Token</label>
            <select
              value={toToken}
              disabled={busy === "swap"}
              onChange={(e) => setToToken(e.target.value)}
            >
              <option value="">Select destination token</option>
              {toOptions.map((principal) => (
                <option key={principal} value={principal}>
                  {shortenPrincipal(principal)}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="swap-field">
          <label>Amount ({fromSymbol})</label>
          <input
            type="text"
            inputMode="decimal"
            placeholder="e.g. 10.5"
            value={amount}
            disabled={busy === "swap"}
            onChange={(e) => setAmount(e.target.value)}
          />
          {fromBalance && (
            <small style={{ color: "var(--muted)" }}>
              Balance: {formatAmount(fromBalance.amount, fromDecimals)} {fromSymbol}
            </small>
          )}
        </div>

        <div className="swap-field">
          <label>Min Return ({toSymbol})</label>
          <input
            type="text"
            inputMode="decimal"
            placeholder="e.g. 9.5"
            value={minReturn}
            disabled={busy === "swap"}
            onChange={(e) => setMinReturn(e.target.value)}
          />
          <small style={{ color: "var(--muted)" }}>
            Estimated output after fees. Validated against live DEX quote at
            approval time.
          </small>
        </div>

        <div className="swap-field">
          <label>Slippage Tolerance (%)</label>
          <input
            type="number"
            step="0.1"
            min="0.01"
            max="10"
            value={slippage}
            disabled={busy === "swap"}
            onChange={(e) => setSlippage(e.target.value)}
          />
          <small style={{ color: "var(--muted)" }}>
            Default 1%. The swap fails if the live quote deviates beyond this.
          </small>
        </div>

        <div className="swap-field">
          <label>Quote Expiry (minutes)</label>
          <input
            type="number"
            min="1"
            max="30"
            value={expiryMinutes}
            disabled={busy === "swap"}
            onChange={(e) => setExpiryMinutes(e.target.value)}
          />
        </div>

        <div className="swap-field">
          <label>Reason</label>
          <input
            type="text"
            placeholder="Why is this swap being proposed?"
            value={reason}
            disabled={busy === "swap"}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>

        {!dex && (
          <div className="swap-warning">
            <IconInfo /> No DEX is allowlisted. Add one in the Policy tab before
            proposing swaps.
          </div>
        )}

        <button
          type="submit"
          className="button button-primary swap-submit"
          disabled={
            busy === "swap" ||
            !fromToken ||
            !toToken ||
            !dex ||
            !amount ||
            !minReturn ||
            !reason
          }
        >
          {busy === "swap" ? "Proposing…" : "Propose Swap (Escalates to Approval)"}
        </button>
      </form>
    </div>
  );
}

function balanceSymbol(principal: string, balances: Balance[]): string {
  const bal = balances.find((b) => toPrincipalText(b.token.id) === principal);
  return bal ? bal.token.symbol : shortenPrincipal(principal);
}
