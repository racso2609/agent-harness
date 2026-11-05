import { readFileSync } from "node:fs";
import path from "node:path";
import { setLoggerLevel } from "@racso2609/core";
import { printLogo } from "@/terminal/stdin";
import { MainLoop } from "@/MainLoop";
import { parseFlags } from "@/flags";

// Read from the package manifest instead of a constant: a literal here would
// drift on every bump. This file compiles to `dist/main.js` and the manifest
// stays at the package root, so the hop is `../package.json` both in the repo
// and in the published tarball (where `files` carries it along).
const readVersion = (): string => {
  const manifestPath = path.join(import.meta.dirname, "..", "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: string };
  return manifest.version ?? "0.0.0";
};

const main = async () => {
  const flags = parseFlags(process.argv);

  // Early exit, ahead of the logo, the logger and any config read: asking for
  // the version must not seed ~/.racso-harness/ nor touch the provider setup.
  // Bare version only, since that is what a script parses.
  if (flags.version) {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }

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
