import { describe, expect, it } from "vitest";
import { statusFromSession, toStatusEvent, toUiEvents } from "../../src/ui/renderEvents";
import { formatStatusBar } from "../../src/ui/statusBar";

describe("toUiEvents", () => {
  it("maps text deltas", () => {
    expect(toUiEvents({ type: "text", delta: "hi" })).toEqual([{ type: "text", delta: "hi" }]);
  });

  it("maps reasoning deltas", () => {
    expect(toUiEvents({ type: "reasoning", delta: "why" })).toEqual([
      { type: "reasoning", delta: "why" },
    ]);
  });

  it("maps tool lifecycle events", () => {
    expect(toUiEvents({ type: "toolCallStart", id: "c1", name: "shell" })).toEqual([
      { type: "toolStart", id: "c1", name: "shell" },
    ]);
    expect(toUiEvents({ type: "toolCallEnd", id: "c1", name: "shell" })).toEqual([
      { type: "toolEnd", id: "c1", name: "shell" },
    ]);
  });

  it("maps live tool output with its originating call", () => {
    expect(toUiEvents({ type: "toolOutput", id: "c1", name: "shell", chunk: "out" })).toEqual([
      { type: "toolOutput", id: "c1", name: "shell", chunk: "out" },
    ]);
  });
});

describe("toStatusEvent", () => {
  it("wraps the status snapshot into a status event", () => {
    const event = toStatusEvent({
      sessionId: "session-c2ba4fa1-d2fe-4a7b-9c3d-001122334455",
      provider: "openai",
      model: "gpt",
      agent: "default",
      tokens: 12,
      costUsd: 0.5,
      contextTokens: 51200,
      contextWindow: 128000,
      contextUsage: 0.4,
      autoCompact: true,
      autoCompactThreshold: 60,
    });

    expect(event).toEqual({
      type: "status",
      status: {
        sessionId: "session-c2ba4fa1-d2fe-4a7b-9c3d-001122334455",
        provider: "openai",
        model: "gpt",
        agent: "default",
        tokens: 12,
        costUsd: 0.5,
        contextTokens: 51200,
        contextWindow: 128000,
        contextUsage: 0.4,
        autoCompact: true,
        autoCompactThreshold: 60,
      },
    });
  });

  // Core reports token counts as `usage`, never as a flat `tokens`: the mapping
// read the field core does not send, so the bar showed no count in production.
it("renders the token count core actually sends", () => {
const event = toStatusEvent({
sessionId: "session-c2ba4fa1-d2fe-4a7b-9c3d-001122334455",
provider: "openai",
model: "gpt-test",
agent: "default",
usage: { inputTokens: 12_000, outputTokens: 3_900, totalTokens: 15_900 },
costUsd: 0.5,
contextTokens: 51_200,
contextWindow: 128_000,
contextUsage: 0.4,
autoCompact: true,
autoCompactThreshold: 60,
});

expect(formatStatusBar(event.status)).toContain("16k tok");
});

it("keeps missing fields undefined", () => {
    const event = toStatusEvent({});

    expect(event.type).toBe("status");
    expect(event.status.provider).toBeUndefined();
    expect(event.status.contextUsage).toBeUndefined();
  });
});

describe("statusFromSession", () => {
// The single place that says which core field becomes which UI field, so a
// renamed or absent source field fails here instead of silently leaving its
// optional property undefined in the bar.
it("maps a full core SessionStatus onto a UiStatus", () => {
expect(
statusFromSession({
sessionId: "session-c2ba4fa1-d2fe-4a7b-9c3d-001122334455",
agent: "default",
provider: "openai",
model: "gpt-5",
usage: { inputTokens: 12_000, outputTokens: 3_900, totalTokens: 15_900 },
costUsd: 0.5,
contextTokens: 51_200,
contextWindow: 128_000,
contextUsage: 0.4,
autoCompact: true,
autoCompactThreshold: 60,
}),
).toEqual({
sessionId: "session-c2ba4fa1-d2fe-4a7b-9c3d-001122334455",
agent: "default",
provider: "openai",
model: "gpt-5",
tokens: 15_900,
costUsd: 0.5,
contextTokens: 51_200,
contextWindow: 128_000,
contextUsage: 0.4,
autoCompact: true,
autoCompactThreshold: 60,
});
});

// The flat field is kept for compatibility; when present it wins.
it("prefers a flat tokens field when one is passed", () => {
expect(statusFromSession({ tokens: 42, usage: { inputTokens: 12_000, outputTokens: 3_900, totalTokens: 15_900 } }).tokens).toBe(42);
});
});
