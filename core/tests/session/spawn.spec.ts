import { describe, expect, it, vi } from "vitest";
import {
  CANCELLED_SUMMARY,
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

  it("settles a cancelled child as cancelled, not as failed", async () => {
    let seenSignal: AbortSignal | undefined;
    const manager = makeManager(async ({ signal }) => {
      seenSignal = signal;
      // Rejects with another ordinary error, the way a real runner gives up;
      // the status must still come from the abort reason.
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    });

    const handle = manager.spawn({ agentId: "a", sessionId: "s", prompt: "x" });
    await Promise.resolve();

    expect(manager.cancel(handle.spawnId)).toBe(true);
    expect(seenSignal?.aborted).toBe(true);

    const settled = await manager.wait(handle.spawnId);
    expect(settled).toMatchObject({
      status: "cancelled",
      summary: CANCELLED_SUMMARY,
      result: undefined,
      error: undefined,
    });
    expect(settled?.finishedAt).toBeDefined();
    expect(settled?.durationMs).toBeDefined();
    // A second cancel finds the child settled and is rejected, not thrown.
    expect(manager.cancel(handle.spawnId)).toBe(false);
  });

  it("keeps an error the child raised before a late abort", async () => {
    const manager = makeManager(async ({ signal }) => {
      // Fails on its own, and only then notices the abort.
      throw new Error(signal.aborted ? "aborted" : "child blew up");
    });

    const handle = manager.spawn({ agentId: "a", sessionId: "s", prompt: "x" });
    // The runner rejects before the cancel is delivered, so the abort is
    // late: it must not throw the child's own error away.
    const settled = await manager.wait(handle.spawnId);

    expect(manager.cancel(handle.spawnId)).toBe(false);
    expect(settled).toMatchObject({ status: "error", error: "child blew up" });
  });

  it("accepts a second cancel while the abort is still in flight only once", async () => {
    const gate = deferred();
    let seenSignal: AbortSignal | undefined;
    const manager = makeManager(async ({ signal }) => {
      seenSignal = signal;
      // The runner notices the abort but keeps running for a while: the job is
      // unsettled, so only the "already aborting" guard stops a second cancel
      // from signalling it again.
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      await gate.promise;
      throw signal.reason;
    });
    const settledEvents: string[] = [];
    manager.on((event) => {
      if (event.type === "settled") settledEvents.push(event.handle.status);
    });

    const handle = manager.spawn({ agentId: "a", sessionId: "s", prompt: "x" });
    await Promise.resolve();

    expect(manager.cancel(handle.spawnId)).toBe(true);
    expect(seenSignal?.aborted).toBe(true);
    expect(manager.poll(handle.spawnId)?.status).toBe("running");
    // The abort was delivered but has not settled: a second cancel must not
    // pretend it delivered anything new.
    expect(manager.cancel(handle.spawnId)).toBe(false);

    gate.resolve();
    const settled = await manager.wait(handle.spawnId);

    expect(settled?.status).toBe("cancelled");
    expect(settledEvents).toEqual(["cancelled"]);
  });

  it("reports false when cancelling an unknown or an already settled child", async () => {
    const gate = deferred();
    const manager = makeManager(async ({ prompt }) => {
      if (prompt === "fail") throw new Error("boom");
      await gate.promise;
      return { text: "ok" };
    });

    const done = manager.spawn({ agentId: "a", sessionId: "s", prompt: "ok" });
    const failed = manager.spawn({ agentId: "a", sessionId: "s", prompt: "fail" });
    await manager.wait(failed.spawnId);

    expect(manager.cancel(failed.spawnId)).toBe(false);
    expect(manager.cancel("spawn-unknown")).toBe(false);

    gate.resolve();
    await manager.wait(done.spawnId);
    expect(manager.cancel(done.spawnId)).toBe(false);
  });

  it("emits a single settled event when cancel and timeout race", async () => {
    const manager = makeManager(
      async ({ signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
      { timeoutMs: 5 },
    );
    const events: string[] = [];
    manager.on((event) => {
      if (event.type === "settled") events.push(event.handle.status);
    });

    const handle = manager.spawn({ agentId: "a", sessionId: "s", prompt: "x" });
    await Promise.resolve();

    // Cancel wins the race: it aborts first, so the timeout that fires later
    // finds the same controller already aborted and cannot change the outcome.
    expect(manager.cancel(handle.spawnId)).toBe(true);
    const settled = await manager.wait(handle.spawnId);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(settled?.status).toBe("cancelled");
    expect(events).toEqual(["cancelled"]);
  });

  it("keeps the timeout outcome when the timeout wins the race", async () => {
    const manager = makeManager(
      async ({ signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
      { timeoutMs: 5 },
    );
    const events: string[] = [];
    manager.on((event) => {
      if (event.type === "settled") events.push(event.handle.status);
    });

    const handle = manager.spawn({ agentId: "a", sessionId: "s", prompt: "x" });
    const settled = await manager.wait(handle.spawnId);

    // The child already settled, so a cancel arriving afterwards is rejected
    // instead of rewriting the outcome.
    expect(settled?.status).toBe("error");
    expect(manager.cancel(handle.spawnId)).toBe(false);
    expect(events).toEqual(["error"]);
  });

  it("settles a child cancelled while queued without arming its timeout budget", async () => {
    const firstGate = deferred();
    const started: string[] = [];
    let firstSpawnId = "";

    const manager = makeManager(
      async ({ spawnId, signal }) => {
        started.push(spawnId);

        // Occupies the only slot long enough that the budget of the queued child
        // would elapse if run() armed one for it.
        if (spawnId === firstSpawnId) {
          await firstGate.promise;
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { text: "first" };
        }

        // The queued child reaches this line with the abort already delivered,
        // because its slot only opens once the first child released it.
        if (signal.aborted) throw signal.reason;

        return { text: "second" };
      },
      { maxChildren: 1, timeoutMs: 5 },
    );

    const first = manager.spawn({ agentId: "a", sessionId: "s", prompt: "first" });
    firstSpawnId = first.spawnId;
    const queued = manager.spawn({ agentId: "a", sessionId: "s", prompt: "second" });
    await Promise.resolve();
    expect(started).toEqual([first.spawnId]);

    // Cancelled while it waits for the slot: there is no runner yet, so the
    // abort only lands on the signal the child finds when the slot opens.
    expect(manager.cancel(queued.spawnId)).toBe(true);

    firstGate.resolve();
    await manager.wait(first.spawnId);
    // Well past the point where a budget armed at run() would have fired.
    await new Promise((resolve) => setTimeout(resolve, 40));
    const settledQueued = await manager.wait(queued.spawnId);

    // The child stopped on the reason it was given, not on a budget it never
    // used: with the budget armed it would have settled as an error.
    expect(settledQueued).toMatchObject({
      status: "cancelled",
      summary: CANCELLED_SUMMARY,
      error: undefined,
    });
  });

  it("arms no budget for a child cancelled before it was dispatched", async () => {
    // startTimeout() guards on the signal, not only on the terminal flag. A job
    // cancelled after spawn() but before its run() started has never been
    // settled, so the flag is still false when the budget is armed: without the
    // signal guard the child is given a timeout for work it will never do, and
    // the timeout then overwrites the cancellation with an outcome the user
    // never asked for.
    const manager = makeManager(async () => ({ text: "quick" }), { timeoutMs: 40 });

    // Swallow startTimeout() so the job produced here stays undecided: that is
    // the state a real job is in between spawn() and run(), and the one that
    // makes the signal guard the only thing standing between it and a budget.
    const self = manager as unknown as {
      startTimeout: (job: unknown) => unknown;
      jobs: Map<string, Parameters<typeof self.startTimeout>[0]>;
    };
    const startTimeout = vi.spyOn(self, "startTimeout").mockReturnValue(undefined);
    const handle = manager.spawn({ agentId: "a", sessionId: "s", prompt: "x" });
    const job = self.jobs.get(handle.spawnId)!;
    expect(job.terminal).toBe(false);
    expect(manager.cancel(handle.spawnId)).toBe(true);
    startTimeout.mockRestore();

    // Called exactly the way run() calls it, on a job that is aborted but not
    // yet settled.
    expect(self.startTimeout(job)).toBeUndefined();
  });

  it("keeps a cancelled handle free of the aborted request error", async () => {
    // A real runner rejects with the provider error the abort caused. That error
    // is the abort talking, not the child failing, so the handle must not carry
    // it: a cancelled child is not a failed child.
    const manager = makeManager(
      async ({ signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("provider: aborted"))),
        ),
    );

    const handle = manager.spawn({ agentId: "a", sessionId: "s", prompt: "x" });
    await Promise.resolve();
    expect(manager.cancel(handle.spawnId)).toBe(true);

    const settled = await manager.wait(handle.spawnId);

    expect(settled).toMatchObject({
      status: "cancelled",
      error: undefined,
      summary: CANCELLED_SUMMARY,
    });
  });

  it("settles as cancelled as soon as the abort lands, not when the runner lets go", async () => {
    const releaseRunner = deferred();
    let runnerSawAbort = false;
    const manager = makeManager(
      ({ signal }) =>
        new Promise((_, reject) => {
          // A runner that hangs after noticing the abort: the settlement must not
          // wait for it, so nothing below depends on it finishing.
          signal.addEventListener("abort", () => {
            runnerSawAbort = true;
            reject(signal.reason);
          });
          releaseRunner.promise.then(() => reject(signal.reason));
        }),
    );

    const handle = manager.spawn({ agentId: "a", sessionId: "s", prompt: "x" });
    await Promise.resolve();
    expect(manager.cancel(handle.spawnId)).toBe(true);
    expect(runnerSawAbort).toBe(true);

    // Let the settlement frame run. The runner still holds its promise open,
    // so the status flipping here proves the settlement does not wait for it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.poll(handle.spawnId)?.status).toBe("cancelled");

    releaseRunner.resolve();
    await manager.wait(handle.spawnId);
  });

  it("records a cancel request that arrives too late to change anything", async () => {
    const manager = makeManager(async () => ({ text: "already done" }));

    const handle = manager.spawn({ agentId: "a", sessionId: "s", prompt: "x" });
    const settled = await manager.wait(handle.spawnId);

    expect(settled?.cancelRequestedAt).toBeUndefined();
    // The child already finished: the abort cannot be delivered...
    expect(manager.cancel(handle.spawnId)).toBe(false);
    // ...but the user did ask, and the handle keeps saying so.
    const stamped = manager.poll(handle.spawnId);

    expect(stamped?.status).toBe("done");
    expect(stamped?.cancelRequestedAt).toBeDefined();
    expect(Number.isNaN(Date.parse(stamped!.cancelRequestedAt!))).toBe(false);
  });

  it("keeps the first cancel request when a second one arrives in flight", async () => {
    const releaseRunner = deferred();
    const manager = makeManager(
      ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
          releaseRunner.promise.then(() => reject(signal.reason));
        }),
    );

    const handle = manager.spawn({ agentId: "a", sessionId: "s", prompt: "x" });
    await Promise.resolve();
    expect(manager.cancel(handle.spawnId)).toBe(true);

    const first = manager.poll(handle.spawnId)?.cancelRequestedAt;
    expect(first).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 5));
    // Rejected, because the abort is already in flight, and the timestamp must
    // not move: the first request is when the user gave up.
    expect(manager.cancel(handle.spawnId)).toBe(false);
    expect(manager.poll(handle.spawnId)?.cancelRequestedAt).toBe(first);

    releaseRunner.resolve();
    await manager.wait(handle.spawnId);
  });

  it("leaves cancelRequestedAt undefined for a child nobody cancelled", async () => {
    const manager = makeManager(async () => ({ text: "ok" }));

    const handle = manager.spawn({ agentId: "a", sessionId: "s", prompt: "x" });
    const settled = await manager.wait(handle.spawnId);

    expect(settled?.cancelRequestedAt).toBeUndefined();
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
