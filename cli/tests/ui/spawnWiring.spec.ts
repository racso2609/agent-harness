import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { IHarness, SpawnEvent, SpawnHandle } from "@racso/core";
import { showChildHistory } from "../../src/MainLoop";
import { toUiEvents } from "../../src/ui/renderEvents";
import type { UiEvent } from "../../src/ui/UiAdapter";

const makeHandle = (overrides: Partial<SpawnHandle> = {}): SpawnHandle => ({
  spawnId: "spawn-1",
  sessionId: "session-1",
  agentId: "coder",
  prompt: "implement",
  status: "running",
  startedAt: new Date(0).toISOString(),
  ...overrides,
});

// MainLoop forwards spawn lifecycle straight to the UI; this pins the mapping
// it applies so a child starting or settling cannot become invisible again.
const toSpawnUiEvent = (event: SpawnEvent): UiEvent =>
  event.type === "started"
    ? { type: "spawn", handle: event.handle }
    : { type: "spawnSettled", handle: event.handle };

describe("spawn wiring", () => {
  it("renders a started child with its running status", () => {
    const event = toSpawnUiEvent({ type: "started", handle: makeHandle() });

    expect(event.type).toBe("spawn");
    expect(event.type === "spawn" && event.handle.status).toBe("running");
  });

  it("renders a settled child with its final status and result", () => {
    const event = toSpawnUiEvent({
      type: "settled",
      handle: makeHandle({
        status: "done",
        finishedAt: new Date(1_000).toISOString(),
        result: "ok",
      }),
    });

    expect(event.type).toBe("spawnSettled");
    expect(event.type === "spawnSettled" && event.handle.status).toBe("done");
    expect(event.type === "spawnSettled" && event.handle.result).toBe("ok");
  });

  it("keeps the error message of a failed child", () => {
    const event = toSpawnUiEvent({
      type: "settled",
      handle: makeHandle({ status: "error", error: "provider down" }),
    });

    expect(event.type === "spawnSettled" && event.handle.error).toBe("provider down");
  });

  it("does not confuse a chat event with a spawn event", () => {
    // Both vocabularies flow through render(); the tool event must not be
    // mistaken for a child lifecycle event.
    const tool = toUiEvents({ type: "toolCallStart", id: "c1", name: "shell" });

    expect(tool).toEqual([{ type: "toolStart", id: "c1", name: "shell" }]);
  });
});

// A resumed session must not start with an empty strip: the children the
// session launched before are persisted, and only childHistory() knows about
// them. The first two cases drive the helper; the last two are wiring guards
// (source-level) because MainLoop runs a stdin loop and cannot be mounted here.
describe("children of a resumed session", () => {
  const ui = () => {
    const events: UiEvent[] = [];

    return { events, render: (event: UiEvent) => events.push(event) };
  };

  const harnessWith = (handles: SpawnHandle[]) =>
    ({ childHistory: () => handles }) as unknown as IHarness;

  it("sends the persisted children to the renderer", () => {
    const renderer = ui();
    const handle = makeHandle({ spawnId: "spawn-old", status: "done" });

    showChildHistory(harnessWith([handle]), renderer);

    expect(renderer.events).toEqual([{ type: "spawnHistory", handles: [handle] }]);
  });

  it("stays silent when the session never spawned a child", () => {
    // Otherwise every new session would open with an empty strip box.
    const renderer = ui();

    showChildHistory(harnessWith([]), renderer);

    expect(renderer.events).toEqual([]);
  });

  const mainLoop = readFileSync(new URL("../../src/MainLoop.ts", import.meta.url), "utf8");

  it("does not ship them before the session is initialized", () => {
    const boot = mainLoop.indexOf("await this.harness.initialize(");
    const history = mainLoop.indexOf("showChildHistory(this.harness, this.ui)");

    expect(boot).toBeGreaterThan(-1);
    expect(history).toBeGreaterThan(boot);
  });

  it("refreshes them when a command switched the session", () => {
    // A command handler can load another session; the strip would otherwise
    // keep showing the children of the session we just left.
    expect(mainLoop).toContain("this.harness.status().sessionId !== before");
  });
});

