import React, { useEffect, useState } from "react";
import type { JsonValue } from "neutron-tools/app";
import type { PolicyDraft, VaultState } from "../types";
import { errorMessage, isPolicyNameValid, makePolicyDraft, policyArg, toBigInt, validatePolicyDraft } from "../utils";
import { IconAlertOctagon, IconCheck, IconPlus, IconShield, IconTrash, IconZap } from "./Icons";
import { AllowlistManager } from "./AllowlistManager";

export function PolicyPanel({ state, busy, onUpdate, draft, onChangeDraft }: { state: VaultState; busy: string | null; onUpdate: (method: string, args: JsonValue[], key: string) => Promise<void>; draft: PolicyDraft; onChangeDraft: React.Dispatch<React.SetStateAction<PolicyDraft>> }) {
  const policy = state.policy;
  const activeProfile = state.policies.find((profile) => profile.id === state.activePolicyId);
  const [profileName, setProfileName] = useState(activeProfile?.name ?? "");
  const [draftError, setDraftError] = useState<string | null>(null);
  const failures = toBigInt(policy.consecutiveFailures);
  const threshold = toBigInt(policy.failureThreshold);
  useEffect(() => { setProfileName(activeProfile?.name ?? ""); }, [activeProfile?.id, activeProfile?.name]);

  const savePolicy = async () => {
    setDraftError(null);
    if (!isPolicyNameValid(profileName)) { setDraftError("Profile name must be 1–64 characters."); return; }
    const errors = validatePolicyDraft(draft, state.balances);
    if (errors.length) { setDraftError(errors.join(" ")); return; }
    try {
      if (!activeProfile) throw new Error("Active policy profile is unavailable.");
      await onUpdate("updatePolicyProfile", [[String(activeProfile.id), profileName, policyArg(policy, draft, state.balances)]], "policy");
    }
    catch (error) { setDraftError(errorMessage(error)); }
  };
  const saveAsNewProfile = async () => {
    setDraftError(null);
    if (!isPolicyNameValid(profileName)) { setDraftError("Profile name must be 1–64 characters."); return; }
    const errors = validatePolicyDraft(draft, state.balances);
    if (errors.length) { setDraftError(errors.join(" ")); return; }
    const name = profileName.trim() === activeProfile?.name ? `${profileName.trim()} Copy` : profileName.trim();
    try { await onUpdate("createPolicyProfile", [[name, policyArg(policy, draft, state.balances)]], "policy"); }
    catch (error) { setDraftError(errorMessage(error)); }
  };
  const selectProfile = async (id: string) => {
    if (id === String(state.activePolicyId)) return;
    try { await onUpdate("setActivePolicyProfile", [id], "policy"); }
    catch (error) { setDraftError(errorMessage(error)); }
  };
  const deleteProfile = async (targetId?: string) => {
    const inactive = state.policies.find((p) => p.id !== state.activePolicyId);
    const idToDelete = targetId ?? (activeProfile?.id !== state.activePolicyId ? activeProfile?.id : inactive?.id);
    if (!idToDelete) { setDraftError("Cannot delete the only remaining policy profile."); return; }
    try { await onUpdate("deletePolicyProfile", [String(idToDelete)], "policy"); }
    catch (error) { setDraftError(errorMessage(error)); }
  };
  const updateLimit = (index: number, field: keyof PolicyDraft["limits"][number], value: string) => onChangeDraft((current) => ({ ...current, limits: current.limits.map((entry, i) => i === index ? { ...entry, [field]: value } : entry) }));
  const addLimit = () => onChangeDraft((current) => ({ ...current, limits: [...current.limits, { token: "", maxPerTx: "", maxHourlySpend: "", maxDailySpend: "" }] }));
  const removeLimit = (index: number) => onChangeDraft((current) => ({ ...current, limits: current.limits.filter((_, i) => i !== index) }));
  const toggleCircuitBreaker = () => {
    void onUpdate("setCircuitBreaker", [!policy.circuitBreaker], "circuit-breaker");
  };

  return <div className="workspace-stack policy-workspace">
     <section className="workspace-heading"><div><span className="eyebrow">Policy</span><h1>Guardrails</h1><p>Shape the boundaries for autonomous transfers and owner-approved swaps.</p></div><div className="policy-profile-controls"><label className="field"><span>Active profile</span><select value={String(state.activePolicyId)} onChange={(event) => void selectProfile(event.target.value)} disabled={busy === "policy"}>{state.policies.map((profile) => <option key={String(profile.id)} value={String(profile.id)}>{profile.name} · v{String(profile.revision)}</option>)}</select></label><label className="field"><span>Profile name</span><input value={profileName} onChange={(event) => setProfileName(event.target.value)} /></label><div className="button-row"><button type="button" className="button button-primary" disabled={busy === "policy"} onClick={() => void savePolicy()}><IconCheck /> {busy === "policy" ? "Saving…" : "Save profile"}</button><button type="button" className="button button-secondary" disabled={busy === "policy"} onClick={() => void saveAsNewProfile()}>Save as new</button><button type="button" className="button button-danger" disabled={busy === "policy" || state.policies.length <= 1} onClick={() => void deleteProfile()}><IconTrash /> Delete</button></div></div></section>
    <section className="policy-intro surface"><IconShield /><div><strong>Execution boundary</strong><p>Allowlisted transfers inside every fee-inclusive token budget may settle autonomously. Over-budget transfers, unlisted recipients, and every non-zero swap wait for explicit approval.</p></div></section>
    {draftError && <div className="inline-error" role="alert">{draftError}</div>}
    <div className="policy-sections">
      <details className="policy-section surface" open><summary><span><IconZap /> Token budgets</span><small>{draft.limits.length} configured</small></summary><div className="policy-section-body"><p className="section-copy">Use token values (e.g. 200). Decimals are converted automatically based on synced ledger metadata. Keep each transaction below hourly, and hourly below daily.</p>{draft.limits.length === 0 ? <div className="empty-state compact"><div className="empty-icon"><IconZap /></div><strong>No token budgets</strong><span>Every proposal will escalate until a token budget is configured.</span></div> : <div className="policy-limit-list">{draft.limits.map((entry, index) => <div key={`limit-row-${index}`} className="policy-limit-row"><div className="policy-limit-head"><label className="field field-wide"><span>Token principal</span><input type="text" placeholder="xevnm-gaaaa-aaaar-qafnq-cai" value={entry.token} onChange={(e) => updateLimit(index, "token", e.target.value)} /></label><button type="button" className="icon-button danger-icon" onClick={() => removeLimit(index)} title="Remove token budget" aria-label={`Remove token budget ${index + 1}`}><IconTrash /></button></div><div className="policy-limit-grid"><label className="field"><span>Per transaction</span><input value={entry.maxPerTx} onChange={(e) => updateLimit(index, "maxPerTx", e.target.value)} /></label><label className="field"><span>Hourly spend</span><input value={entry.maxHourlySpend} onChange={(e) => updateLimit(index, "maxHourlySpend", e.target.value)} /></label><label className="field"><span>Daily spend</span><input value={entry.maxDailySpend} onChange={(e) => updateLimit(index, "maxDailySpend", e.target.value)} /></label></div></div>)}</div>}<button type="button" className="button button-secondary" onClick={addLimit}><IconPlus /> Add token budget</button></div></details>
      <details className="policy-section surface" open><summary><span><IconShield /> Approved counterparties</span><small>Recipients, DEXs, pairs</small></summary><div className="policy-section-body"><p className="section-copy">Only allowlist principals and token pairs the agent may use. Values are checked before saving.</p><AllowlistManager recipientsRaw={draft.recipients} dexesRaw={draft.dexes} pairsRaw={draft.pairs} onChangeRecipients={(val) => onChangeDraft((c) => ({ ...c, recipients: val }))} onChangeDexes={(val) => onChangeDraft((c) => ({ ...c, dexes: val }))} onChangePairs={(val) => onChangeDraft((c) => ({ ...c, pairs: val }))} /></div></details>
      <details className="policy-section surface" open><summary><span><IconAlertOctagon /> Circuit breaker</span><small>{policy.circuitBreaker ? "Active" : "Standby"}</small></summary><div className="policy-section-body"><p className="section-copy">The breaker halts autonomous and owner-approved actions. Reset it only after reviewing the failure sequence and any settlement lock.</p><label className="field threshold-field"><span>Consecutive failures before trip</span><input inputMode="numeric" value={draft.failureThreshold} onChange={(e) => onChangeDraft((c) => ({ ...c, failureThreshold: e.target.value }))} /><small>{failures.toString()} failures recorded · threshold {threshold.toString()}</small></label><div className={`breaker-panel ${policy.circuitBreaker ? "tripped" : ""}`}><div><span className={`status-dot ${policy.circuitBreaker ? "danger" : "live"}`} /><strong>{policy.circuitBreaker ? "Emergency breaker active" : "Operations running"}</strong><p>{policy.circuitBreaker ? "All settlement actions are halted until the breaker is reset." : "The policy engine is accepting proposals under the configured guardrails."}</p></div><button type="button" className={`button ${policy.circuitBreaker ? "button-primary" : "button-danger"}`} disabled={busy === "circuit-breaker"} onClick={toggleCircuitBreaker}>{policy.circuitBreaker ? <><IconCheck /> Reset breaker</> : <><IconAlertOctagon /> Activate breaker</>}</button></div></div></details>
    </div>
  </div>;
}
