import { describe, expect, it } from "vitest";
import type { SpawnEvent, SpawnHandle, SpawnStatus } from "../../src/index";

// The spawn lifecycle is part of the public surface: consumers (the CLI UI)
// must import it from the package entrypoint, never from the internal session
// module. These tests fail to typecheck if the re-exports are dropped, and fail
// at runtime if the event shape drifts.
describe("spawn contract surface", () => {
  it("exposes the lifecycle statuses", () => {
    const statuses: SpawnStatus[] = ["running", "done", "error", "cancelled"];

    expect(statuses).toHaveLength(4);
  });

  it("keeps the settled event carrying a complete handle", () => {
    const handle: SpawnHandle = {
      spawnId: "spawn-1",
      sessionId: "session-1",
      agentId: "coder",
      prompt: "implement the plan",
      status: "done",
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(1).toISOString(),
      result: "ok",
    };

    const event: SpawnEvent = { type: "settled", handle };

    expect(event.type).toBe("settled");
    expect(event.handle.agentId).toBe("coder");
    expect(event.handle.status).toBe("done");
    expect(event.handle.finishedAt).toBeDefined();
  });

  it("describes a started event without a result yet", () => {
    const event: SpawnEvent = {
      type: "started",
      handle: {
        spawnId: "spawn-2",
        sessionId: "session-2",
        agentId: "coder",
        prompt: "review",
        status: "running",
        startedAt: new Date(0).toISOString(),
      },
    };

    expect(event.handle.status).toBe("running");
    expect(event.handle.result).toBeUndefined();
    expect(event.handle.finishedAt).toBeUndefined();
  });
});
