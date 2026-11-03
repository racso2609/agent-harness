import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpawnHandle } from "@racso/core";
import type { UiEvent } from "../../src/ui/UiAdapter";

// The line renderer writes straight to the terminal: every notice goes through
// process.stdout.write, and @/terminal/stdin repaints the prompt around it. A
// headless run has no TTY, so the prompt helpers would be no-ops anyway, but
// their reads of process.stdout would still be real calls. Both are stubbed so
// the tests only see what the adapter itself decided to print.
vi.mock("../../src/terminal/stdin", () => ({
  clearPrompt: vi.fn(),
  restorePrompt: vi.fn(),
  printLogo: vi.fn(),
  printImage: vi.fn(),
  input: vi.fn(),
}));

const { CliUiAdapter } = await import("../../src/ui/CliUiAdapter");

const settled = (overrides: Partial<SpawnHandle> = {}): SpawnHandle => ({
  spawnId: "spawn-1",
  sessionId: "session-1",
  agentId: "coder",
  prompt: "implement",
  status: "done",
  startedAt: new Date(0).toISOString(),
  ...overrides,
});

// Everything the adapter printed during one or more events, as one string.
const printed = (events: UiEvent[]): string => {
  const ui = new CliUiAdapter();
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  try {
    for (const event of events) ui.render(event);

    return stdout.mock.calls.map((call) => String(call[0])).join("");
  } finally {
    stdout.mockRestore();
  }
};

afterEach(() => {
  vi.restoreAllMocks();
});

// The default renderer is what most sessions actually see, so its two closing
// notices are pinned to the literal text the user reads: each assertion spells
// out the whole line, ending in the newline notify adds. This way a change in
// the renderer, or in the pure formatters it delegates to, turns the test red.
// The formatters' own contract is covered by outcome.spec.ts.
describe("the line renderer", () => {
  describe("settling a child", () => {
    it("reports the result of a child that finished", () => {
      const output = printed([
        { type: "spawnSettled", handle: settled({ result: "all tests pass" }) },
      ]);

      expect(output).toBe("spawn spawn-1 done (coder): all tests pass\n");
    });

    it("reports the error of a child that failed", () => {
      const output = printed([
        {
          type: "spawnSettled",
          handle: settled({ status: "error", error: "provider down" }),
        },
      ]);

      expect(output).toBe("spawn spawn-1 error (coder): provider down\n");
    });

    // The other empty case: a failed child with no message. Same failure mode as
    // the empty result, so it gets its own pinned line instead of relying on the
    // formatter's tests.
    it("says unknown error instead of a header with an empty body", () => {
      const output = printed([
        { type: "spawnSettled", handle: settled({ status: "error", error: "" }) },
      ]);

      expect(output).toBe("spawn spawn-1 error (coder): unknown error\n");
    });

    it("says (no output) instead of a header with an empty body", () => {
      const output = printed([{ type: "spawnSettled", handle: settled({ result: "" }) }]);

      expect(output).toBe("spawn spawn-1 done (coder): (no output)\n");
    });
  });

  describe("the final answer", () => {
    // The answer is set apart from what the turn already printed: one blank line
    // before and after it. A turn that printed nothing before the answer gets no
    // leading blank line, because the line would be the first thing on screen.
    it("puts a blank line before and after an answer that follows output", () => {
      const output = printed([
        { type: "turnStart" },
        { type: "toolStart", id: "call-1", name: "shell" },
        { type: "answer", text: "all tests pass" },
      ]);

      expect(output).toBe("→ shell\n\nall tests pass\n\n");
    });

    it("does not open with a blank line when the answer is the first output", () => {
      const output = printed([{ type: "turnStart" }, { type: "answer", text: "all tests pass" }]);

      expect(output).toBe("all tests pass\n");
    });
  });

  describe("closing a turn", () => {
    it("reports the status, the pending work and the next step", () => {
      const output = printed([
        {
          type: "turnEnd",
          outcome: { status: "toolError", pending: ["shell"], next: "retry" },
        },
      ]);

      expect(output).toBe("turn failed · pending: shell · next: retry\n");
    });

    it("says nothing when the turn completed", () => {
      const output = printed([{ type: "turnEnd", outcome: { status: "completed", pending: [] } }]);

      expect(output).toBe("");
    });

    it("says nothing when the turn carries no outcome", () => {
      const output = printed([{ type: "turnEnd" }]);

      expect(output).toBe("");
    });
  });
});
