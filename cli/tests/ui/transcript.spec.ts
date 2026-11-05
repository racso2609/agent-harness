import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { SpawnHandle } from "@racso2609/core";
import type { TuiState } from "../../src/ui/tui/App";
import { noAnchors, trimAnchored, writeAnchored } from "../../src/ui/tui/entries";
import type { UiEvent } from "../../src/ui/UiAdapter";

// Ink patches the console the moment it mounts, which a headless run cannot
// take, so the renderer is stubbed: these tests are about the transcript the
// adapter builds, not about what ink paints.
vi.mock("ink", () => ({
  render: () => ({ rerender: () => {}, unmount: () => {} }),
  Box: () => null,
  Text: () => null,
  useInput: () => {},
  useStdout: () => ({ stdout: { columns: 80, rows: 24 } }),
}));

const { TuiUiAdapter } = await import("../../src/ui/TuiUiAdapter");

// The transcript is protected state; a subclass reads it the way a renderer
// does, without widening the public surface of the adapter.
class Probe extends TuiUiAdapter {
  get lines() {
    return (this.state as TuiState).lines;
  }

  // What the user actually reads: every block of the document plus the block
  // still being written.
  text(index: number): string {
    const line = this.lines[index];
    if (!line) return "";

    if (line.role === "answer" || line.role === "reasoning") {
      const blocks = line.doc.blocks.map((block) =>
        block.kind === "code"
          ? block.lines.join("\n")
          : block.kind === "rule"
            ? "---"
            : block.spans.map((span) => span.text).join(""),
      );

      return [...blocks, line.doc.open].filter(Boolean).join("\n");
    }

    return "text" in line ? line.text : "";
  }

  of(role: "answer" | "reasoning" | "tool" | "notice"): number[] {
    return this.lines
      .map((line, index) => ({ line, index }))
      .filter((entry) => entry.line.role === role)
      .map((entry) => entry.index);
  }
}

const play = (events: UiEvent[]): Probe => {
  const ui = new Probe();

  for (const event of events) ui.render(event);

  return ui;
};

const settled = (overrides: Partial<SpawnHandle> = {}): SpawnHandle => ({
  spawnId: "spawn-1",
  sessionId: "session-1",
  agentId: "coder",
  prompt: "implement",
  status: "done",
  startedAt: new Date(0).toISOString(),
  ...overrides,
});

// The loop delivers spawn events while the parent is still writing, so the
// notice of a settled child lands in the middle of the parent's stream. Keyed
// by position, the next delta opened a second answer entry and the user read
// the same partial text twice.
describe("a child settling in the middle of the answer", () => {
  const sequence = (notice: string): UiEvent[] => [
    { type: "turnStart", prompt: "hola" },
    { type: "text", delta: "Parte uno. " },
    { type: "spawnSettled", handle: settled({ result: "ok" }) },
    { type: "notice", message: notice },
    { type: "text", delta: "Parte dos." },
    { type: "answer", text: "Parte uno. Parte dos." },
    { type: "turnEnd" },
  ];

  it("keeps one answer entry and the authoritative text", () => {
    const ui = play(sequence("spawn spawn-1 done (coder): ok"));
    const answers = ui.of("answer");

    expect(answers).toHaveLength(1);
    expect(ui.text(answers[0]!)).toBe("Parte uno. Parte dos.");
  });

  it("leaves the notices between the pieces, not inside them", () => {
    const ui = play(sequence("spawn spawn-1 done (coder): ok"));
    const [answer] = ui.of("answer");

    // The child settling writes its own notice, then the explicit one arrives.
    expect(ui.lines.map((line) => line.role)).toEqual(["user", "answer", "notice", "notice"]);
    expect(answer).toBe(1);
  });

  it("keeps one answer entry when a child settles mid-stream", () => {
    const ui = play([
      { type: "turnStart", prompt: "hola" },
      { type: "text", delta: "uno " },
      { type: "spawnSettled", handle: settled({ result: "ok" }) },
      { type: "text", delta: "dos" },
      { type: "answer", text: "uno dos" },
    ]);

    const answers = ui.of("answer");
    const notices = ui.of("notice");

    expect(answers).toHaveLength(1);
    expect(ui.text(answers[0]!)).toBe("uno dos");
    // The user must still read what the child came back with.
    expect(notices).toHaveLength(1);
    expect(ui.text(notices[0]!)).toContain("ok");
  });
});

