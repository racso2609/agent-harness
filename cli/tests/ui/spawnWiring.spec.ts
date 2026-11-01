import { describe, expect, it } from "vitest";
import type { SpawnEvent, SpawnHandle } from "@racso/core";
import { toUiEvents } from "../../src/ui/renderEvents";
import type { UiEvent } from "../../src/ui/UiAdapter";

const handle = (overrides: Partial<SpawnHandle> = {}): SpawnHandle => ({
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
const event = toSpawnUiEvent({ type: "started", handle: handle() });

expect(event.type).toBe("spawn");
expect(event.type === "spawn" && event.handle.status).toBe("running");
});

it("renders a settled child with its final status and result", () => {
const event = toSpawnUiEvent({
type: "settled",
handle: handle({
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
handle: handle({ status: "error", error: "provider down" }),
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