// A child that settles with work left starts a turn on its own; the rule lives
// in src/ui/continuation.ts and is tested there, so these guards only pin the
// wiring: which points call it and what MainLoop does with its verdict. They
// read the source because MainLoop runs a stdin loop and cannot be mounted.
describe("continuation wiring", () => {
const mainLoop = readFileSync(new URL("../../src/MainLoop.ts", import.meta.url), "utf8");
const between = (from: string, to: string) => {
const start = mainLoop.indexOf(from);
const end = mainLoop.indexOf(to);

expect(start).toBeGreaterThan(-1);
expect(end).toBeGreaterThan(start);

return mainLoop.slice(start, end);
};

it("evaluates the continuation after a child settles", () => {
// Without this call a child finishing while the session waits for a prompt
// leaves its work undelivered until the user types something.
const settled = between("this.harness.onSpawnEvent(", "if (this.isTui())");

expect(settled).toContain('if (event.type === "settled") this.maybeContinue();');
// A child starting changes no work.
expect(settled).not.toContain('event.type === "started") this.maybeContinue()');
});

it("evaluates it again when a turn ends", () => {
// This is the only path that continues a child that settled mid-turn or
// behind an approval dialog: ask() held the loop, so the settle itself
// could not start anything.
const turn = between('this.ui.render({ type: "turnEnd"', "} catch (err) {");

expect(turn).toContain("this.maybeContinue();");
});

it("asks the core what is still undelivered instead of trusting the event", () => {
// A settle event says a child finished, not that its result is still owed.
const body = between("protected maybeContinue()", "protected isWaitingForPrompt()");

expect(body).toContain("this.harness.pendingSpawns()");
expect(body).toContain("continuationDecision(");
expect(body).toContain("this.isWaitingForPrompt()");
expect(body).toContain("this.hasUserDraft()");
});

it("only continues while the loop waits with nothing queued", () => {
// With a continuation already queued or a turn in flight, starting another
// would run two turns for the same batch.
const body = between("protected isWaitingForPrompt()", "protected hasUserDraft()");

expect(body).toContain("this.pending !== null");
expect(body).toContain("this.queue.length === 0");
});

it("queues the continuation through enqueue, marked as such", () => {
// The mark is what lets a user prompt drop it; enqueue is the only way in.
const body = between("protected maybeContinue()", "protected isWaitingForPrompt()");

expect(body).toContain('this.enqueue(CONTINUATION_PROMPT, "continuation")');
});

it("says it is waiting at most once per undelivered batch", () => {
// The box reports every keystroke: without the batch key the notice would
// repeat on each one.
const body = between("protected maybeContinue()", "protected isWaitingForPrompt()");

expect(body).toContain("batchKey(pending)");
expect(body).toContain("this.noticedBatch !== key");
expect(body).toContain("this.noticedBatch = key");
});

it("drops queued continuations when the user sends a prompt", () => {
// Otherwise the user's prompt is followed by a turn doing the same work.
const body = between("protected enqueueFromUser(", "// Starts a turn on its own");

expect(body).toContain("dropContinuations(this.queue)");
expect(body).toContain("CONTINUATION_DROPPED_NOTICE");
expect(mainLoop).toContain("onSubmit: (prompt) => this.enqueueFromUser(prompt)");
});

it("never continues in line mode", () => {
// The line renderer reads stdin itself: no parked resolver, no draft, so a
// continuation could only steal a turn the user is typing into.
const body = between("protected nextPrompt()", "protected async loop()");

expect(body).toContain("if (!this.isTui())");
expect(body.indexOf("maybeContinue")).toBe(-1);
});

it("feeds the draft signal the TUI reports", () => {
// Without this the loop cannot know the user is half-way through a thought
// and would start a turn over their text.
expect(mainLoop).toContain("onDraftChange: () => this.maybeContinue()");
});
});
