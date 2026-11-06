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

// Everything the boot sequence touches outside itself. Injected so the order of
// the effects (version, usage error, logo, loop) is assertable without a
// process, a terminal or a config.
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
  createLoop?: (options: MainLoopOptions) => Pick<MainLoop, "start">;
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

  // The level must be set before any logger is built: `env` (and therefore the
  // default level) is captured at import time, so `process.env.LOG_LEVEL` can no
  // longer be changed usefully here. MainLoop builds the UI logger in its
  // constructor, so this has to happen before.
  if (flags.debug) setLoggerLevel("debug");

  // The line renderer stays the default; the ink TUI is opt-in while it is a
  // prototype, so an installed binary keeps behaving exactly as before.
  if (!flags.tui) (deps.logo ?? printLogo)();

  try {
    await launch.start({ sessionId: flags.sessionId, resumeLatest: flags.resumeLatest });
  } catch (error) {
    // Refused before initialize(): no session was loaded, so there is nothing to
    // shut down and no UI to close. The loop only reports; this is the one place
    // that decides the process leaves with the usage code.
    if (error instanceof UsageError) return fail(error.message);
    throw error;
  }
};

// Builds the loop without starting it, so nothing is constructed for a run that
// will already fail on its flags.
const bootLoop = async (
  flags: CliFlags,
  deps: RunDeps,
): Promise<Pick<MainLoop, "start"> | undefined> => {
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
  run({
    argv: process.argv,
    stdout: process.stdout,
    stderr: process.stderr,
    exit: (code) => process.exit(code),
  }).catch((error) => {
    process.stderr.write(`fatal error: ${String(error)}\n`);
    process.exit(1);
  });
}

export { run };
export type { RunDeps };
