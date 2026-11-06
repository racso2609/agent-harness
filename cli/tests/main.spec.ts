import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MainLoopOptions } from "../src/MainLoop";

// The boot sequence of main.ts is what turns flags into a session, and nothing
// else in the suite imports it: a regression there (dropping the session id on
// the way to `loop.start`) left every other test green. These cases run the
// real `run()` with the loop, the terminal output and the process stubbed out.
const printLogo = vi.fn();
vi.mock("../src/terminal/stdin", () => ({ printLogo }));

const { run } = await import("../src/main");

interface Recorded {
  stdout: string[];
  stderr: string[];
  exits: number[];
  starts: (MainLoopOptions | undefined)[];
  loops: { tui: boolean }[];
}

// Runs the real boot sequence for one argv and reports what it did.
const boot = async (argv: string[]) => {
  const recorded: Recorded = { stdout: [], stderr: [], exits: [], starts: [], loops: [] };

  await run({
    argv: ["node", "main.js", ...argv],
    stdout: { write: (chunk) => recorded.stdout.push(chunk) },
    stderr: { write: (chunk) => recorded.stderr.push(chunk) },
    exit: (code) => recorded.exits.push(code),
    logo: printLogo,
    version: () => "9.9.9",
    createLoop: (options) => {
      recorded.loops.push(options);
      return {
        start: async (startOptions) => {
          recorded.starts.push(startOptions);
        },
      };
    },
  });

  return recorded;
};

// `MainLoop` is replaced by createLoop, so the harness only has to prove that
// the resolution rule of the loop is the one main.ts relies on. The real loop
// is exercised end to end by tests/ui/resumeWiring.spec.ts.
beforeEach(() => {
  vi.clearAllMocks();
});

describe("the boot sequence of the CLI", () => {
  it("forwards the resolved id of --resume to start", async () => {
    // The plain id and the two other spellings of the same session: whatever
    // the user typed has to reach the loop, or the run boots a new session.
    for (const target of ["session-a1b2c3", "session-a1", "1"]) {
      const recorded = await boot(["--resume", target]);

      expect(recorded.starts).toEqual([{ sessionId: target, resumeLatest: undefined }]);
      expect(recorded.exits).toEqual([]);
    }
  });

  it("asks for the most recent session on a bare --resume", async () => {
    const recorded = await boot(["--resume"]);

    expect(recorded.starts).toEqual([{ sessionId: undefined, resumeLatest: true }]);
    expect(recorded.exits).toEqual([]);
    // The TUI is off by default, so the logo is the proof the run went on.
    expect(printLogo).toHaveBeenCalledTimes(1);
  });

  it("exits 2 on stderr for --session with no id, before any UI or config", async () => {
    const recorded = await boot(["--session"]);

    expect(recorded.exits).toEqual([2]);
    expect(recorded.stderr).toHaveLength(1);
    expect(recorded.stderr[0]).toContain("--session needs a session id");
    // Neither the loop (and its config read) nor the logo may run.
    expect(recorded.loops).toEqual([]);
    expect(printLogo).not.toHaveBeenCalled();
    expect(recorded.stdout).toEqual([]);
  });

  it("lets a usage error win over a valid flag of the same argv", async () => {
    const recorded = await boot(["--resume", "session-a1b2c3", "--resume="]);

    expect(recorded.exits).toEqual([2]);
    expect(recorded.starts).toEqual([]);
    expect(printLogo).not.toHaveBeenCalled();
  });

  it("prints the version before the usage error", async () => {
    const recorded = await boot(["--version", "--session"]);

    expect(recorded.stdout).toEqual(["9.9.9\n"]);
    expect(recorded.exits).toEqual([]);
    expect(recorded.starts).toEqual([]);
    expect(printLogo).not.toHaveBeenCalled();
  });

  it("prints the version before the logo or the loop", async () => {
    const recorded = await boot(["--version"]);

    expect(recorded.stdout).toEqual(["9.9.9\n"]);
    expect(recorded.loops).toEqual([]);
    expect(printLogo).not.toHaveBeenCalled();
  });

  it("boots a loop with neither id when nothing is asked", async () => {
    const recorded = await boot([]);

    expect(recorded.loops).toEqual([{ tui: false }]);
    expect(recorded.starts).toEqual([{ sessionId: undefined, resumeLatest: undefined }]);
  });
});
