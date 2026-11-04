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
  sessionId: "session-c2ba4fa1-d2fe-4a7b-9c3d-001122334455",
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
    // turnPrinted is raised from three places. The notify path already had indirect
    // coverage: the case above prints through toolStart, which also goes through
    // notify. This pins it explicitly and directly, with a plain notice instead of
    // toolStart, so the path no longer depends on which event is used: "hello" is
    // printed by notify, and the answer that follows must still be set apart by
    // the blank lines.
    it("puts a blank line before an answer that follows a notice", () => {
      const output = printed([
        { type: "turnStart", prompt: "run the tests" },
        { type: "notice", message: "hello" },
        { type: "answer", text: "all tests pass" },
      ]);

      expect(output).toBe("hello\n\nall tests pass\n\n");
    });

    // Same hole for writeChunk, which serves the streamed model text. The chunk
    // carries no newline of its own, so the blank line in the literal can only
    // come from the answer's leading "\n", i.e. from the flag writeChunk raised.
    it("puts a blank line before an answer that follows streamed text", () => {
      const output = printed([
        { type: "turnStart", prompt: "run the tests" },
        { type: "text", delta: "partial" },
        { type: "answer", text: "all tests pass" },
      ]);

      expect(output).toBe("partial\nall tests pass\n\n");
    });

    // The flag is per turn: turnStart must reset it, otherwise a fresh turn whose
    // first output is the answer inherits the previous turn's state and picks up a
    // leading blank line that belongs to nobody.
    it("does not inherit the previous turn when a new turn starts", () => {
      const output = printed([
        { type: "turnStart", prompt: "first" },
        { type: "answer", text: "all tests pass" },
        { type: "turnStart", prompt: "second" },
        { type: "answer", text: "nothing to do" },
      ]);

      expect(output).toBe("all tests pass\nnothing to do\n");
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

    it("says the session goes on when another turn is queued", () => {
      const output = printed([
        {
          type: "turnEnd",
          outcome: {
            status: "incomplete",
            pending: ["summarize"],
            next: "Review the child report.",
          },
          continuation: true,
        },
      ]);

      expect(output).toBe(
        "turn incomplete · pending: summarize · next: Review the child report. · session continues on its own\n",
      );
    });

    it("says nothing when the last automatic turn completed", () => {
      const output = printed([
        { type: "turnEnd", outcome: { status: "completed", pending: [] }, continuation: true },
      ]);

      expect(output).toBe("");
    });
  });
});

describe("the status bar", () => {
// Both renderers share one formatter: the line renderer must print exactly the
// shared line, and must stay silent rather than open a blank line when the
// snapshot has nothing to show.
it("prints the shared one-line status", () => {
const output = printed([
{
type: "status",
status: {
sessionId: "session-c2ba4fa1-d2fe-4a7b-9c3d-001122334455",
provider: "openai",
model: "gpt-test",
tokens: 15900,
costUsd: 0.0042,
contextTokens: 51200,
contextWindow: 128000,
contextUsage: 0.4,
},
},
]);

expect(output).toBe(
"ses c2ba4fa1 · openai/gpt-test · 16k tok · $0.0042 · ctx 40% 51k/128k\n",
);
});

it("prints nothing for an empty snapshot", () => {
expect(printed([{ type: "status", status: {} }])).toBe("");
});
});

// /resume changes session but the screen kept the previous conversation. The
// loop now sends the one it is in charge of, and the line renderer starts over:
// the scrollback cannot take a whole transcript back, so it says how many
// messages came and repeats only the last exchange.
describe("a session that replaced the transcript", () => {
 const conversation = (entries: { role: "user" | "assistant"; content: string }[]) => [
   { type: "conversation" as const, entries },
 ];

 it("clears the screen before printing the summary", () => {
   const output = printed(
     conversation([
       { role: "user", content: "hola" },
       { role: "assistant", content: "buenas" },
     ]),
   );

   // \x1Bc is the reset CliUiAdapter.reset writes; the logo follows it through
   // the stubbed printLogo, so only the escape itself is observable here.
   expect(output.startsWith("\x1Bc")).toBe(true);
 });

 it("summarises the last exchange instead of dumping the transcript", () => {
   const output = printed(
     conversation([
       { role: "user", content: "primera pregunta" },
       { role: "assistant", content: "primera respuesta" },
       { role: "user", content: "segunda pregunta" },
       { role: "assistant", content: "segunda respuesta" },
     ]),
   );

   expect(output).toContain("conversation restored: 4 messages\n");
   expect(output).toContain("you: segunda pregunta\n");
   expect(output).toContain("assistant: segunda respuesta\n");
   // The older turns are not repeated on the scrollback.
   expect(output).not.toContain("primera pregunta");
   expect(output).not.toContain("primera respuesta");
 });

 it("cuts a long message down to a readable excerpt", () => {
   const long = "a".repeat(500);
   const output = printed(
     conversation([
       { role: "user", content: long },
       { role: "assistant", content: long },
     ]),
   );

   expect(output).toContain(`you: ${"a".repeat(200)}…\n`);
   expect(output).toContain(`assistant: ${"a".repeat(200)}…\n`);
   // The whole message never reaches the scrollback.
   expect(output).not.toContain("a".repeat(201));
 });

 it("prints only the message when the session has no answer yet", () => {
   const output = printed(conversation([{ role: "user", content: "hola" }]));

   expect(output).toContain("you: hola\n");
   expect(output).not.toContain("assistant:");
 });

 it("leaves the screen alone when the session has nothing to show", () => {
   // A fresh session must not wipe the screen on boot.
   expect(printed(conversation([]))).toBe("");
 });
});
