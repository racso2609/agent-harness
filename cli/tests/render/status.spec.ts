import { describe, expect, it } from "vitest";
import type { MemoryHit, SessionStatus } from "@racso2609/core";
import {
  formatCost,
  formatMemoryForget,
  formatMemoryRecent,
  formatSessionStatus,
  formatTokens,
} from "../../src/render/status";

const status: SessionStatus = {
  sessionId: "abc123",
  provider: "openai",
  model: "gpt-test",
  usage: { inputTokens: 12500, outputTokens: 3400, totalTokens: 15900 },
  costUsd: 0.0042,
  contextTokens: 51200,
  contextWindow: 128000,
  contextUsage: 0.4,
  autoCompact: true,
  autoCompactThreshold: 80,
};

describe("status formatters", () => {
  it("formats token counts with thousands separators", () => {
    expect(formatTokens(15900)).toBe("15,900");
  });

  it("formats small costs with six decimals", () => {
    expect(formatCost(0.0042)).toBe("$0.004200");
  });

  it("formats regular costs with four decimals", () => {
    expect(formatCost(1.2345)).toBe("$1.2345");
  });

  it("renders session id, provider, model, tokens, cost and context", () => {
    const output = formatSessionStatus(status);

    expect(output).toContain("Session abc123 · openai / gpt-test");
    expect(output).toContain("Tokens 12,500 in · 3,400 out · 15,900 total · Cost $0.004200");
    expect(output).toContain("Context ");
    expect(output).toContain("40% (51,200 / 128,000)");
    expect(output).toContain("auto-compact at 80%");
  });

  it("hides auto-compact when disabled", () => {
    const output = formatSessionStatus({ ...status, autoCompact: false });

    expect(output).not.toContain("auto-compact");
  });
});

describe("memory formatters", () => {
  const hits: MemoryHit[] = [
    {
      id: "12",
      kind: "decision",
      scope: "project",
      title: "Deploy flow",
      content: "Releases go through the tag pipeline.",
    },
    {
      id: "7",
      kind: "preference",
      scope: "user",
      title: "",
      content: "Tabs over spaces.",
    },
  ];

  it("says so when there is nothing stored", () => {
    expect(formatMemoryRecent([])).toBe("No memories stored yet.");
  });

  it("names the limit it asked for when the listing is empty", () => {
    expect(formatMemoryRecent([], 5)).toBe("No memories stored yet (asked for up to 5).");
  });

  it("renders id, kind and title one per line", () => {
    expect(formatMemoryRecent(hits)).toBe(
      ["12 [decision] Deploy flow", "7 [preference] (untitled)"].join("\n"),
    );
  });

  it("confirms a forget that happened", () => {
    expect(formatMemoryForget("12", true)).toBe("Forgot memory 12.");
  });

  it("explains a forget that did not happen and points at the id list", () => {
    const output = formatMemoryForget("12", false);

    expect(output).toContain("Memory 12 was not forgotten.");
    expect(output).toContain("/memory recent");
    expect(output).not.toContain("Forgot memory 12.");
  });
});
