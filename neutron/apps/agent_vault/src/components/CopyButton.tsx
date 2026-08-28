// Agent Vault — Interactive 1-click clipboard copy button with visual confirmation.

import React, { useState } from "react";
import { IconCheck, IconCopy } from "./Icons";

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    let copiedOk = false;

    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(text);
        copiedOk = true;
      }
    } catch (err) {
      console.warn("navigator.clipboard failed, attempting fallback...", err);
    }

    if (!copiedOk) {
      try {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        textArea.setAttribute("readonly", "");
        textArea.style.position = "absolute";
        textArea.style.left = "-9999px";
        textArea.style.top = "0";
        
        document.body.appendChild(textArea);
        textArea.select();
        textArea.setSelectionRange(0, 99999);
        
        const successful = document.execCommand("copy");
        document.body.removeChild(textArea);
        if (successful) {
          copiedOk = true;
        }
      } catch (err) {
        console.error("execCommand fallback failed: ", err);
      }
    }

    if (copiedOk) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button
      type="button"
      className={`icon-button pb-copy-btn ${copied ? "copied" : ""}`}
      onClick={copy}
      title={copied ? "Copied!" : label}
      aria-label={copied ? "Copied!" : label}
    >
      {copied ? <span style={{ color: "var(--pb-success, #10b981)", display: "inline-flex" }}><IconCheck /></span> : <IconCopy />}
    </button>
  );
}
