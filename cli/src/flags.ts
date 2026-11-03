// Result of parsing the CLI argv. Kept as plain data so main.ts stays the only
// place that knows how a flag turns into an effect.
export interface CliFlags {
  // Renders the full-screen ink TUI instead of plain lines.
  tui: boolean;
  // Turns on verbose core logging (info/debug/warn) for this run.
  debug: boolean;
}

// Parses the few flags the CLI understands. There is no general parser yet, so
// this stays a pure function: it never reads process.env or process.argv, which
// makes the flag behaviour testable without spawning a process.
export const parseFlags = (argv: readonly string[]): CliFlags => ({
  tui: argv.includes("--tui"),
  // `-v` is an alias, the usual shorthand for verbose/debug.
  debug: argv.includes("--debug") || argv.includes("-v"),
});
