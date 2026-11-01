import { describe, expect, it } from "vitest";
import type { SessionStatus } from "@racso/core";
import {
  formatCost,
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
    expect(output).toContain(
      "Tokens 12,500 in · 3,400 out · 15,900 total · Cost $0.004200",
    );
    expect(output).toContain("Context ");
    expect(output).toContain("40% (51,200 / 128,000)");
    expect(output).toContain("auto-compact at 80%");
  });

  it("hides auto-compact when disabled", () => {
    const output = formatSessionStatus({ ...status, autoCompact: false });

    expect(output).not.toContain("auto-compact");
  });
});
