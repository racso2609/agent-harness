import { setLoggerLevel } from "@racso/core";
import { printLogo } from "@/terminal/stdin";
import { MainLoop } from "@/MainLoop";
import { parseFlags } from "@/flags";

const main = async () => {
  const flags = parseFlags(process.argv);
  // The level must be set before any logger is built: `env` (and therefore the
  // default level) is captured at import time, so `process.env.LOG_LEVEL` can
  // no longer be changed usefully here. MainLoop builds the UI logger in its
  // constructor, so this has to happen first.
  if (flags.debug) setLoggerLevel("debug");

  // The line renderer stays the default; the ink TUI is opt-in while it is a
  // prototype, so an installed binary keeps behaving exactly as before.
  if (!flags.tui) printLogo();

  const loop = new MainLoop({ tui: flags.tui });
  await loop.start();
};

main().catch((err) => {
  process.stderr.write(`fatal error: ${String(err)}\n`);
  process.exit(1);
});
