import { printLogo } from "@/utils/stdin";
import { logger } from "@/utils/logger";
import { MainLoop } from "@/session/MainLoop";

const main = async () => {
  printLogo();

  const loop = new MainLoop();
  await loop.start();
};

main().catch((err) => {
  logger.error({ err }, "fatal error");
  process.exit(1);
});
