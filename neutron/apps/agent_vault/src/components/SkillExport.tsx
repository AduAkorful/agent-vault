import React, { useMemo, useState } from "react";
import type { VaultState } from "../types";
import { generateAgentSkill } from "../utils/generateSkill";
import { IconCheck, IconCopy, IconLayers, IconShield } from "./Icons";
import { copyTextToClipboard } from "./CopyButton";

export function SkillExport({ state }: { state: VaultState }) {
  const [copied, setCopied] = useState(false);

  const skill = useMemo(() => {
    try {
      return generateAgentSkill(state);
    } catch {
      return { filename: "agent_vault_skill.md", content: "" };
    }
  }, [state]);

  const handleCopy = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = copyTextToClipboard(skill.content);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="workspace-stack skill-export-workspace">
      <section className="workspace-heading">
        <div>
          <span className="eyebrow">Agent Skill</span>
          <h1>Agent Skill Export</h1>
          <p>Copy or view a CommandCode-compatible skill file pre-populated with your canister details, policy configuration, and interaction instructions.</p>
        </div>
        <div className="heading-actions">
          <button
            type="button"
            className={`button button-primary ${copied ? "button-copied" : ""}`}
            onClick={handleCopy}
            style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}
          >
            {copied ? <IconCheck /> : <IconCopy />}
            {copied ? "Copied to Clipboard!" : "Copy Agent Skill"}
          </button>
        </div>
      </section>

      <div className="pb-card">
        <div className="pb-card-header">
          <div className="pb-card-title-wrap">
            <h3 className="pb-card-title">
              <IconLayers />
              <span>Skill Configuration</span>
            </h3>
            <p className="pb-card-subtitle">
              Contains your live vault state — canister principal, deposit subaccount, tracked tokens, velocity limits, allowlists, and error recovery guidance.
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

        <div className="skill-rendered-document-box" style={{ marginTop: "24px", background: "rgba(10, 15, 25, 0.6)", border: "1px solid rgba(255, 255, 255, 0.08)", borderRadius: "8px", padding: "20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", paddingBottom: "10px", borderBottom: "1px solid rgba(255, 255, 255, 0.08)" }}>
            <span style={{ fontSize: "12px", fontFamily: "var(--font-mono, monospace)", color: "var(--text-muted, #8a99ad)" }}>
              {skill.filename}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "var(--text-muted, #8a99ad)", fontSize: "12px" }}>
              <IconShield />
              <small>Public configuration only</small>
            </div>
          </div>

          <div className="markdown-rendered-view">
            <MarkdownRenderer content={skill.content} />
          </div>
        </div>
      </div>
    </div>
  );
}

