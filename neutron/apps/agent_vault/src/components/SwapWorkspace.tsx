import React from "react";
import type { VaultState } from "../types";
import { SwapForm } from "./SwapForm";
import { IconSwap } from "./Icons";

interface SwapWorkspaceProps {
  state: VaultState;
  busy: string | null;
  onProposeSwap: (params: {
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

export function SwapWorkspace({ state, busy, onProposeSwap }: SwapWorkspaceProps) {
  return (
    <div className="workspace-panel workspace-swap">
      <header className="panel-header">
        <div className="panel-title-row">
          <div className="panel-title-badge">
            <IconSwap />
          </div>
          <div>
            <h1>Token Swap</h1>
            <p>
              Propose token swaps on allowlisted DEXs and pairs. All non-zero swaps escalate to owner approval before settlement.
            </p>
          </div>
        </div>
      </header>

      <div className="swap-workspace-content">
        <SwapForm
          state={state}
          busy={busy}
          onPropose={onProposeSwap}
        />
      </div>
    </div>
  );
}
