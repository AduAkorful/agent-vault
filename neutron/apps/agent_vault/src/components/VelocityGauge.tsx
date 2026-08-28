// Agent Vault — Velocity Gauge Animated Progress Indicator

import React from "react";
import { formatAmount } from "../utils";

export function VelocityGauge({
  label,
  spent,
  limit,
  decimals,
  symbol,
}: {
  label: string;
  spent: bigint;
  limit: bigint;
  decimals: number | null;
  symbol: string;
}) {
  const percent = limit > 0n ? Number((spent * 100n) / limit) : 0;
  const clamped = Math.min(100, Math.max(0, percent));
  const isHigh = clamped >= 75 && clamped < 100;
  const isMax = clamped >= 100;

  return (
    <div className="pb-gauge-wrap">
      <div className="pb-gauge-labels">
        <span className="pb-gauge-name">{label}</span>
        <span className="pb-gauge-stat">
          {formatAmount(spent, decimals)} / {formatAmount(limit, decimals)} {symbol} ({clamped}%)
        </span>
      </div>
      <div className="pb-gauge-track">
        <div
          className={`pb-gauge-fill ${isMax ? "danger" : isHigh ? "high" : ""}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}