describe("the closing notice of a child", () => {
  it("reports the result of a child that finished", () => {
    const ui = play([
      { type: "turnStart", prompt: "hola" },
      { type: "spawnSettled", handle: settled({ result: "all tests pass" }) },
    ]);
    const notices = ui.of("notice");

    expect(notices).toHaveLength(1);
    expect(ui.text(notices[0]!)).toContain("all tests pass");
  });

  it("reports the error of a child that failed", () => {
    const ui = play([
      { type: "turnStart", prompt: "hola" },
      {
        type: "spawnSettled",
        handle: settled({ status: "error", error: "provider down" }),
      },
    ]);
    const notices = ui.of("notice");

    expect(notices).toHaveLength(1);
    expect(ui.text(notices[0]!)).toContain("provider down");
  });
});

describe("the closing notice of a turn", () => {
  it("reports the status, the pending work and the next step", () => {
    const ui = play([
      { type: "turnStart", prompt: "hola" },
      { type: "answer", text: "a medias" },
      {
        type: "turnEnd",
        outcome: {
          status: "toolError",
          pending: ["shell", "read_file"],
          next: "Review the failing tool output and retry.",
        },
      },
    ]);
    const notices = ui.of("notice");

    expect(notices).toHaveLength(1);
    const text = ui.text(notices[0]!);

    expect(text).toContain("turn failed");
    expect(text).toContain("shell");
    expect(text).toContain("read_file");
    expect(text).toContain("Review the failing tool output and retry.");
  });

  it("says nothing when the turn completed", () => {
    const ui = play([
      { type: "turnStart", prompt: "hola" },
      { type: "answer", text: "listo" },
      { type: "turnEnd", outcome: { status: "completed", pending: [] } },
    ]);

    expect(ui.of("notice")).toHaveLength(0);
  });
});

describe("a notice in the middle of another streamed role", () => {
  it("keeps one reasoning entry", () => {
    const ui = play([
      { type: "turnStart", prompt: "hola" },
      { type: "reasoning", delta: "pienso una cosa" },
      { type: "notice", message: "spawn spawn-1 done (coder): ok" },
      { type: "reasoning", delta: " y otra" },
      { type: "turnEnd" },
    ]);
    const reasoning = ui.of("reasoning");

    expect(reasoning).toHaveLength(1);
    expect(ui.text(reasoning[0]!)).toContain("pienso una cosa y otra");
  });

  it("concatenates the output of a tool across the notice", () => {
    const ui = play([
      { type: "turnStart", prompt: "hola" },
      { type: "toolStart", id: "c1", name: "shell" },
      { type: "toolOutput", id: "c1", name: "shell", chunk: "line one\n" },
      { type: "notice", message: "spawn spawn-1 done (coder): ok" },
      { type: "toolOutput", id: "c1", name: "shell", chunk: "line two\n" },
      { type: "toolEnd", id: "c1", name: "shell" },
    ]);
    const tools = ui.of("tool");

    expect(tools).toHaveLength(1);
    expect(ui.text(tools[0]!)).toBe("→ shellline one\nline two\n");
  });

  // The notice that actually lands mid-command is the one a settled child
  // writes, not only the explicit `notice` event. The interrupted command must
  // still be the single entry its chunks are appended to.
  it("concatenates the output of a tool across a settled child", () => {
    const ui = play([
      { type: "turnStart", prompt: "hola" },
      { type: "toolStart", id: "c1", name: "shell" },
      { type: "toolOutput", id: "c1", name: "shell", chunk: "line one\n" },
      { type: "spawnSettled", handle: settled({ result: "ok" }) },
      { type: "toolOutput", id: "c1", name: "shell", chunk: "line two\n" },
      { type: "toolEnd", id: "c1", name: "shell" },
    ]);
    const tools = ui.of("tool");

    expect(tools).toHaveLength(1);
    expect(ui.text(tools[0]!)).toBe("→ shellline one\nline two\n");
    // The child still has to be reported, between the two pieces.
    expect(ui.lines.map((line) => line.role)).toEqual(["user", "tool", "notice"]);
  });

  // Two commands cannot share an entry: the output of c2 must not land under
  // c1, or the user reads one command that ran twice. `toolStart` is what makes
  // that true, and it is easy to lose: the header goes in through `pushLine`,
  // which leaves the `tool` anchor where it was, so the index has to be stored
  // again right after. Drop that store and the anchor still points at a `tool`
  // entry — the one the previous `toolOutput` opened — which `writeAnchored`
  // accepts as valid, so c2's chunk is appended there instead of under its own
  // header: three entries, `→ shell`, `a\nb\n`, `→ read_file`. With no valid
  // anchor at all the chunk would open yet another entry: four, `→ shell`,
  // `a\n`, `→ read_file`, `b\n`. Both wrong variants differ from the two
  // entries asserted below, so this sequence only passes when every command
  // opens — and keeps — its own entry.
  it("opens one entry per command when a notice lands in between", () => {
    const ui = play([
      { type: "turnStart", prompt: "hola" },
      { type: "toolStart", id: "c1", name: "shell" },
      { type: "toolOutput", id: "c1", name: "shell", chunk: "a\n" },
      { type: "spawnSettled", handle: settled({ result: "ok" }) },
      { type: "toolStart", id: "c2", name: "read_file" },
      { type: "toolOutput", id: "c2", name: "read_file", chunk: "b\n" },
      { type: "toolEnd", id: "c2", name: "read_file" },
      { type: "turnEnd" },
    ]);
    const tools = ui.of("tool");

    expect(tools).toHaveLength(2);
    expect(ui.text(tools[0]!)).toBe("→ shella\n");
    expect(ui.text(tools[1]!)).toBe("→ read_fileb\n");
  });

  // The same split across two commands, each streamed in two chunks with a
  // notice between commands. Every chunk has to reach the entry of its own
  // command, in order, and the notice has to stay between them.
  it("keeps each command's chunks in its own entry, in order", () => {
    const ui = play([
      { type: "turnStart", prompt: "hola" },
      { type: "toolStart", id: "c1", name: "shell" },
      { type: "toolOutput", id: "c1", name: "shell", chunk: "ls\n" },
      { type: "toolOutput", id: "c1", name: "shell", chunk: "done\n" },
      { type: "spawnSettled", handle: settled({ result: "ok" }) },
      { type: "toolStart", id: "c2", name: "read_file" },
      { type: "toolOutput", id: "c2", name: "read_file", chunk: "a.ts\n" },
      { type: "toolOutput", id: "c2", name: "read_file", chunk: "b.ts\n" },
      { type: "turnEnd" },
    ]);
    const tools = ui.of("tool");

    expect(tools).toHaveLength(2);
    expect(ui.text(tools[0]!)).toBe("→ shellls\ndone\n");
    expect(ui.text(tools[1]!)).toBe("→ read_filea.ts\nb.ts\n");
    // The notice of the settled child must sit between the two commands, not
    // inside either of them.
    expect(ui.lines.map((line) => line.role)).toEqual(["user", "tool", "notice", "tool"]);
  });
});

