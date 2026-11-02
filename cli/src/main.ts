import { printLogo } from "@/terminal/stdin";
import { MainLoop } from "@/MainLoop";

const main = async () => {
  // The line renderer stays the default; the ink TUI is opt-in while it is a
  // prototype, so an installed binary keeps behaving exactly as before.
  const tui = process.argv.includes("--tui");

  if (!tui) printLogo();

  const loop = new MainLoop({ tui });
  await loop.start();
};

main().catch((err) => {
  process.stderr.write(`fatal error: ${String(err)}\n`);
  process.exit(1);
});
