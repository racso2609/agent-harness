// Result of parsing the CLI argv. Kept as plain data so main.ts stays the only
// place that knows how a flag turns into an effect.
export interface CliFlags {
  // Renders the full-screen ink TUI instead of plain lines.
  tui: boolean;
  // Turns on verbose core logging (info/debug/warn) for this run.
  debug: boolean;
  // Asks for the package version and an immediate exit, nothing else.
  version: boolean;
  // Session to resume, exactly as typed: a full id, a unique prefix or a
  // 1-based list index. Resolving it is MainLoop.start()'s job, through
  // harness.resolveSession(), which is the only gate that can validate it.
  sessionId?: string;
  // Bare `--resume`/`-r`: resume the most recent session, whatever its id is.
  resumeLatest?: boolean;
  // First mistake found in the argv, ready to be shown as-is. Sticky: once set,
  // it survives every other flag of the same argv, because hiding it behind a
  // later, valid one would run something the user did not ask for. The only
  // exception is `--version`/`-V`: a pure query, so main.ts honours it even when
  // a usage error is also present.
  usageError?: string;
}

// Flags carrying a session id, in the order the errors name them. `--resume`
// and `-r` fall back to the most recent session when bare; `--session` and `-s`
// name one by definition.
const VALUE_FLAGS = ["--resume", "-r", "--session", "-s"] as const;
const LATEST_FLAGS = new Set(["--resume", "-r"]);

const emptyValueError = (spelling: string) =>
  `${spelling}=<id> needs a session id after the \`=\`.`;

const missingValueError = (spelling: string) =>
  `${spelling} needs a session id (use bare --resume for the most recent one).`;

// Session ids are `session-<uuid>`, prefixes of them or 1-based indexes, so a
// leading dash is never an id. Without this, `-r -v` read "-v" as an id,
// dropping the debug flag and resuming a session that cannot exist.
const looksLikeFlag = (token: string) => token.startsWith("-");

// Parses the few flags the CLI understands. There is no general parser yet, so
// this stays a pure function: it never reads process.env or process.argv, which
// makes the flag behaviour testable without spawning a process.
export const parseFlags = (argv: readonly string[]): CliFlags => {
  const flags: CliFlags = {
    tui: false,
    // `-v` is an alias, the usual shorthand for verbose/debug. It is therefore
    // taken already: the version shorthand has to be the capital `-V`, since
    // `-v` meaning two different things would be a silent trap.
    debug: false,
    version: false,
  };

  // Sticky, and the first mistake of the argv wins: the run fails with the error
  // that came first instead of hiding it behind a later one.
  const fail = (message: string) => {
    flags.usageError ??= message;
  };

  // One request, not two: "the latest one" and an explicit id on the same argv
  // would leave the caller choosing, so the later one replaces the other.
  const setLatest = () => {
    delete flags.sessionId;
    flags.resumeLatest = true;
  };
  const setId = (id: string) => {
    delete flags.resumeLatest;
    flags.sessionId = id;
  };

  const args = argv.slice(2);
  // True once an id flag was seen, so a bare positional never overwrites it.
  let idGiven = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === "--tui") {
      flags.tui = true;
      continue;
    }
    if (arg === "--debug" || arg === "-v") {
      flags.debug = true;
      continue;
    }
    if (arg === "--version" || arg === "-V") {
      flags.version = true;
      continue;
    }

    if ((VALUE_FLAGS as readonly string[]).includes(arg)) {
      const next = args[index + 1];
      // A flag follows, or nothing does: no id was given either way.
      if (next === undefined || looksLikeFlag(next)) {
        if (LATEST_FLAGS.has(arg)) setLatest();
        else fail(missingValueError(arg));
      } else {
        index += 1;
        const id = next.trim();
        // An empty argument is the same mistake as `--resume=`: reading it as
        // "resume nothing" would boot a fresh session.
        if (id) setId(id);
        else fail(emptyValueError(arg));
      }
      idGiven = true;
      continue;
    }

    // The `=` form, shorthands included: `-r=abc` used to be ignored in silence,
    // which read as "the flag did nothing".
    const joined = VALUE_FLAGS.find((spelling) => arg.startsWith(`${spelling}=`));
    if (joined) {
      const id = arg.slice(joined.length + 1).trim();
      if (id) setId(id);
      else fail(emptyValueError(joined));
      idGiven = true;
      continue;
    }

    // A bare positional is the session to open: `main.js 3` means the third one of
    // the list. An explicit flag always wins over it.
    if (!looksLikeFlag(arg)) {
      const id = arg.trim();
      if (id && !idGiven && flags.sessionId === undefined && !flags.resumeLatest) setId(id);
    }
    // Anything else (an unknown flag) is none of this parser's business: it was
    // ignored before and keeps being ignored.
  }

  return flags;
};