// Anchors are indices, so trimming the transcript has to move them. Covered
// on the pure helpers with a small budget; the adapter cases would need 400
// secondary entries to shift a single position.
describe("trimming the secondary entries", () => {
  const line = (role: string, text: string) => ({ role, text });

  it("re-bases every anchor on the new start", () => {
    const lines = ["a", "b", "c", "d"].map((id) => line("notice", id));
    const trimmed = trimAnchored(lines, { answer: 3, tool: 1 }, 2);

    expect(trimmed.lines.map((entry) => entry.text)).toEqual(["c", "d"]);
    expect(trimmed.anchors).toEqual({ answer: 1 });
  });

  it("never drops a message or an answer", () => {
    const lines = [
      line("user", "pregunta 1"),
      line("answer", "respuesta 1"),
      ...Array.from({ length: 10 }, (_, i) => line("notice", `log ${i}`)),
      line("user", "pregunta 2"),
      line("answer", "respuesta 2"),
    ];
    const trimmed = trimAnchored(lines, noAnchors(), 2);
    const kept = trimmed.lines.map((entry) => entry.text);

    // Every message and answer survives, wherever it sits in the transcript.
    for (const text of ["pregunta 1", "respuesta 1", "pregunta 2", "respuesta 2"]) {
      expect(kept).toContain(text);
    }
    // Only the two newest secondary entries are kept.
    expect(kept.filter((text) => text.startsWith("log"))).toEqual(["log 8", "log 9"]);
  });

  it("keeps writing into the open entry after a trim", () => {
    const lines = [
      line("notice", "a"),
      line("notice", "b"),
      line("notice", "c"),
      line("answer", "d"),
    ];
    const trimmed = trimAnchored(lines, { answer: 3 }, 2);
    const written = writeAnchored(
      trimmed.lines,
      trimmed.anchors,
      "answer",
      (open) => line("answer", `${open?.text ?? ""}+`),
      2,
    );

    expect(written.lines.map((entry) => entry.text)).toEqual(["b", "c", "d+"]);
    expect(written.anchors).toEqual({ answer: 2 });
  });

  it("opens a fresh entry when the anchored one fell out of the window", () => {
    const written = writeAnchored(
      [line("notice", "a"), line("notice", "b")],
      noAnchors(),
      "answer",
      () => line("answer", "x"),
      1,
    );

    expect(written.lines.map((entry) => entry.role)).toEqual(["notice", "answer"]);
    expect(written.anchors).toEqual({ answer: 1 });
  });

  it("never corrupts the indices of the adapter after trimming", () => {
    const ui = new Probe();

    ui.render({ type: "turnStart", prompt: "hola" });
    ui.render({ type: "text", delta: "respuesta" });

    for (let i = 0; i < 500; i += 1) {
      ui.render({ type: "notice", message: `log ${i}` });
    }

    ui.render({ type: "text", delta: " final" });
    ui.render({ type: "turnEnd" });

    const answers = ui.of("answer");

    expect(answers).toHaveLength(1);
    expect(ui.text(answers[0]!)).toBe("respuesta final");
  });

  it("keeps every message and answer across a long session", () => {
    const ui = new Probe();

    for (let i = 0; i < 500; i += 1) {
      ui.render({ type: "turnStart", prompt: `pregunta ${i}` });
      ui.render({ type: "text", delta: `respuesta ${i}` });
      ui.render({ type: "answer", text: `respuesta ${i}` });
      ui.render({ type: "notice", message: `log ${i}` });
      ui.render({ type: "turnEnd" });
    }

    const users = ui.lines.filter((line) => line.role === "user");

    expect(users).toHaveLength(500);
    expect(ui.of("answer")).toHaveLength(500);
    // The transcript is bounded on the noise, never on the conversation.
    expect(ui.of("notice").length).toBeLessThanOrEqual(400);
  });
});

