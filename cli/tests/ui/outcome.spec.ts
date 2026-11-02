import { describe, expect, it } from "vitest";
import {
  formatSpawnOutcome,
  formatTurnOutcome,
  MAX_OUTCOME_CHARS,
  oneLine,
} from "../../src/ui/outcome";

const handle = (overrides: Record<string, unknown> = {}) => ({
  spawnId: "spawn-1",
  agentId: "coder",
  status: "done",
  ...overrides,
});

describe("oneLine", () => {
  it("collapses newlines and repeated spaces into one line", () => {
    expect(oneLine("first\n\nsecond   third\tfourth")).toBe("first second third fourth");
  });

  it("truncates a long text with an ellipsis", () => {
    const text = "a".repeat(MAX_OUTCOME_CHARS + 50);
    const result = oneLine(text);

    expect(result).toHaveLength(MAX_OUTCOME_CHARS + 1);
    expect(result.endsWith("…")).toBe(true);
  });

  it("leaves a short text untouched", () => {
    expect(oneLine("short")).toBe("short");
  });
});

describe("formatSpawnOutcome", () => {
  it("reports the result of a done child", () => {
    expect(formatSpawnOutcome(handle({ result: "all tests pass" }))).toBe(
      "spawn spawn-1 done (coder): all tests pass",
    );
  });

  it("truncates a long result to one readable line", () => {
    const result = formatSpawnOutcome(handle({ result: "x".repeat(500) }));

    expect(result).toContain("…");
    expect(result.length).toBeLessThan(MAX_OUTCOME_CHARS + 60);
    expect(result).not.toContain("\n");
  });

  it("collapses newlines in the result", () => {
    expect(formatSpawnOutcome(handle({ result: "line one\nline two" }))).toBe(
      "spawn spawn-1 done (coder): line one line two",
    );
  });

  it("says so when a done child produced no output", () => {
    expect(formatSpawnOutcome(handle({ result: "" }))).toBe(
      "spawn spawn-1 done (coder): (no output)",
    );
    expect(formatSpawnOutcome(handle({ result: "   \n " }))).toBe(
      "spawn spawn-1 done (coder): (no output)",
    );
    expect(formatSpawnOutcome(handle())).toBe("spawn spawn-1 done (coder): (no output)");
  });

  it("reports the error of a failed child", () => {
    expect(formatSpawnOutcome(handle({ status: "error", error: "provider down" }))).toBe(
      "spawn spawn-1 error (coder): provider down",
    );
  });

  it("falls back to unknown error when the child failed silently", () => {
    expect(formatSpawnOutcome(handle({ status: "error" }))).toBe(
      "spawn spawn-1 error (coder): unknown error",
    );
    expect(formatSpawnOutcome(handle({ status: "error", error: "  " }))).toBe(
      "spawn spawn-1 error (coder): unknown error",
    );
  });
});

describe("formatTurnOutcome", () => {
  it("says nothing when the turn completed", () => {
    expect(formatTurnOutcome({ status: "completed", pending: [] })).toBe("");
  });

  it("says nothing without an outcome", () => {
    expect(formatTurnOutcome(undefined)).toBe("");
  });

  it("says nothing when completed with an empty pending list", () => {
    expect(formatTurnOutcome({ status: "completed", pending: [], next: "ignored" })).toBe("");
  });

  it("reports a tool error with its pending tools and next step", () => {
    const text = formatTurnOutcome({
      status: "toolError",
      pending: ["shell", "read_file"],
      next: "Review the failing tool output and retry.",
    });

    expect(text).toContain("turn failed");
    expect(text).toContain("shell");
    expect(text).toContain("read_file");
    expect(text).toContain("Review the failing tool output and retry.");
  });

  it("reports an incomplete turn with its pending work and next step", () => {
    const text = formatTurnOutcome({
      status: "incomplete",
      pending: ["summarize"],
      next: "Review the failing tool output and retry.",
    });

    expect(text).toContain("turn incomplete");
    expect(text).toContain("summarize");
    expect(text).toContain("Review the failing tool output and retry.");
  });

  it("omits the next step when the outcome has none", () => {
    const text = formatTurnOutcome({ status: "toolError", pending: ["shell"] });

    expect(text).toContain("turn failed");
    expect(text).not.toContain("next:");
  });
});
