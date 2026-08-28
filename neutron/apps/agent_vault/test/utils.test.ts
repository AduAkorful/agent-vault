import { expect, test, describe } from "bun:test";
import {
  toBigInt,
  formatAmount,
  parseFriendlyAmount,
  getTier,
  isSettlementSuccess,
  formatVaultError,
  getErrorGuidance,
  parseActionDetails,
  parseReceipt,
  isAllowedPair,
  isValidPrincipal,
  isPolicyNameValid,
  parseLines,
  parsePairs,
  formatPairs,
  shortenPrincipal,
  formatRelativeTime,
  errorMessage,
  unwrapOk,
  extractErrorMessage,
  exportAuditToCsv,
  describeAction,
  isTransferAction,
  getPrincipalLabel,
  KNOWN_PRINCIPALS,
  PRINCIPAL_PATTERN,
} from "../src/utils.ts";
import type { AuditEntry, Balance, Ticket, JsonValue } from "../src/types.ts";
import type { JsonValue as NJsonValue } from "neutron-tools/app";

describe("toBigInt", () => {
  test("passes through bigint", () => {
    expect(toBigInt(42n)).toBe(42n);
    expect(toBigInt(0n)).toBe(0n);
  });

  test("converts non-negative safe integers", () => {
    expect(toBigInt(0)).toBe(0n);
    expect(toBigInt(123)).toBe(123n);
    expect(toBigInt(Number.MAX_SAFE_INTEGER)).toBe(BigInt(Number.MAX_SAFE_INTEGER));
  });

  test("converts valid numeric strings", () => {
    expect(toBigInt("0")).toBe(0n);
    expect(toBigInt("12345")).toBe(12345n);
  });

  test("rejects negative integers", () => {
    expect(() => toBigInt(-1)).toThrow(RangeError);
  });

  test("rejects non-safe integers", () => {
    expect(() => toBigInt(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });

  test("rejects non-numeric strings", () => {
    expect(() => toBigInt("abc")).toThrow(TypeError);
    expect(() => toBigInt("")).toThrow(TypeError);
    expect(() => toBigInt("12.5")).toThrow(TypeError);
    expect(() => toBigInt("-5")).toThrow(TypeError);
  });

  test("rejects unsupported types", () => {
    expect(() => toBigInt({})).toThrow(TypeError);
    expect(() => toBigInt(null)).toThrow(TypeError);
    expect(() => toBigInt(undefined)).toThrow(TypeError);
    expect(() => toBigInt(true)).toThrow(TypeError);
  });
});

describe("formatAmount", () => {
  test("formats raw base units with decimals (6)", () => {
    expect(formatAmount("1000000", 6)).toBe("1");
    expect(formatAmount("1500000", 6)).toBe("1.5");
    expect(formatAmount("1234567", 6)).toBe("1.234567");
  });

  test("handles zero amount", () => {
    expect(formatAmount("0", 6)).toBe("0");
  });

  test("strips trailing zeros in fractional part", () => {
    expect(formatAmount("1500000", 6)).toBe("1.5");
    expect(formatAmount("15000", 6)).toBe("0.015");
  });

  test("returns raw string when decimals is null", () => {
    expect(formatAmount("12345", null)).toBe("12345");
  });

  test("returns raw string when decimals is undefined", () => {
    expect(formatAmount("12345", undefined)).toBe("12345");
  });

  test("returns raw string when decimals is negative", () => {
    expect(formatAmount("12345", -1)).toBe("12345");
  });

  test("returns em dash on invalid amount", () => {
    expect(formatAmount("abc", 6)).toBe("—");
    expect(formatAmount(null, 6)).toBe("—");
  });
});

describe("parseFriendlyAmount", () => {
  test("converts decimal string with decimals", () => {
    expect(parseFriendlyAmount("1.5", 6)).toBe(1500000n);
    expect(parseFriendlyAmount("1", 6)).toBe(1000000n);
    expect(parseFriendlyAmount("0.015", 6)).toBe(15000n);
  });

  test("handles empty string", () => {
    expect(parseFriendlyAmount("", 6)).toBe(0n);
  });

  test("rejects negative amounts", () => {
    expect(parseFriendlyAmount("-5", 6)).toBe(0n);
    expect(parseFriendlyAmount("-1.5", 6)).toBe(0n);
  });

  test("rejects scientific notation", () => {
    expect(parseFriendlyAmount("1e5", 6)).toBe(0n);
    expect(parseFriendlyAmount("1E5", 6)).toBe(0n);
  });

  test("truncates extra decimal places to decimals", () => {
    expect(parseFriendlyAmount("1.123456789", 6)).toBe(1123456n);
  });

  test("pads short decimal with zeros", () => {
    expect(parseFriendlyAmount("1.5", 8)).toBe(150000000n);
  });

  test("handles null decimals (raw big int parse)", () => {
    expect(parseFriendlyAmount("12345", null)).toBe(12345n);
  });

  test("rejects malformed decimal strings", () => {
    expect(parseFriendlyAmount("1.2.3", 6)).toBe(0n);
    expect(parseFriendlyAmount("abc", 6)).toBe(0n);
  });
});

describe("getTier", () => {
  test("classifies autonomous tier", () => {
    expect(getTier({ Autonomous: null })).toBe("autonomous");
  });

  test("classifies escalation tier", () => {
    expect(getTier({ Escalation: null })).toBe("escalation");
  });

  test("classifies forbidden tier", () => {
    expect(getTier({ Forbidden: null })).toBe("forbidden");
  });

  test("returns unknown for unrecognized tiers", () => {
    expect(getTier({ Unknown: null })).toBe("unknown");
    expect(getTier({})).toBe("unknown");
    expect(getTier("not-an-object")).toBe("unknown");
  });
});

describe("isSettlementSuccess", () => {
  test("recognizes success variant", () => {
    expect(isSettlementSuccess({ success: null })).toBe(true);
  });

  test("rejects error variants", () => {
    expect(isSettlementSuccess({ fail: null })).toBe(false);
  });

  test("rejects non-objects", () => {
    expect(isSettlementSuccess("string")).toBe(false);
    expect(isSettlementSuccess(null)).toBe(false);
  });
});

describe("formatVaultError", () => {
  test("returns default message for null/empty", () => {
    expect(formatVaultError(null)).toBe("Requires Approval");
    expect(formatVaultError([])).toBe("Requires Approval");
  });

  test("maps known error variants", () => {
    expect(formatVaultError({ SwapRequiresApproval: null })).toBe("Mandatory DEX Swap Approval");
    expect(formatVaultError({ RecipientNotAllowed: null })).toBe("Recipient Not in Allowlist");
    expect(formatVaultError({ CircuitBreakerActive: null })).toBe("Circuit Breaker Active");
    expect(formatVaultError({ TooManyPendingTickets: null })).toBe("Pending Approval Cap Reached");
    expect(formatVaultError({ TokenLimitNotConfigured: null })).toBe("Token Budget Not Configured");
    expect(formatVaultError({ InsufficientBalance: null })).toBe("Insufficient Vault Balance");
  });

  test("extracts ExternalFailure message", () => {
    const err = { ExternalFailure: { message: "Ledger timeout" } } as unknown as NJsonValue;
    expect(formatVaultError(err)).toBe("Ledger timeout");
  });

  test("falls back to ExternalFailure default when no message", () => {
    const err = { ExternalFailure: { detail: "something" } } as unknown as NJsonValue;
    expect(formatVaultError(err)).toBe("External Ledger Failure");
  });

  test("uses camelCase conversion for unknown variants", () => {
    const err = { SomeNewError: null } as unknown as NJsonValue;
    expect(formatVaultError(err)).toBe("Some New Error");
  });
});

describe("getErrorGuidance", () => {
  test("returns null for no error", () => {
    expect(getErrorGuidance(null)).toBe(null);
    expect(getErrorGuidance([])).toBe(null);
  });

  test("returns guidance for common errors", () => {
    expect(getErrorGuidance({ RecipientNotAllowed: null })).toContain("allowlist");
    expect(getErrorGuidance({ InsufficientBalance: null })).toContain("deposit");
    expect(getErrorGuidance({ CircuitBreakerActive: null })).toContain("circuit breaker");
    expect(getErrorGuidance({ TooManyPendingTickets: null })).toContain("1,000");
    expect(getErrorGuidance({ HourlyLimit: null })).toContain("hourly");
  });

  test("returns ExternalFailure guidance for partial failures", () => {
    const err = { ExternalFailure: { partial: true } } as unknown as NJsonValue;
    expect(getErrorGuidance(err)).toContain("Recover Lock");
  });

  test("returns general ExternalFailure guidance", () => {
    const err = { ExternalFailure: { message: "fail" } } as unknown as NJsonValue;
    expect(getErrorGuidance(err)).toContain("Sync");
  });

  test("returns null for unknown error variants", () => {
    expect(getErrorGuidance({ SomeUnknownError: null })).toBe(null);
  });

  test("handles nested array envelope", () => {
    const arr = [{ RecipientNotAllowed: null }] as unknown as NJsonValue;
    expect(getErrorGuidance(arr)).toContain("allowlist");
    const empty = [] as unknown as NJsonValue;
    expect(getErrorGuidance(empty)).toBe(null);
  });
});

describe("parseActionDetails", () => {
  const mockBalances: Balance[] = [
    {
      token: { id: "ryjl3-tyaaa-aaaaa-aaaba-cai", symbol: "ICP", decimals: 6, standard: "ICRC-1", fee: 5000n },
      amount: 1000000n,
      syncedAt: 0n,
    },
    {
      token: { id: "xevnm-gaaaa-aaaar-qafnq-cai", symbol: "ckUSDC", decimals: 6, standard: "ICRC-1", fee: 500n },
      amount: 5000000n,
      syncedAt: 0n,
    },
  ];

  test("parses transfer actions", () => {
    const action = {
      transfer: {
        token: "ryjl3-tyaaa-aaaaa-aaaba-cai",
        recipient: "abcde-fghij-klmn-opqrs",
        amount: "1000000",
        reason: "Monthly allowance",
      },
    };
    const details = parseActionDetails(action, mockBalances);
    expect(details.type).toBe("transfer");
    expect(details.token).toBe("ryjl3-tyaaa-aaaaa-aaaba-cai");
    expect(details.amount).toBe("1");
    expect(details.reason).toBe("Monthly allowance");
    expect(details.summary).toContain("ICP");
  });

  test("parses swap actions", () => {
    const action = {
      swap: {
        fromToken: "ryjl3-tyaaa-aaaaa-aaaba-cai",
        toToken: "xevnm-gaaaa-aaaar-qafnq-cai",
        dex: "4mmnk-kiaaa-aaaag-qbllq-cai",
        amount: "1000000",
        minReturn: "900000",
        slippageBps: "50",
        reason: "Rebalance",
      },
    };
    const details = parseActionDetails(action, mockBalances);
    expect(details.type).toBe("swap");
    expect(details.fromToken).toBe("ryjl3-tyaaa-aaaaa-aaaba-cai");
    expect(details.toToken).toBe("xevnm-gaaaa-aaaar-qafnq-cai");
    expect(details.minReturn).toBe("0.9");
    expect(details.slippagePercent).toBe("0.50%");
    expect(details.summary).toContain("ICP");
  });

  test("returns unknown type for unrecognized actions", () => {
    const details = parseActionDetails("some string", mockBalances);
    expect(details.type).toBe("unknown");
    expect(details.amount).toBe("—");
  });

  test("handles null action", () => {
    const details = parseActionDetails(null, mockBalances);
    expect(details.type).toBe("unknown");
  });

  test("slippagePercent is undefined when slippageBps absent", () => {
    const action = {
      swap: {
        fromToken: "ryjl3-tyaaa-aaaaa-aaaba-cai",
        toToken: "xevnm-gaaaa-aaaar-qafnq-cai",
        amount: "1000000",
      },
    };
    const details = parseActionDetails(action, mockBalances);
    expect(details.slippagePercent).toBeUndefined();
  });
});

describe("parseReceipt", () => {
  test("parses transfer receipt", () => {
    const settlement = {
      success: {
        transfer: {
          token: "ryjl3-tyaaa-aaaaa-aaaba-cai",
          blockIndex: "12345",
          fee: "5000",
        },
      },
    };
    const receipt = parseReceipt(settlement);
    expect(receipt?.type).toBe("transfer");
    expect(receipt?.blockIndex).toBe("12345");
    expect(receipt?.fee).toBe("5000");
    expect(receipt?.token).toBe("ryjl3-tyaaa-aaaaa-aaaba-cai");
  });

  test("parses swap receipt", () => {
    const settlement = {
      success: {
        swap: {
          pool: "4mmnk-kiaaa-aaaag-qbllq-cai",
          approvalBlockIndex: "100",
          transactionId: "200",
          amountOut: "900000",
          fee: "500",
        },
      },
    };
    const receipt = parseReceipt(settlement);
    expect(receipt?.type).toBe("swap");
    expect(receipt?.amountOut).toBe("900000");
    expect(receipt?.approvalBlockIndex).toBe("100");
    expect(receipt?.pool).toBe("4mmnk-kiaaa-aaaag-qbllq-cai");
  });

  test("parses Ok envelope variant", () => {
    const settlement = {
      Ok: { transfer: { blockIndex: "99" } },
    };
    const receipt = parseReceipt(settlement);
    expect(receipt?.type).toBe("transfer");
    expect(receipt?.blockIndex).toBe("99");
  });

  test("returns null for null settlement", () => {
    expect(parseReceipt(null)).toBe(null);
  });

  test("returns null for non-success settlement", () => {
    expect(parseReceipt({ fail: null })).toBe(null);
  });

  test("handles nested array settlement", () => {
    const settlement = [{ success: { transfer: { blockIndex: "42" } } }] as unknown as NJsonValue;
    const receipt = parseReceipt(settlement);
    expect(receipt?.blockIndex).toBe("42");
  });
});

describe("isAllowedPair", () => {
  test("rejects same token pair", () => {
    expect(isAllowedPair("ryjl3-tyaaa-aaaaa-aaaba-cai", "ryjl3-tyaaa-aaaaa-aaaba-cai")).toBe(false);
  });

  test("requires both to be valid principals", () => {
    expect(isAllowedPair("ab", "ryjl3-tyaaa-aaaaa-aaaba-cai")).toBe(false);
    expect(isAllowedPair("ryjl3-tyaaa-aaaaa-aaaba-cai", "ab")).toBe(false);
  });

  test("accepts valid distinct principals", () => {
    expect(isAllowedPair("ryjl3-tyaaa-aaaaa-aaaba-cai", "xevnm-gaaaa-aaaar-qafnq-cai")).toBe(true);
  });
});

describe("isValidPrincipal", () => {
  test("accepts valid principal format", () => {
    expect(isValidPrincipal("ryjl3-tyaaa-aaaaa-aaaba-cai")).toBe(true);
    expect(isValidPrincipal("4mmnk-kiaaa-aaaag-qbllq-cai")).toBe(true);
    expect(isValidPrincipal("aaaaa-qcaaa-aaaab-qc2dg-cai")).toBe(true);
  });

  test("rejects empty string", () => {
    expect(isValidPrincipal("")).toBe(false);
  });

  test("rejects too short", () => {
    expect(isValidPrincipal("abc")).toBe(false);
  });

  test("rejects non-principal text", () => {
    expect(isValidPrincipal("not a principal")).toBe(false);
  });
});

describe("isPolicyNameValid", () => {
  test("accepts 1-64 char names", () => {
    expect(isPolicyNameValid("daily")).toBe(true);
    expect(isPolicyNameValid("A")).toBe(true);
    expect(isPolicyNameValid("p".repeat(64))).toBe(true);
  });

  test("rejects empty names", () => {
    expect(isPolicyNameValid("")).toBe(false);
    expect(isPolicyNameValid("   ")).toBe(false);
  });

  test("rejects names over 64 chars", () => {
    expect(isPolicyNameValid("p".repeat(65))).toBe(false);
  });
});

describe("parseLines", () => {
  test("splits and trims lines, filtering empties", () => {
    const result = parseLines("a\nb\n  \nc\n");
    expect(result).toEqual(["a", "b", "c"]);
  });

  test("handles empty string", () => {
    expect(parseLines("")).toEqual([]);
  });
});

describe("parsePairs", () => {
  test("parses comma-separated pairs", () => {
    const result = parsePairs("aaaaa-qcaaa-aaaab-qc2dg-cai,bbbbb-ccaaa-aaaab-qc2dh-cai\nbbbbb-ccaaa-aaaab-qc2dh-cai,ddddd-eeaaa-aaaab-qc2di-cai");
    expect(result.length).toBe(2);
    expect(result[0].from).toBe("aaaaa-qcaaa-aaaab-qc2dg-cai");
    expect(result[0].to).toBe("bbbbb-ccaaa-aaaab-qc2dh-cai");
  });

  test("skips lines without exactly two parts", () => {
    const result = parsePairs("a,b,c\n  \nx,y");
    expect(result.length).toBe(1);
    expect(result[0]).toEqual({ from: "x", to: "y" });
  });

  test("skips single-part lines", () => {
    const result = parsePairs("a,b,c\nd\ne,f");
    expect(result.length).toBe(1);
    expect(result[0]).toEqual({ from: "e", to: "f" });
  });
});

describe("formatPairs", () => {
  test("formats pairs as comma-separated lines", () => {
    const pairs = [
      { from: "ryjl3-tyaaa-aaaaa-aaaba-cai", to: "xevnm-gaaaa-aaaar-qafnq-cai" },
      { from: "xevnm-gaaaa-aaaar-qafnq-cai", to: "ryjl3-tyaaa-aaaaa-aaaba-cai" },
    ];
    const result = formatPairs(pairs);
    expect(result).toContain("ryjl3-tyaaa-aaaaa-aaaba-cai,xevnm-gaaaa-aaaar-qafnq-cai");
    expect(result.split("\n").length).toBe(2);
  });
});

describe("shortenPrincipal", () => {
  test("truncates long principals", () => {
    const p = "ryjl3-tyaaa-aaaaa-aaaba-cai";
    expect(shortenPrincipal(p)).toBe("ryjl3-t…a-cai");
  });

  test("returns short principals unchanged", () => {
    expect(shortenPrincipal("short")).toBe("short");
  });

  test("returns em dash for empty", () => {
    expect(shortenPrincipal("")).toBe("—");
  });
});

describe("formatRelativeTime", () => {
  test("returns em dash for zero", () => {
    expect(formatRelativeTime(0n)).toBe("—");
  });

  test("clamps negative diffs to 'Just now'", () => {
    // A future timestamp should still return "Just now" (not negative)
    const future = BigInt((Date.now() + 100000) * 1_000_000);
    expect(formatRelativeTime(future)).toBe("Just now");
  });

  test("handles very old timestamps with date format", () => {
    const old = 0n;
    // 0n is the "—" case above; use a very old real timestamp instead
    const oldTime = BigInt(Date.now() - 2 * 86400 * 1000) * 1_000_000n;
    const result = formatRelativeTime(oldTime);
    expect(result).not.toBe("Just now");
  });
});

describe("errorMessage", () => {
  test("extracts message from Error", () => {
    expect(errorMessage(new Error("test error"))).toBe("test error");
  });

  test("converts non-Error to string", () => {
    expect(errorMessage("string error")).toBe("string error");
    expect(errorMessage(null)).toBe("Unknown error occurred");
    expect(errorMessage(undefined)).toBe("Unknown error occurred");
  });
});

describe("unwrapOk", () => {
  test("extracts ok value", () => {
    const result = unwrapOk<{ value: number }>({ ok: { value: 42 } });
    expect(result.value).toBe(42);
  });

  test("throws on err variant", () => {
    expect(() => unwrapOk({ err: "boom" })).toThrow("boom");
  });

  test("handles Ok/Err capitalization", () => {
    expect(unwrapOk({ Ok: "success" })).toBe("success");
    expect(() => unwrapOk({ Err: "failure" })).toThrow();
  });

  test("throws on malformed envelope", () => {
    expect(() => unwrapOk("not an object")).toThrow("malformed result envelope");
    expect(() => unwrapOk(null)).toThrow("malformed result envelope");
    expect(() => unwrapOk({ unknown: true })).toThrow("malformed result envelope");
  });
});

describe("extractErrorMessage", () => {
  test("returns string errors directly", () => {
    expect(extractErrorMessage("string error")).toBe("string error");
  });

  test("extracts message from nested objects", () => {
    const err = { nested: { deeper: { message: "deep error" } } } as unknown as NJsonValue;
    expect(extractErrorMessage(err)).toBe("deep error");
  });

  test("falls back to JSON stringification", () => {
    expect(extractErrorMessage({ a: 1 })).toBe('{"a":1}');
  });
});

describe("getPrincipalLabel", () => {
  test("labels known principals", () => {
    expect(getPrincipalLabel("ryjl3-tyaaa-aaaaa-aaaba-cai")).toBe("ICP Ledger");
    expect(getPrincipalLabel("mxzaz-hqaaa-aaaar-qaada-cai")).toBe("ckBTC Ledger");
    expect(getPrincipalLabel("xevnm-gaaaa-aaaar-qafnq-cai")).toBe("ckUSDC Ledger");
    expect(getPrincipalLabel("4mmnk-kiaaa-aaaag-qbllq-cai")).toBe("ICPSwap Factory");
  });

  test("returns null for unknown principals", () => {
    expect(getPrincipalLabel("unknown-principal")).toBe(null);
  });

  test("matches case-insensitively", () => {
    expect(getPrincipalLabel("RYJL3-TYAAA-AAAAA-AAABA-CAI")).toBe("ICP Ledger");
  });
});

describe("describeAction", () => {
  test("returns the action summary", () => {
    const action = {
      transfer: {
        token: "ryjl3-tyaaa-aaaaa-aaaba-cai",
        recipient: "test",
        amount: "100",
      },
    };
    expect(describeAction(action, [])).toContain("Transfer");
  });
});

describe("isTransferAction", () => {
  test("detects transfer actions", () => {
    expect(isTransferAction({ transfer: { token: "test", amount: "1" } })).toBe(true);
  });

  test("does not match swap actions", () => {
    expect(isTransferAction({ swap: { fromToken: "a", toToken: "b" } })).toBe(false);
  });

  test("rejects non-objects", () => {
    expect(isTransferAction("string")).toBe(false);
    expect(isTransferAction(null)).toBe(false);
  });
});

describe("exportAuditToCsv", () => {
  const mockBalances: Balance[] = [
    {
      token: { id: "ryjl3-tyaaa-aaaaa-aaaba-cai", symbol: "ICP", decimals: 6, standard: "ICRC-1", fee: 5000n },
      amount: 1000000n,
      syncedAt: 0n,
    },
  ];

  test("produces CSV with headers and rows", () => {
    const audit: AuditEntry[] = [
      {
        id: 1n,
        action: { transfer: { token: "ryjl3-tyaaa-aaaaa-aaaba-cai", recipient: "test", amount: "1000000" } },
        tier: { Escalation: null },
        policyError: { RecipientNotAllowed: null },
        evaluation: null,
        settlement: null,
        timestamp: 1000000n,
        ticketId: 42n,
        note: "test note",
      },
    ];
    const csv = exportAuditToCsv(audit, mockBalances);
    const lines = csv.split("\n");
    expect(lines[0]).toContain("ID");
    expect(lines[1]).toContain("1");
    expect(lines[1]).toContain("Escalation");
    expect(lines[1]).toContain("Recipient Not in Allowlist");
    expect(lines[1]).toContain("42");
    expect(lines[1]).toContain("test note");
    expect(lines[1]).toContain("unsettled");
  });

  test("escapes values with commas in CSV", () => {
    const audit: AuditEntry[] = [
      {
        id: 1n,
        action: { transfer: { token: "ryjl3-tyaaa-aaaaa-aaaba-cai", recipient: "test", amount: "1" } },
        tier: { Forbidden: null },
        policyError: { SomeError: null },
        evaluation: null,
        settlement: null,
        timestamp: 0n,
        ticketId: null,
        note: "has, comma",
      },
    ];
    const csv = exportAuditToCsv(audit);
    // The note "has, comma" should be escaped with quotes
    expect(csv).toContain('"has, comma"');
  });

  test("includes settled transfer block index", () => {
    const audit: AuditEntry[] = [
      {
        id: 1n,
        action: { transfer: { token: "ryjl3-tyaaa-aaaaa-aaaba-cai", recipient: "test", amount: "1" } },
        tier: { Autonomous: null },
        policyError: null,
        evaluation: null,
        settlement: { success: { transfer: { token: "ryjl3-tyaaa-aaaaa-aaaba-cai", blockIndex: "999" } } },
        timestamp: 0n,
        ticketId: null,
        note: "",
      },
    ];
    const csv = exportAuditToCsv(audit);
    expect(csv).toContain("999");
    expect(csv).toContain("settled");
  });

  test("handles empty audit array", () => {
    const csv = exportAuditToCsv([]);
    expect(csv).toContain("ID");
    expect(csv.split("\n").length).toBe(1);
  });

  test("handles null balances gracefully", () => {
    const audit: AuditEntry[] = [
      {
        id: 1n,
        action: "unknown action",
        tier: { Forbidden: null },
        policyError: null,
        evaluation: null,
        settlement: null,
        timestamp: 0n,
        ticketId: null,
        note: "",
      },
    ];
    const csv = exportAuditToCsv(audit);
    expect(csv).toContain("1");
    expect(csv).toContain("other");
  });
});
