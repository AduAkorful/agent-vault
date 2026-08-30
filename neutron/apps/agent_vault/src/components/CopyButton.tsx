// Agent Vault — Interactive 1-click clipboard copy button with visual confirmation.

import React, { useState } from "react";
import { IconCheck, IconCopy } from "./Icons";

export function copyTextToClipboard(text: string): boolean {
  let copiedOk = false;

  // 1. Try navigator.clipboard.writeText
  if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      void navigator.clipboard.writeText(text);
      copiedOk = true;
    } catch {
      // Ignored
    }
  }

  // 2. Synchronous execCommand fallback with selection restoration
  try {
    const element = document.createElement("textarea");
    element.value = text;
    element.setAttribute("readonly", "");
    element.style.contain = "strict";
    element.style.position = "fixed";
    element.style.left = "-9999px";
    element.style.top = "-9999px";
    element.style.opacity = "0";

    const selection = document.getSelection();
    let originalRange: Range | null = null;
    if (selection && selection.rangeCount > 0) {
      originalRange = selection.getRangeAt(0);
    }

    document.body.appendChild(element);
    element.focus();
    element.select();
    element.setSelectionRange(0, element.value.length);

    const execOk = document.execCommand("copy");
    document.body.removeChild(element);

    if (originalRange && selection) {
      selection.removeAllRanges();
      selection.addRange(originalRange);
    }

    if (execOk) {
      copiedOk = true;
    }
  } catch (err) {
    console.error("execCommand copy error:", err);
  }

  return copiedOk;
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const copy = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = copyTextToClipboard(text);
    if (ok) {
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
