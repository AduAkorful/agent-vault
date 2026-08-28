import React, { useState } from "react";
import { isAllowedPair, isValidPrincipal, KNOWN_PAIRS, KNOWN_PRINCIPALS, parseLines, parsePairs, shortenPrincipal } from "../utils";
import { CopyButton } from "./CopyButton";
import { IconAlertOctagon, IconArrowRight, IconCheck, IconPlus, IconTrash } from "./Icons";

function isIcpswapFactory(p: string): boolean {
  return p === "4mmnk-kiaaa-aaaag-qbllq-cai";
}

type Tab = "recipients" | "dexes" | "pairs";
export function AllowlistManager({ recipientsRaw, dexesRaw, pairsRaw, onChangeRecipients, onChangeDexes, onChangePairs }: { recipientsRaw: string; dexesRaw: string; pairsRaw: string; onChangeRecipients: (value: string) => void; onChangeDexes: (value: string) => void; onChangePairs: (value: string) => void }) {
  const [tab, setTab] = useState<Tab>("recipients");
  const [bulk, setBulk] = useState(false);
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const lines = tab === "recipients" ? parseLines(recipientsRaw) : tab === "dexes" ? parseLines(dexesRaw) : parsePairs(pairsRaw).map((pair) => `${pair.from},${pair.to}`);
  const validFirst = isValidPrincipal(first);
  const validSecond = tab !== "pairs" || isValidPrincipal(second);
  const duplicate = lines.includes(tab === "pairs" ? `${first.trim()},${second.trim()}` : first.trim());
  const selfPair = tab === "pairs" && first.trim() === second.trim() && first.trim().length > 0;
  const bulkValue = tab === "recipients" ? recipientsRaw : tab === "dexes" ? dexesRaw : pairsRaw;
  const setBulkValue = (value: string) => tab === "recipients" ? onChangeRecipients(value) : tab === "dexes" ? onChangeDexes(value) : onChangePairs(value);
  const bulkLines = tab === "pairs"
    ? parseLines(bulkValue).map((line) => line.split(",").map((s) => s.trim()))
    : parseLines(bulkValue);
  const invalidBulkCount = bulkLines.filter((parts) =>
    tab === "pairs"
      ? parts.length !== 2 || !isValidPrincipal(parts[0] ?? "") || !isValidPrincipal(parts[1] ?? "")
      : !isValidPrincipal(parts[0] ?? ""),
  ).length;

  const add = () => {
    const a = first.trim(); const b = second.trim();
    if (!validFirst || !validSecond || duplicate || selfPair) return;
    if (tab === "pairs") {
      if (!isAllowedPair(a, b)) return;
      onChangePairs([...lines, `${a},${b}`].join("\n"));
    } else if (tab === "recipients") onChangeRecipients([...lines, a].join("\n"));
    else onChangeDexes([...lines, a].join("\n"));
    setFirst(""); setSecond("");
  };
  const remove = (index: number) => {
    const next = lines.filter((_, i) => i !== index);
    if (tab === "recipients") onChangeRecipients(next.join("\n"));
    else if (tab === "dexes") onChangeDexes(next.join("\n"));
    else onChangePairs(next.join("\n"));
  };
  const labelFor = (line: string): string => tab === "pairs" ? line.split(",").map(shortenPrincipal).join(" \u2192 ") : (KNOWN_PRINCIPALS[line] ?? shortenPrincipal(line));

  return <div className="allowlist-manager">
    <div className="allowlist-toolbar">
      <div className="allowlist-tabs" role="tablist">
        {(["recipients", "dexes", "pairs"] as Tab[]).map((value) => (
          <button
            type="button"
            key={value}
            role="tab"
            aria-selected={tab === value}
            className={`allowlist-tab ${tab === value ? "active" : ""}`}
            onClick={() => { setTab(value); setFirst(""); setSecond(""); }}
          >
            {value === "recipients" ? "Recipients" : value === "dexes" ? "DEXs" : "Token pairs"}
            <b>{value === "recipients" ? parseLines(recipientsRaw).length : value === "dexes" ? parseLines(dexesRaw).length : parsePairs(pairsRaw).length}</b>
          </button>
        ))}
      </div>
      <button type="button" className="text-button" onClick={() => setBulk((value) => !value)}>
        {bulk ? "Use guided editor" : "Bulk edit"}
      </button>
    </div>

    {bulk ? (
      <label className="field bulk-field">
        <span>{tab === "pairs" ? "One fromPrincipal,toPrincipal per line" : "One principal per line"}</span>
        <textarea
          rows={5}
          value={bulkValue}
          onChange={(event) => setBulkValue(event.target.value)}
        />
        {invalidBulkCount > 0 && (
          <div className="allowlist-bulk-error">
            <IconAlertOctagon />
            <span>
              {invalidBulkCount} {invalidBulkCount === 1 ? "line" : "lines"} contain an invalid principal.
              Fix or remove them before saving.
            </span>
          </div>
        )}
      </label>
    ) : (
      <div className="allowlist-add">
        <div className="allowlist-inputs">
          <label className="field">
            <span>{tab === "pairs" ? "From principal" : tab === "dexes" ? "DEX principal" : "Recipient principal"}</span>
            <input
              value={first}
              onChange={(event) => setFirst(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }}
              placeholder="Paste an IC principal"
            />
          </label>
          {tab === "pairs" && (
            <>
              <IconArrowRight className="allowlist-arrow" />
              <label className="field">
                <span>To principal</span>
                <input
                  value={second}
                  onChange={(event) => setSecond(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }}
                  placeholder="Paste an IC principal"
                />
              </label>
            </>
          )}
        </div>
        <button
          type="button"
          className="button button-secondary"
          disabled={!validFirst || !validSecond || duplicate || selfPair}
          onClick={add}
        >
          <IconPlus /> Add
        </button>
      </div>
    )}
    {first && (
      <div className="allowlist-validation">
        {!validFirst || !validSecond ? <><IconAlertOctagon /> Invalid principal format</> : duplicate ? <><IconAlertOctagon /> Already saved</> : selfPair ? <><IconAlertOctagon /> A pair cannot target itself</> : tab === "dexes" && !isIcpswapFactory(first.trim()) ? <><IconAlertOctagon /> Only the ICPSwap factory is supported for swaps</> : <><IconCheck /> Ready to add</>}
      </div>
    )}

    <div className="allowlist-list">
      {lines.length === 0 ? (
        <div className="allowlist-empty">
          No {tab} allowlisted. Add a principal to create an explicit execution boundary.
        </div>
      ) : (
        lines.map((line, index) => (
          <div className="allowlist-row" key={`${line}-${index}`}>
            <div>
              <strong>{labelFor(line)}</strong>
              <code>{line}</code>
              {tab === "dexes" && !isIcpswapFactory(line) && (
                <span className="dex-warning"><IconAlertOctagon /> Not the ICPSwap factory — swaps will fail at settlement</span>
              )}
            </div>
            <div className="allowlist-actions">
              <CopyButton text={line} label="Copy" />
              <button
                type="button"
                className="icon-button danger-icon"
                title="Remove entry"
                aria-label={`Remove allowlist entry ${index + 1}`}
                onClick={() => remove(index)}
              >
                <IconTrash />
              </button>
            </div>
          </div>
        ))
      )}
    </div>

    {tab === "dexes" && (
      <div className="allowlist-presets">
        <span>Verified integration</span>
        <button
          type="button"
          className="preset-button"
          disabled={lines.includes("4mmnk-kiaaa-aaaag-qbllq-cai")}
          onClick={() => onChangeDexes([...lines, "4mmnk-kiaaa-aaaag-qbllq-cai"].join("\n"))}
        >
          <IconPlus /> ICPSwap Factory
        </button>
      </div>
    )}
    {tab === "pairs" && (
      <div className="allowlist-presets">
        <span>Known pairs</span>
        {KNOWN_PAIRS.map((pair) => {
          const value = `${pair.from},${pair.to}`;
          return (
            <button
              type="button"
              className="preset-button"
              key={value}
              disabled={lines.includes(value)}
              onClick={() => onChangePairs([...lines, value].join("\n"))}
            >
              <IconPlus /> {pair.label}
            </button>
          );
        })}
      </div>
    )}
  </div>;
}
