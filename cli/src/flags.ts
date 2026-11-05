// Result of parsing the CLI argv. Kept as plain data so main.ts stays the only
// place that knows how a flag turns into an effect.
export interface CliFlags {
  // Renders the full-screen ink TUI instead of plain lines.
  tui: boolean;
  // Turns on verbose core logging (info/debug/warn) for this run.
  debug: boolean;
  // Asks for the package version and an immediate exit, nothing else.
  version: boolean;
}

// Parses the few flags the CLI understands. There is no general parser yet, so
// this stays a pure function: it never reads process.env or process.argv, which
// makes the flag behaviour testable without spawning a process.
export const parseFlags = (argv: readonly string[]): CliFlags => ({
  tui: argv.includes("--tui"),
  // `-v` is an alias, the usual shorthand for verbose/debug. It is therefore
  // taken already: the version shorthand has to be the capital `-V`, since
  // `-v` meaning two different things would be a silent trap.
  debug: argv.includes("--debug") || argv.includes("-v"),
  version: argv.includes("--version") || argv.includes("-V"),
});
