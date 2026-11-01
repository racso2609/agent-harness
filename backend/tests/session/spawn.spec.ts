import { describe, expect, it, vi } from "vitest";
import {
  SpawnHandle,
  SpawnManager,
  SpawnManagerOptions,
} from "../../src/session/spawn";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

const makeManager = (
  runner: SpawnManagerOptions["runner"],
  options: Partial<SpawnManagerOptions> = {},
) => {
  let counter = 0;
  return new SpawnManager({
    runner,
    idFactory: () => `id-${++counter}`,
    ...options,
  });
};

describe("SpawnManager", () => {
  it("returns a running handle immediately and settles later", async () => {
    const gate = deferred();
    const manager = makeManager(async ({ prompt }) => {
      await gate.promise;
      return { text: `echo:${prompt}` };
    });

    const handle = manager.spawn({
      agentId: "coder",
      sessionId: "session-parent",
      prompt: "hello",
    });

    expect(handle).toMatchObject({
      spawnId: "spawn-id-1",
      agentId: "coder",
      sessionId: "session-parent",
      status: "running",
    });
    expect(manager.poll(handle.spawnId)?.status).toBe("running");

    gate.resolve();
    const settled = await manager.wait(handle.spawnId);

    expect(settled).toMatchObject({ status: "done", result: "echo:hello" });
    expect(settled?.finishedAt).toBeDefined();
  });

  it("captures runner errors as an error handle", async () => {
    const manager = makeManager(async () => {
      throw new Error("boom");
    });

    const handle = manager.spawn({
      agentId: "coder",
      sessionId: "s",
      prompt: "x",
    });
    const settled = await manager.wait(handle.spawnId);

    expect(settled).toMatchObject({ status: "error", error: "boom" });
  });

  it("passes context through to the runner", async () => {
    const runner = vi.fn(async () => ({ text: "ok" }));
    const manager = makeManager(runner);

    const handle = manager.spawn({
      agentId: "coder",
      sessionId: "s",
      prompt: "task",
      context: "shared context",
    });
    await manager.wait(handle.spawnId);

    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "task", context: "shared context" }),
    );
  });

  it("bounds concurrency to maxChildren and runs the rest in FIFO order", async () => {
    const gates = [deferred(), deferred(), deferred()];
    const started: string[] = [];
    let active = 0;
    let peak = 0;

    const manager = makeManager(
      async ({ spawnId }) => {
        const index = started.length;
        started.push(spawnId);
        active += 1;
        peak = Math.max(peak, active);
        await gates[index]?.promise;
        active -= 1;
        return { text: spawnId };
      },
      { maxChildren: 2 },
    );

    const a = manager.spawn({ agentId: "a", sessionId: "s", prompt: "1" });
    const b = manager.spawn({ agentId: "b", sessionId: "s", prompt: "2" });
    const c = manager.spawn({ agentId: "c", sessionId: "s", prompt: "3" });

    await Promise.resolve();
    expect(active).toBe(2);
    expect(started).toEqual([a.spawnId, b.spawnId]);

    gates[0].resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([a.spawnId, b.spawnId, c.spawnId]);

    gates[1].resolve();
    gates[2].resolve();
    await manager.collect();
    expect(peak).toBe(2);
  });

  it("collect returns every handle by default and only the requested ids otherwise", async () => {
    const manager = makeManager(async ({ prompt }) => ({ text: prompt }));

    const a = manager.spawn({ agentId: "a", sessionId: "s", prompt: "one" });
    const b = manager.spawn({ agentId: "a", sessionId: "s", prompt: "two" });

    const all = await manager.collect();
    expect(all.map((h: SpawnHandle) => h.result).sort()).toEqual(["one", "two"]);

    const justA = await manager.collect([a.spawnId]);
    expect(justA).toHaveLength(1);
    expect(justA[0].spawnId).toBe(a.spawnId);
    expect(manager.poll(b.spawnId)).toBeDefined();
  });

  it("aborts a running child on cancel", async () => {
    let seenSignal: AbortSignal | undefined;
    const manager = makeManager(async ({ signal }) => {
      seenSignal = signal;
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
      return { text: "unreachable" };
    });

    const handle = manager.spawn({ agentId: "a", sessionId: "s", prompt: "x" });
    await Promise.resolve();

    expect(manager.cancel(handle.spawnId)).toBe(true);
    expect(seenSignal?.aborted).toBe(true);

    const settled = await manager.wait(handle.spawnId);
    expect(settled?.status).toBe("error");
    expect(manager.cancel(handle.spawnId)).toBe(false);
  });

  it("returns undefined for unknown spawn ids", async () => {
    const manager = makeManager(async () => ({ text: "ok" }));

    expect(manager.poll("nope")).toBeUndefined();
    await expect(manager.wait("nope")).resolves.toBeUndefined();
  });

  it("emits started then settled events with handles", async () => {
    const events: Array<{ type: string; spawnId: string; status: string }> = [];
    const manager = makeManager(async () => ({ text: "done" }));
    manager.on((event) =>
      events.push({
        type: event.type,
        spawnId: event.handle.spawnId,
        status: event.handle.status,
      }),
    );

    const handle = manager.spawn({ agentId: "a", sessionId: "s", prompt: "x" });
    await manager.wait(handle.spawnId);

    expect(events).toEqual([
      { type: "started", spawnId: handle.spawnId, status: "running" },
      { type: "settled", spawnId: handle.spawnId, status: "done" },
    ]);
  });

  it("emits a settled event with error status when the child fails", async () => {
    const events: string[] = [];
    const manager = makeManager(async () => {
      throw new Error("nope");
    });
    manager.on((event) => events.push(`${event.type}:${event.handle.status}`));

    const handle = manager.spawn({ agentId: "a", sessionId: "s", prompt: "x" });
    await manager.wait(handle.spawnId);

    expect(events).toEqual(["started:running", "settled:error"]);
  });

  it("stops notifying after unsubscribe", async () => {
    let calls = 0;
    const manager = makeManager(async () => ({ text: "ok" }));
    const off = manager.on(() => (calls += 1));

    off();
    const handle = manager.spawn({ agentId: "a", sessionId: "s", prompt: "x" });
    await manager.wait(handle.spawnId);

    expect(calls).toBe(0);
  });

  it("keeps the lifecycle running when a listener throws", async () => {
    const manager = makeManager(async () => ({ text: "ok" }));
    manager.on(() => {
      throw new Error("listener boom");
    });

    const handle = manager.spawn({ agentId: "a", sessionId: "s", prompt: "x" });
    const settled = await manager.wait(handle.spawnId);

    expect(settled?.status).toBe("done");
  });
});
