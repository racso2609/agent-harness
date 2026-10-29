import pino from "pino";
import { prettyFactory } from "pino-pretty";
import { env } from "./env";
import { clearPrompt, restorePrompt } from "./stdin";

// Synchronous pretty line formatter. We format inline and write to stderr
// ourselves so ordering with the prompt redraw stays deterministic.
const format = prettyFactory({
  colorize: true,
  translateTime: "HH:MM:ss",
  ignore: "pid,hostname",
});

export const logger = pino(
  { level: env.LOG_LEVEL ?? "info" },
  {
    write(chunk: string) {
      clearPrompt();
      process.stderr.write(format(chunk.trimEnd()) + "\n");
      restorePrompt();
    },
  },
);