function MarkdownRenderer({ content }: { content: string }) {
  const blocks = useMemo(() => parseMarkdownBlocks(content), [content]);

  return (
    <div className="markdown-body-container" style={{ fontSize: "13px", lineHeight: "1.6", color: "#e2e8f0" }}>
      {blocks.map((block, idx) => {
        if (block.type === "h1") return <h1 key={idx} style={{ fontSize: "20px", margin: "20px 0 10px 0", color: "#f8fafc", borderBottom: "1px solid rgba(255,255,255,0.1)", paddingBottom: "6px" }}>{renderInline(block.text)}</h1>;
        if (block.type === "h2") return <h2 key={idx} style={{ fontSize: "16px", margin: "18px 0 8px 0", color: "#f1f5f9", borderBottom: "1px solid rgba(255,255,255,0.06)", paddingBottom: "4px" }}>{renderInline(block.text)}</h2>;
        if (block.type === "h3") return <h3 key={idx} style={{ fontSize: "14px", margin: "14px 0 6px 0", color: "#e2e8f0" }}>{renderInline(block.text)}</h3>;
        if (block.type === "codeblock") {
          return (
            <pre key={idx} style={{ background: "rgba(0, 0, 0, 0.5)", border: "1px solid rgba(255, 255, 255, 0.1)", borderRadius: "6px", padding: "12px", margin: "12px 0", overflowX: "auto", fontFamily: "var(--font-mono, monospace)", fontSize: "12px", color: "#cbd5e1" }}>
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.type === "table") {
          return (
            <div key={idx} style={{ overflowX: "auto", margin: "12px 0" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", border: "1px solid rgba(255, 255, 255, 0.08)" }}>
                <thead>
                  <tr style={{ background: "rgba(255, 255, 255, 0.05)" }}>
                    {block.headers.map((h, i) => (
                      <th key={i} style={{ border: "1px solid rgba(255, 255, 255, 0.08)", padding: "8px 12px", textAlign: "left", color: "#94a3b8" }}>
                        {renderInline(h)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rIdx) => (
                    <tr key={rIdx} style={{ background: rIdx % 2 === 0 ? "transparent" : "rgba(255, 255, 255, 0.02)" }}>
                      {row.map((cell, cIdx) => (
                        <td key={cIdx} style={{ border: "1px solid rgba(255, 255, 255, 0.08)", padding: "8px 12px", color: "#cbd5e1" }}>
                          {renderInline(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.type === "quote") {
          return (
            <blockquote key={idx} style={{ borderLeft: "3px solid var(--accent, #3b82f6)", background: "rgba(59, 130, 246, 0.08)", margin: "12px 0", padding: "8px 12px", borderRadius: "0 4px 4px 0", color: "#93c5fd" }}>
              {renderInline(block.text)}
            </blockquote>
          );
        }
        if (block.type === "list") {
          return (
            <ul key={idx} style={{ paddingLeft: "20px", margin: "8px 0" }}>
              {block.items.map((item, iIdx) => (
                <li key={iIdx} style={{ margin: "4px 0" }}>
                  {renderInline(item)}
                </li>
              ))}
            </ul>
          );
        }
        if (block.type === "hr") {
          return <hr key={idx} style={{ border: "none", borderTop: "1px solid rgba(255, 255, 255, 0.1)", margin: "16px 0" }} />;
        }
        return <p key={idx} style={{ margin: "8px 0", color: "#cbd5e1" }}>{renderInline(block.text)}</p>;
      })}
    </div>
  );
}

type MarkdownBlock =
  | { type: "h1" | "h2" | "h3" | "quote" | "hr"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "codeblock"; language?: string; text: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "list"; items: string[] };

function parseMarkdownBlocks(raw: string): MarkdownBlock[] {
  const lines = raw.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        codeLines.push(lines[i] ?? "");
        i++;
      }
      i++; // skip closing ```
      blocks.push({ type: "codeblock", language, text: codeLines.join("\n") });
      continue;
    }

    if (line.trim() === "---") {
      blocks.push({ type: "hr", text: "" });
      i++;
      continue;
    }

    if (line.startsWith("# ")) {
      blocks.push({ type: "h1", text: line.slice(2).trim() });
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push({ type: "h2", text: line.slice(3).trim() });
      i++;
      continue;
    }
    if (line.startsWith("### ")) {
      blocks.push({ type: "h3", text: line.slice(4).trim() });
      i++;
      continue;
    }
    if (line.startsWith("> ")) {
      blocks.push({ type: "quote", text: line.slice(2).trim() });
      i++;
      continue;
    }

    const nextLine = lines[i + 1] ?? "";
    if (line.trim().startsWith("|") && i + 1 < lines.length && nextLine.includes("---")) {
      const headers = line.split("|").map((cell) => cell.trim()).filter((cell, idx, arr) => idx > 0 && idx < arr.length - 1);
      i += 2; // skip header and separator line
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").trim().startsWith("|")) {
        const curLine = lines[i] ?? "";
        const cells = curLine.split("|").map((cell) => cell.trim()).filter((cell, idx, arr) => idx > 0 && idx < arr.length - 1);
        rows.push(cells);
        i++;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    if (line.trim().startsWith("- ") || line.trim().startsWith("* ")) {
      const items: string[] = [];
      while (i < lines.length && ((lines[i] ?? "").trim().startsWith("- ") || (lines[i] ?? "").trim().startsWith("* "))) {
        const curLine = lines[i] ?? "";
        items.push(curLine.trim().slice(2));
        i++;
      }
      blocks.push({ type: "list", items });
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph
    blocks.push({ type: "paragraph", text: line });
    i++;
  }

  return blocks;
}

function renderInline(text: string): React.ReactNode {
  // Simple regex parser for inline bold, code, and links
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let keyIdx = 0;

  while (remaining.length > 0) {
    const codeMatch = remaining.match(/`([^`]+)`/);
    const boldMatch = remaining.match(/\*\*([^*]+)\*\*/);

    if (codeMatch && (!boldMatch || (codeMatch.index ?? 0) < (boldMatch.index ?? 0))) {
      const idx = codeMatch.index ?? 0;
      if (idx > 0) parts.push(remaining.slice(0, idx));
      parts.push(
        <code key={keyIdx++} style={{ background: "rgba(255,255,255,0.08)", padding: "2px 5px", borderRadius: "4px", fontSize: "12px", fontFamily: "var(--font-mono, monospace)", color: "#f1f5f9" }}>
          {codeMatch[1]}
        </code>
      );
      remaining = remaining.slice(idx + codeMatch[0].length);
    } else if (boldMatch) {
      const idx = boldMatch.index ?? 0;
      if (idx > 0) parts.push(remaining.slice(0, idx));
      parts.push(
        <strong key={keyIdx++} style={{ fontWeight: 600, color: "#f8fafc" }}>
          {boldMatch[1]}
        </strong>
      );
      remaining = remaining.slice(idx + boldMatch[0].length);
    } else {
      parts.push(remaining);
      break;
    }
  }

  return parts;
}
