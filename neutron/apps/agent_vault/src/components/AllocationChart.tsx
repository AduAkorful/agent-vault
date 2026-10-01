import React from "react";
import type { Balance, TokenValuation } from "../types";
import { formatAmount, getPrincipalLabel, shortenPrincipal } from "../utils";

const CHART_COLORS = ["#e5a84b", "#62c48c", "#8bb8d9", "#ef767a", "#b39ddb", "#ffcc80", "#4fd8ff", "#9575cd"];

function donutSegmentPath(pct: number, offsetPct: number, radius: number, cx: number, cy: number): string {
  if (pct >= 99.95) {
    const r = radius;
    return `M ${cx - 0.01} ${cy - r} A ${r} ${r} 0 1 1 ${cx + 0.01} ${cy - r}`;
  }
  const startAngle = (offsetPct / 100) * 2 * Math.PI - Math.PI / 2;
  const endAngle = ((offsetPct + pct) / 100) * 2 * Math.PI - Math.PI / 2;
  const x1 = cx + radius * Math.cos(startAngle);
  const y1 = cy + radius * Math.sin(startAngle);
  const x2 = cx + radius * Math.cos(endAngle);
  const y2 = cy + radius * Math.sin(endAngle);
  const largeArc = pct > 50 ? 1 : 0;
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} L ${cx} ${cy} Z`;
}

// Format a USD valuation using the anchor ledger's decimals (provided by the
// backend in TokenValuation.usdDecimals). No fixed divisor; the decimals
// travel with the value. Returns "—" only when the backend explicitly signals
// the decimals are unknown (usdDecimals === 0), so the chart renders an
// honest "price unavailable" rather than guessing.
function formatUsd(value: bigint, usdDecimals: number): string {
  if (usdDecimals === 0) return "—";
  const formatted = formatAmount(value, usdDecimals);
  if (formatted === "0" || formatted === "") return "$0";
  // Anchor is ckUSDC, treated as $1. Add a `$` prefix to formatAmount output.
  return `$${formatted}`;
}

export function AllocationChart({
  balances,
  valuations,
  syncPrices,
  onSyncPrices,
}: {
  balances: Balance[];
  valuations: TokenValuation[] | null;
  syncPrices: boolean;
  onSyncPrices: () => Promise<void>;
}) {
  const items = React.useMemo(() => {
    if (!valuations) return [];
    return valuations.map((v) => {
      const bal = balances.find((b) => b.token.id === v.token);
      const balanceDecimals = bal?.token.decimals ?? null;
      const symbol = bal?.token.symbol ?? getPrincipalLabel(v.token) ?? shortenPrincipal(v.token);
      let balanceFormatted = "—";
      if (bal && balanceDecimals !== null) {
        try {
          balanceFormatted = formatAmount(v.balance, balanceDecimals);
        } catch {
          balanceFormatted = "—";
        }
      }
      return { symbol, tokenId: v.token, balanceFormatted, balanceDecimals, usdValue: v.usdValue, usdDecimals: v.usdDecimals };
    });
  }, [valuations, balances]);

  const totalUsd = React.useMemo(
    () => items.reduce((sum, i) => (i.usdDecimals > 0 ? sum + i.usdValue : sum), 0n),
    [items],
  );

  // Anchor decimals are the same for every entry in a single call (ckUSDC
  // today). If the backend returns mixed values, only the first non-zero
  // decimals drives formatting — this preserves the integrity of the total
  // even when the chart cannot agree on a divisor.
  const anchorDecimals = React.useMemo(() => {
    for (const i of items) {
      if (i.usdDecimals > 0) return i.usdDecimals;
    }
    return 0;
  }, [items]);

  const priced = React.useMemo(
    () =>
      items
        .filter((i) => i.usdDecimals > 0 && i.usdValue > 0n)
        .sort((a, b) => (b.usdValue > a.usdValue ? 1 : -1)),
    [items],
  );

  if (valuations === null) {
    return (
      <div className="allocation-placeholder">
        <div className="allocation-ring" />
        <strong>Pricing…</strong>
        <span>Deriving USD values from live ICPSwap pool reserves.</span>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="allocation-placeholder">
        <div className="allocation-ring" />
        <strong>No tracked assets</strong>
        <span>Fund the vault and sync balances to see USD-normalized allocation.</span>
      </div>
    );
  }

  if (priced.length === 0) {
    return (
      <div className="allocation-placeholder">
        <div className="allocation-ring" />
        <strong>Prices unavailable</strong>
        <span>No ICPSwap pool quotes could be derived for the current balances.</span>
        {!syncPrices && (
          <button type="button" className="button button-secondary button-sm" onClick={() => void onSyncPrices()}>
            Refresh prices
          </button>
        )}
      </div>
    );
  }

  let offset = 0;

  return (
    <div className="allocation-content">
      <div className="allocation-chart">
        <svg className="allocation-donut" viewBox="0 0 100 100">
          {priced.map((item) => {
            const pct = totalUsd > 0n
              ? Number((item.usdValue * 1000000n) / totalUsd) / 1000
              : 0;
            const index = priced.indexOf(item);
            const path = donutSegmentPath(pct, offset, 40, 50, 50);
            offset += pct;
            return <path key={item.tokenId} d={path} fill={CHART_COLORS[index % CHART_COLORS.length]} stroke="var(--ink)" strokeWidth="0.4" />;
          })}
        </svg>
        <div className="allocation-total">
          <span className="allocation-total-label">USD</span>
          <span className="allocation-total-value">{formatUsd(totalUsd, anchorDecimals)}</span>
        </div>
      </div>
      <div className="allocation-legend">
        {priced.map((item) => {
          const pct = totalUsd > 0n
            ? Number((item.usdValue * 1000000n) / totalUsd) / 1000
            : 0;
          const index = priced.indexOf(item);
          return (
            <div className="allocation-legend-row" key={item.tokenId}>
              <span className="allocation-swatch" style={{ background: CHART_COLORS[index % CHART_COLORS.length] }} />
              <span className="allocation-legend-label">{item.symbol}</span>
              <span className="allocation-legend-value">{item.balanceFormatted} {item.symbol}</span>
              <span className="allocation-legend-pct">{formatUsd(item.usdValue, item.usdDecimals)} ({pct.toFixed(0)}%)</span>
            </div>
          );
        })}
      </div>
      {syncPrices && (
        <button type="submit" className="button button-secondary button-sm" disabled>
          <span className="spinner" /> Pricing
        </button>
      )}
    </div>
  );
}
