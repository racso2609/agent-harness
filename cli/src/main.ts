import { printLogo } from "@/terminal/stdin";
import { MainLoop } from "@/MainLoop";

const main = async () => {
  printLogo();

  const loop = new MainLoop();
  await loop.start();
};

main().catch((err) => {
  process.stderr.write(`fatal error: ${String(err)}\n`);
  process.exit(1);
});
