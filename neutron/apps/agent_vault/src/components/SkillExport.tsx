import React, { useState } from "react";
import type { VaultState } from "../types";
import { generateAgentSkill } from "../utils/generateSkill";
import { IconDownload, IconLayers, IconShield } from "./Icons";

export function SkillExport({ state }: { state: VaultState }) {
  const [status, setStatus] = useState<"idle" | "generating" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleDownload = () => {
    setStatus("generating");
    setErrorMessage(null);
    try {
      const skill = generateAgentSkill(state);
      const blob = new Blob([skill.content], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = skill.filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setStatus("success");
      setTimeout(() => setStatus("idle"), 3000);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to generate skill");
      setStatus("error");
      setTimeout(() => setStatus("idle"), 5000);
    }
  };

  return (
    <div className="workspace-stack skill-export-workspace">
      <section className="workspace-heading">
        <div>
          <span className="eyebrow">Agent Skill</span>
          <h1>Generate Agent Skill</h1>
          <p>Download a CommandCode-compatible skill file pre-populated with your canister details, policy configuration, and interaction instructions.</p>
        </div>
      </section>

      <div className="pb-card">
        <div className="pb-card-header">
          <div className="pb-card-title-wrap">
            <h3 className="pb-card-title">
              <IconLayers />
              <span>Skill Export</span>
            </h3>
            <p className="pb-card-subtitle">
              Generates a markdown skill file with your live vault state — canister principal, deposit account, tracked tokens, velocity limits, allowlists, and error recovery guidance.
            </p>
          </div>
        </div>

        <div className="pb-skill-preview">
          <div className="pb-skill-row">
            <span className="pb-skill-label">Canister</span>
            <span className="pb-skill-value">{state.depositAccount.owner}</span>
          </div>
          <div className="pb-skill-row">
            <span className="pb-skill-label">Custody Subaccount</span>
            <span className="pb-skill-value">
              {state.depositAccount.subaccount.length === 32
                ? `${state.depositAccount.subaccount.slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("")}…${state.depositAccount.subaccount.slice(-6).map((b) => b.toString(16).padStart(2, "0")).join("")}`
                : "non-zero 32-byte subaccount"}
            </span>
          </div>
          <div className="pb-skill-row">
            <span className="pb-skill-label">Tracked Tokens</span>
            <span className="pb-skill-value">{state.balances.length > 0 ? state.balances.length : "0 (none synced)"}</span>
          </div>
          <div className="pb-skill-row">
            <span className="pb-skill-label">Velocity Limits</span>
            <span className="pb-skill-value">{state.policy.limits.length > 0 ? state.policy.limits.length : "0 (none configured)"}</span>
          </div>
          <div className="pb-skill-row">
            <span className="pb-skill-label">Circuit Breaker</span>
            <span className={`pb-skill-value ${state.policy.circuitBreaker ? "danger" : "live"}`}>
              {state.policy.circuitBreaker ? "ACTIVE" : "Standby"}
            </span>
          </div>
        </div>

        {errorMessage && (
          <div className="inline-error" role="alert">
            {errorMessage}
          </div>
        )}

        {status === "success" && (
          <div className="notice-banner success" role="status">
            <span>Skill file downloaded successfully.</span>
          </div>
        )}

        <div className="pb-skill-actions">
          <button
            type="button"
            className="button button-primary"
            onClick={handleDownload}
            disabled={status === "generating"}
          >
            <IconDownload />
            {status === "generating" ? "Generating…" : "Download Agent Skill"}
          </button>
          <div className="pb-skill-caveat">
            <IconShield />
            <small>No private keys are included. The skill contains only public on-chain configuration.</small>
          </div>
        </div>
      </div>
    </div>
  );
}
