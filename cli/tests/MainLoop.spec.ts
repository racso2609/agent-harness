import { afterEach, describe, expect, it, vi } from "vitest";
import type { IHarness } from "@racso2609/core";
import { MainLoop, SHUTDOWN_TIMEOUT_MS, type MainLoopOptions } from "../src/MainLoop";

// The loop's shutdown is the last thing that runs, and a harness close that
// never resolves used to keep the process alive for good: ink stayed mounted,
// and a second Ctrl-C could not re-enter because `closing` was already true.
// These cases boot a real MainLoop with a harness that hangs and prove the loop
// still leaves, on the deadline it documents.

// A renderer that records what it painted and paints nowhere else.
const makeUi = () => {
  const events: unknown[] = [];

  return {
    events,
    ui: {
      render: (event: unknown) => events.push(event),
      renderImage: async () => {},
      close: () => {},
      select: async () => undefined,
      promptText: async () => undefined,
      confirm: async () => undefined,
      promptApproval: async () => "deny",
    } as unknown as NonNullable<MainLoopOptions["ui"]>,
  };
};

// A harness stand-in: only the members shutdown() touches carry a meaning.
const makeHarness = (shutdown: () => Promise<void>) => ({ shutdown }) as unknown as IHarness;

const boot = (shutdown: () => Promise<void>) => {
  const exits: number[] = [];
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exits.push(code ?? 0);
  }) as never);

  const { events, ui } = makeUi();
  const loop = new MainLoop({ ui });
  loop.harness = makeHarness(shutdown);

  return { exits, events, loop };
};

const notices = (events: unknown[]): string[] =>
  events.flatMap((event) => {
    const notice = event as { type?: string; message?: string };
    return notice.type === "notice" && notice.message ? [notice.message] : [];
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MainLoop shutdown", () => {
  it("leaves and warns when the harness shutdown never resolves", async () => {
    const { exits, events, loop } = boot(() => new Promise<void>(() => {}));

    const started = Date.now();
    await loop.shutdown(0);

    // Bounded by the documented deadline, not by the hanging close.
    expect(Date.now() - started).toBeLessThan(SHUTDOWN_TIMEOUT_MS + 2_000);
    expect(exits).toEqual([0]);
    // The user is told what it gave up on, and that the kill is already gone.
    expect(notices(events)).toEqual([
      `closing the MCP servers is taking longer than ${SHUTDOWN_TIMEOUT_MS} ms: exiting anyway, the signal was already sent`,
    ]);
  });

  it("exits right away when the harness shutdown resolves", async () => {
    const { exits, events, loop } = boot(async () => {});

    const started = Date.now();
    await loop.shutdown(0);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(exits).toEqual([0]);
    expect(notices(events)).toEqual([]);
  });

  it("reports the failure the harness names instead of a generic notice", async () => {
    const { exits, events, loop } = boot(async () => {
      throw new Error("failed to close the mcp servers: boom");
    });

    await loop.shutdown(0);

    expect(exits).toEqual([0]);
    expect(notices(events)).toEqual([
      "shutdown failed: Error: failed to close the mcp servers: boom",
    ]);
  });
});