// Source-level guard: going back to "the last entry is the open one" is the
// regression, and the adapter is the only place that can reintroduce it.
describe("transcript anchoring", () => {
  const source = readFileSync(new URL("../../src/ui/TuiUiAdapter.tsx", import.meta.url), "utf8");

  it("does not guess the open entry by position", () => {
    expect(source).not.toContain("lines.at(-1)");
  });

  it("anchors the three streamed roles", () => {
    for (const role of ['"answer"', '"reasoning"', '"tool"']) {
      expect(source).toContain(role);
    }
    expect(source).toContain("writeAnchored");
  });
});

// /resume loads another session: its conversation replaces the whole
// transcript, and the live strip of the session we left has no business on
// screen. `history` is left to spawnHistory, which the loop sends right after.
describe("the conversation of the session now in charge", () => {
  const switchTo = (entries: { role: "user" | "assistant"; content: string }[]): UiEvent[] => [
    { type: "turnStart", prompt: "de la sesión anterior" },
    { type: "text", delta: "respuesta anterior" },
    { type: "turnEnd" },
    { type: "spawn", handle: settled({ status: "running", finishedAt: undefined }) },
    { type: "notice", message: "log de la anterior" },
    { type: "conversation", entries },
  ];

  it("replaces the entries with the restored conversation", () => {
    const ui = play(
      switchTo([
        { role: "user", content: "pregunta vieja" },
        { role: "assistant", content: "respuesta vieja" },
      ]),
    );

    expect(ui.lines.map((line) => line.role)).toEqual(["user", "answer"]);
    expect(ui.text(0)).toBe("pregunta vieja");
    // Answers go through the markdown stream, like a live one.
    expect(ui.text(1)).toBe("respuesta vieja");
  });

  it("empties the live strip and the collapsed set of the previous session", () => {
    const ui = play(switchTo([{ role: "user", content: "hola" }]));

    const state = (ui as unknown as { state: TuiState }).state;

    expect(state.spawns).toEqual([]);
    expect(state.expanded.size).toBe(0);
  });

  it("keeps the restored children the loop sends next", () => {
    const handle = settled({ spawnId: "spawn-old", status: "done" });

    const ui = play([
      ...switchTo([{ role: "user", content: "hola" }]),
      { type: "spawnHistory", handles: [handle] },
    ]);

    expect((ui as unknown as { state: TuiState }).state.history.map((entry) => entry.id)).toEqual([
      "spawn-old",
    ]);
  });

  it("does not clear an empty transcript: nothing to show, nothing to do", () => {
    const ui = play([
      { type: "turnStart", prompt: "hola" },
      { type: "answer", text: "listo" },
      { type: "conversation", entries: [] },
    ]);

    expect(ui.lines.map((line) => line.role)).toEqual(["user", "answer"]);
  });
});
