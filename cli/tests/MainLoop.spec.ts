import { afterEach, describe, expect, it, vi } from "vitest";
import type { IHarness } from "@racso2609/core";
import { MainLoop, SHUTDOWN_TIMEOUT_MS, type MainLoopOptions } from "../src/MainLoop";

// The loop's shutdown is the last thing that runs, and a close that never
// resolves used to keep the process alive for good: ink stayed mounted, and a
// second Ctrl-C could not re-enter because `closing` was already true. These
// cases boot a real MainLoop over a harness stand-in and prove the loop still
// leaves, on the deadline it documents, without waiting for it in real time.

// A renderer that records what it painted and paints nowhere else.
const makeUi = () => {
  const events: unknown[] = [];
  const closed = vi.fn();

  return {
    events,
    closed,
    ui: {
      render: (event: unknown) => events.push(event),
      renderImage: async () => {},
      close: closed,
      select: async () => undefined,
      promptText: async () => undefined,
      confirm: async () => undefined,
      promptApproval: async () => "deny",
    } as unknown as NonNullable<MainLoopOptions["ui"]>,
  };
};

// Handlers installed by installKeyHandlers(), removed after each case so a
// SIGINT does not leak into the next one.
const installed: ((...args: unknown[]) => void)[] = [];

// Installs the real SIGINT handler of the loop, so the case exercises what
// installKeyHandlers wires and not a stand-in.
const listen = (loop: MainLoop) => {
  const before = process.listeners("SIGINT");
  loop["installKeyHandlers"]();
  for (const handler of process.listeners("SIGINT")) {
    if (!before.includes(handler)) installed.push(handler as (...args: unknown[]) => void);
  }
};

// A harness stand-in: only the half of IHarness that shutdown() drives carries
// a meaning, and both halves are spies so a case can see they were called.
const makeHarness = (parts: { save?: () => void; closeMcp?: () => Promise<void> }) => {
  const save = vi.fn(parts.save ?? (() => {}));
  const closeMcp = vi.fn(parts.closeMcp ?? (async () => {}));

  return { harness: { save, closeMcp } as unknown as IHarness, save, closeMcp };
};

const boot = (parts: { save?: () => void; closeMcp?: () => Promise<void> } = {}) => {
  const exits: number[] = [];
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exits.push(code ?? 0);
  }) as never);

  const { events, closed, ui } = makeUi();
  const loop = new MainLoop({ ui });
  const { harness, save, closeMcp } = makeHarness(parts);
  loop.harness = harness;

  return { exits, events, closed, loop, save, closeMcp };
};

const notices = (events: unknown[]): string[] =>
  events.flatMap((event) => {
    const notice = event as { type?: string; message?: string };
    return notice.type === "notice" && notice.message ? [notice.message] : [];
  });

afterEach(() => {
  for (const handler of installed.splice(0)) process.off("SIGINT", handler as never);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("MainLoop shutdown", () => {
  it("leaves and warns when the MCP close never resolves", async () => {
    vi.useFakeTimers();
    const { exits, events, loop } = boot({ closeMcp: () => new Promise<void>(() => {}) });

    const done = loop.shutdown(0);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);
    await done;

    expect(exits).toEqual([0]);
    // The goodbye is painted before waiting; the warning after it no longer claims
    // the signal was already sent, because a server may outlive the process.
    expect(notices(events)).toEqual([
      "closing the MCP servers...",
      `closing the MCP servers is taking longer than ${SHUTDOWN_TIMEOUT_MS} ms: exiting anyway, a server that ignores the signal may outlive this process`,
    ]);
  });

  it("exits right away when the MCP close resolves", async () => {
    vi.useFakeTimers();
    const { exits, events, loop } = boot();

    const done = loop.shutdown(0);
    await vi.advanceTimersByTimeAsync(0);
    await done;

    expect(exits).toEqual([0]);
    // Only the goodbye: nothing hung, so there is nothing to warn about.
    expect(notices(events)).toEqual(["closing the MCP servers..."]);
  });

  it("leaves no timer behind when the wait is won by the close", async () => {
    vi.useFakeTimers();
    const { loop } = boot();

    const done = loop.shutdown(0);
    await vi.advanceTimersByTimeAsync(0);
    await done;

    // The deadline timer of bounded() is unref'd, so a leaked one would not keep
    // the process alive: this is the only place that notices it.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("saves the session before it closes the servers", async () => {
    vi.useFakeTimers();
    const { exits, loop, save, closeMcp } = boot();
    const order: string[] = [];
    save.mockImplementation(() => order.push("save"));
    closeMcp.mockImplementation(async () => order.push("close"));

    const done = loop.shutdown(0);
    await vi.advanceTimersByTimeAsync(0);
    await done;

    expect(order).toEqual(["save", "close"]);
    expect(exits).toEqual([0]);
  });

  it("reports a save that throws and still closes the servers", async () => {
    vi.useFakeTimers();
    const { exits, events, loop, closeMcp } = boot({
      save: () => {
        throw new Error("disk full");
      },
    });

    const done = loop.shutdown(0);
    await vi.advanceTimersByTimeAsync(0);
    await done;

    expect(closeMcp).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([0]);
    expect(notices(events)).toEqual([
      "closing the MCP servers...",
      "failed to persist session on shutdown: Error: disk full",
    ]);
  });

  it("reports a close that throws", async () => {
    vi.useFakeTimers();
    const { exits, events, loop } = boot({
      closeMcp: async () => {
        throw new Error("boom");
      },
    });

    const done = loop.shutdown(0);
    await vi.advanceTimersByTimeAsync(0);
    await done;

    expect(exits).toEqual([0]);
    expect(notices(events)).toEqual([
      "closing the MCP servers...",
      "failed to close the mcp servers: Error: boom",
    ]);
  });
});

describe("MainLoop Ctrl-C", () => {
  it("closes the terminal and exits when a second SIGINT arrives during the wait", async () => {
    vi.useFakeTimers();
    const { exits, closed, loop } = boot({ closeMcp: () => new Promise<void>(() => {}) });
    listen(loop);

    // The first Ctrl-C starts the shutdown and parks on the hanging close.
    process.emit("SIGINT");
    await vi.advanceTimersByTimeAsync(0);
    expect(exits).toEqual([]);

    // The second one does not wait for the deadline: it releases the terminal and
    // leaves with the code of an interrupted run.
    process.emit("SIGINT");

    expect(closed).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([130]);
  });
});
