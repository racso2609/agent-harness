import { describe, expect, it } from "vitest";
import { compactHistory, estimateHistoryTokens, summarizeHistory } from "../../src/session/history";
import type { History } from "../../src/types/providers";

const userMessages = (...contents: string[]): History[] =>
  contents.map((content) => ({ role: "user" as const, content }));

describe("compactHistory", () => {
  it("returns the same history when there are no messages", () => {
    const history: History[] = [];

    expect(compactHistory(history)).toBe(history);
  });

  it("returns the same history when user messages equal the threshold", () => {
    const history = userMessages("u1", "u2", "u3", "u4");

    expect(compactHistory(history)).toBe(history);
  });

  it("returns the same history when user messages are below the threshold", () => {
    const history = userMessages("u1", "u2");

    expect(compactHistory(history)).toBe(history);
  });

  it("summarizes older messages and keeps the most recent ones", () => {
    const history = userMessages("u1", "u2", "u3", "u4", "u5", "u6");

    const compacted = compactHistory(history);

    expect(compacted).toEqual([
      {
        role: "system",
        content: "[Memoria previa compactada]: user: u1 | user: u2",
      },
      { role: "user", content: "u3" },
      { role: "user", content: "u4" },
      { role: "user", content: "u5" },
      { role: "user", content: "u6" },
    ]);
  });

  it("compacts assistant messages alongside user messages", () => {
    const history: History[] = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a3" },
    ];

    const compacted = compactHistory(history, 2);

    expect(compacted).toEqual([
      {
        role: "system",
        content: "[Memoria previa compactada]: user: u1 | assistant: a1 | user: u2 | assistant: a2",
      },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a3" },
    ]);
  });

  it("truncates older messages to keep the summary bounded", () => {
    const long = "x".repeat(2000);
    const history: History[] = [
      { role: "user", content: long },
      { role: "assistant", content: long },
      ...userMessages("u1", "u2", "u3", "u4", "u5"),
    ];

    const compacted = compactHistory(history, 4);
    const memory = compacted[0].content;

    expect(memory.length).toBeLessThan(4000);
    expect(memory).toContain("…");
  });

  it("uses a custom threshold", () => {
    const history = userMessages("u1", "u2", "u3");

    const compacted = compactHistory(history, 2);

    expect(compacted).toEqual([
      { role: "system", content: "[Memoria previa compactada]: user: u1" },
      { role: "user", content: "u2" },
      { role: "user", content: "u3" },
    ]);
  });

  it("preserves system messages before the compacted memory", () => {
    const history: History[] = [
      { role: "system", content: "you are a helpful agent" },
      ...userMessages("u1", "u2", "u3", "u4", "u5", "u6"),
    ];

    const compacted = compactHistory(history);

    expect(compacted).toEqual([
      { role: "system", content: "you are a helpful agent" },
      {
        role: "system",
        content: "[Memoria previa compactada]: user: u1 | user: u2",
      },
      { role: "user", content: "u3" },
      { role: "user", content: "u4" },
      { role: "user", content: "u5" },
      { role: "user", content: "u6" },
    ]);
  });

  it("preserves multiple system messages in order", () => {
    const history: History[] = [
      { role: "system", content: "first system" },
      { role: "system", content: "second system" },
      ...userMessages("u1", "u2", "u3", "u4", "u5"),
    ];

    const compacted = compactHistory(history);

    expect(compacted.slice(0, 2)).toEqual([
      { role: "system", content: "first system" },
      { role: "system", content: "second system" },
    ]);
    expect(compacted[2]).toEqual({
      role: "system",
      content: "[Memoria previa compactada]: user: u1",
    });
  });

  it("keeps tool results paired with their assistant message", () => {
    const history: History[] = [
      { role: "user", content: "u1" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "shell", args: {} }],
      },
      { role: "tool", toolCallId: "call_1", content: "out" },
      { role: "user", content: "u2" },
    ];

    const compacted = compactHistory(history, 2);

    expect(compacted).toEqual([
      {
        role: "system",
        content: "[Memoria previa compactada]: user: u1",
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "shell", args: {} }],
      },
      { role: "tool", toolCallId: "call_1", content: "out" },
      { role: "user", content: "u2" },
    ]);
  });

  it("does not count system messages towards the threshold", () => {
    const history: History[] = [
      ...userMessages("u1", "u2", "u3", "u4"),
      { role: "system", content: "system after users" },
    ];

    expect(compactHistory(history)).toBe(history);
  });

  it("uses the default threshold when none is provided", () => {
    const history = userMessages("u1", "u2", "u3", "u4", "u5");

    const compacted = compactHistory(history);

    expect(compacted).toEqual([
      { role: "system", content: "[Memoria previa compactada]: user: u1" },
      ...userMessages("u2", "u3", "u4", "u5"),
    ]);
  });

  it("produces only valid History entries", () => {
    const history: History[] = [
      { role: "system", content: "system" },
      ...userMessages("u1", "u2", "u3", "u4", "u5", "u6"),
    ];

    const compacted = compactHistory(history);

    expect(Array.isArray(compacted)).toBe(true);
    for (const message of compacted) {
      expect(Array.isArray(message)).toBe(false);
      expect(["system", "user", "assistant"]).toContain(message.role);
      expect(typeof message.content).toBe("string");
    }
  });
});

describe("summarizeHistory", () => {
  it("joins roles and contents with a pipe separator", () => {
    const history: History[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];

    expect(summarizeHistory(history)).toBe("user: hello | assistant: hi");
  });

  it("truncates long messages and marks omitted content", () => {
    const history: History[] = [
      { role: "user", content: "x".repeat(2000) },
      { role: "user", content: "y".repeat(2000) },
    ];

    const summary = summarizeHistory(history);

    expect(summary).toContain("…");
    expect(summary.length).toBeLessThan(2000);
  });
});

describe("estimateHistoryTokens", () => {
  it("estimates one token per four characters", () => {
    const history: History[] = [{ role: "user", content: "12345678" }];

    expect(estimateHistoryTokens(history)).toBe(2);
  });

  it("returns zero for empty histories", () => {
    expect(estimateHistoryTokens([])).toBe(0);
  });
});
