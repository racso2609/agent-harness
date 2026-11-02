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
