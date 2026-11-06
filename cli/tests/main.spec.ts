import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessOptions, IHarness } from "@racso2609/core";
import type { MainLoopOptions } from "../src/MainLoop";

// The boot sequence of main.ts is what turns flags into a session, and nothing
// else in the suite imports it: a regression there (dropping the session id on
// the way to `loop.start`) left every other test green. These cases run the
// real `run()` with the loop, the terminal output and the process stubbed out.
const printLogo = vi.fn();
// `input` never answers: the seam case lets the real loop boot on line mode and
// parks there, which is the state it asserts from (and a pending promise the
// test carries away with it).
vi.mock("../src/terminal/stdin", () => ({ printLogo, input: () => new Promise(() => {}) }));

// The seam case below boots the real MainLoop, so it needs the two stubs the
// loop wiring cases use: ink patches the console the moment it mounts, and the
// setup flow reads stdin. The config that case builds has no providers, so
// `needsSetup()` is true by construction.
vi.mock("../src/flows/startSetup", () => ({ startSetup: async () => {} }));

vi.mock("ink", () => ({
  render: () => ({ rerender: () => {}, unmount: () => {} }),
  Box: () => null,
  Text: () => null,
  useInput: () => {},
  useStdout: () => ({ stdout: { columns: 80, rows: 24 } }),
}));

const { run } = await import("../src/main");
const { MainLoop } = await import("../src/MainLoop");
const { Config, SUPPORTED_PROVIDERS } = await import("@racso2609/core");

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

  it("carries a prefix typed on the command line to the full id core loads", async () => {
    // The cases above replace MainLoop with createLoop, so "the flag reaches
    // start()" and "start() resolves the id" are proven apart and never touch.
    // This one runs the real loop end to end: run() reads the argv, hands the
    // prefix to the real start(), and what comes out is what initialize() gets.
    const store = ["session-abc123", "session-def456"];
    const initialized: (HarnessOptions | undefined)[] = [];
    const harness = {
      initialize: async (options) => {
        initialized.push(options);
      },
      // The real gate, narrowed: a unique prefix resolves, anything else does not.
      resolveSession: (target: string) => {
        const matches = store.filter((id) => id.startsWith(target));

        return matches.length === 1 ? matches[0] : undefined;
      },
      status: () => ({ sessionId: "session-abc123" }),
      listSessions: () => store.map((id) => ({ id })),
      listProviders: () => [...SUPPORTED_PROVIDERS],
      save: () => {},
      // Asked on boot, before the loop parks: a resumed session repaints its
      // conversation and subscribes to the children of the session.
      conversation: () => [],
      childHistory: () => [],
      onSpawnEvent: () => () => {},
      shutdown: () => {},
    } as unknown as IHarness;

    // No providers, so the setup flow stays out of the run.
    const config = new Config();
    config.config.providers = {};
    config.config.defaultProvider = undefined;

    const exits: number[] = [];
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exits.push(code ?? 0);
    }) as never);

    // Line mode is what this needs: the TUI would wait for ink, and the pending
    // prompt below is dropped with the process instead of read.
    const loop = new MainLoop({ config });
    loop.harness = harness;
    loop.ui = {
      render: () => {},
      renderImage: async () => {},
      close: () => {},
      select: async () => undefined,
      promptText: async () => undefined,
      confirm: async () => undefined,
      promptApproval: async () => "deny",
    } as unknown as typeof loop.ui;

    // run() awaits start(), which only returns once the loop is over, so the
    // assertion is made while the process is parked on its first prompt. The
    // promise is left pending on purpose: it goes with the test.
    void run({
      argv: ["node", "main.js", "--resume", "session-abc"],
      stdout: { write: () => true },
      stderr: { write: () => true },
      exit: (code) => exits.push(code),
      logo: printLogo,
      createLoop: () => loop,
    });
    for (let attempt = 0; attempt < 500 && !initialized.length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(initialized).toEqual([{ sessionId: "session-abc123", agent: undefined }]);
    expect(exits).toEqual([]);
  });

  it("boots a loop with neither id when nothing is asked", async () => {
    const recorded = await boot([]);

    expect(recorded.loops).toEqual([{ tui: false }]);
    expect(recorded.starts).toEqual([{ sessionId: undefined, resumeLatest: undefined }]);
  });
});
