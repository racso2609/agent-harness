import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setLoggerLevel } from "@racso2609/core";
import { printLogo } from "@/terminal/stdin";
import { MainLoop, UsageError, type MainLoopOptions } from "@/MainLoop";
import { parseFlags, type CliFlags } from "@/flags";

// Read from the package manifest instead of a constant: a literal here would
// drift on every bump. This file compiles to `dist/main.js` and the manifest
// stays at the package root, so the hop is `../package.json` both in the repo
// and in the published tarball (where `files` carries it along). Called from
// the `--version` branch only: reading it at import time threw before the
// `.catch` below could report the missing manifest.
const readVersion = (): string => {
  const manifestPath = path.join(import.meta.dirname, "..", "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: string };
  return manifest.version ?? "0.0.0";
};

// What the boot needs from the loop. Narrower than MainLoop so a test can hand
// in a stand-in, but wide enough for the order of the effects: the session is
// resolved before anything is painted, start() boots it, and close() releases
// the terminal when an error escapes.
type LoopHandle = Pick<MainLoop, "start" | "resolveResume" | "close">;

// Everything the boot sequence touches outside itself. Injected so the order of
// the effects (version, usage error, resolution, logo, loop) is assertable
// without a process, a terminal or a config.
interface RunDeps {
  argv: readonly string[];
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
  exit: (code: number) => void;
  logo?: () => void;
  version?: () => string;
  // The loop is built here so the real MainLoop can be observed (its start()
  // options are what carry the session to resume). The default builds the real
  // one; a test may pass a factory, but what reaches start() is always checked
  // through this hook.
  createLoop?: (options: MainLoopOptions) => LoopHandle;
}

// Both a badly written flag and a session that does not resolve end here: one
// code for "the command line asked for something that cannot be done".
const USAGE_EXIT_CODE = 2;

const run = async (deps: RunDeps): Promise<void> => {
  const out = deps.stdout;
  const err = deps.stderr;
  const fail = (message: string) => {
    err.write(`${message}\n`);
    deps.exit(USAGE_EXIT_CODE);
  };

  const flags = parseFlags(deps.argv);

  // Early exit, ahead of the usage error, the logo, the logger and any config
  // read: `--version` is a pure query, and asking for it must not seed
  // ~/.racso-harness/ nor touch the provider setup. It is also the one thing
  // that wins over a usage error, so a script may ask the version of a binary it
  // was handed with flags it does not understand. Bare version only, since that
  // is what a script parses.
  if (flags.version) {
    out.write(`${(deps.version ?? readVersion)()}\n`);
    return;
  }

  // A flag mistake stops the run before the loop exists: no config read, no UI,
  // nothing that could look like the flag was ignored.
  if (flags.usageError) return fail(flags.usageError);

  const launch = await bootLoop(flags, deps);
  if (!launch) return;

  // The session is resolved before the logo and before start(): the logo is
  // printed more than once and the setup flow start() runs writes to the
  // terminal and may ask questions, so a boot that cannot be resumed has to give
  // up before the first write. It is the loop's own gate, so the rule lives in
  // one place. start() resolves again on purpose (a caller may hand it a raw
  // flag value); a full id resolves to itself, so the second pass is a no-op.
  let sessionId: string | undefined;
  try {
    sessionId = launch.resolveResume({
      sessionId: flags.sessionId,
      resumeLatest: flags.resumeLatest,
    });
  } catch (error) {
    if (error instanceof UsageError) return fail(error.message);
    launch.close();
    throw error;
  }

  // The level must be set before any logger is built: `env` (and therefore the
  // default level) is captured at import time, so `process.env.LOG_LEVEL` can no
  // longer be changed usefully here. MainLoop builds the UI logger in its
  // constructor, so this has to happen before.
  if (flags.debug) setLoggerLevel("debug");

  // The line renderer stays the default; the ink TUI is opt-in while it is a
  // prototype, so an installed binary keeps behaving exactly as before.
  if (!flags.tui) (deps.logo ?? printLogo)();

  try {
    await launch.start({ sessionId });
  } catch (error) {
    // A session that does not resolve is a symptom of the command line, not of
    // the run: it is reported like a bad flag, and only here does the process
    // learn it leaves with the usage code. start() throws it before booting the
    // session or building a renderer, so there is nothing to shut down, no ink
    // to unmount, and the message goes through `stderr` like every other usage
    // error.
    if (error instanceof UsageError) return fail(error.message);
    launch.close();
    throw error;
  }
};

// Builds the loop without starting it, so nothing is constructed for a run that
// will already fail on its flags.
const bootLoop = async (flags: CliFlags, deps: RunDeps): Promise<LoopHandle | undefined> => {
  const createLoop = deps.createLoop ?? ((options: MainLoopOptions) => new MainLoop(options));

  return createLoop({ tui: flags.tui });
};

// True when this file is the process entrypoint (`node dist/main.js`, and the
// `tsx` dev script), so importing it has no side effect. Compared after
// resolving symlinks and making the CWD absolute: `/tmp` is a symlink to
// `/private/tmp` on macOS, and a bare `process.argv[1] === import.meta.filename`
// never matched there.
const isEntrypoint = (): boolean => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(import.meta.filename);
  } catch {
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  }
};

if (isEntrypoint()) {
  // The loop is kept so a failure this file does not report still reaches it:
  // an escaping error used to leave ink mounted over the process, with the tty
  // never restored. close() is idempotent and a no-op when no renderer was
  // built.
  let launch: LoopHandle | undefined;
  const createLoop = (options: MainLoopOptions): LoopHandle => {
    launch = new MainLoop(options);

    return launch;
  };

  run({
    argv: process.argv,
    stdout: process.stdout,
    stderr: process.stderr,
    exit: (code) => process.exit(code),
    createLoop,
  }).catch((error) => {
    process.stderr.write(`fatal error: ${String(error)}\n`);
    launch?.close();
    process.exit(1);
  });
}

export { run };
export type { RunDeps };
