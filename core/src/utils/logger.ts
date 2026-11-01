import pino from "pino";
import { prettyFactory } from "pino-pretty";
import type { ILogger, LoggerSink } from "@/contract";
import { env } from "./env";

const stderrSink: LoggerSink = (line) => {
  process.stderr.write(`${line}\n`);
};

// Builds a logger that formats one line at a time and hands it to the sink.
// The sink owns rendering concerns (prompt clearing, colors, transport);
// the core logger never touches stdin or the terminal.
export const createLogger = (sink: LoggerSink = stderrSink): ILogger => {
  const format = prettyFactory({
    colorize: true,
    translateTime: "HH:MM:ss",
    ignore: "pid,hostname",
  });

  return pino(
    { level: env.LOG_LEVEL ?? "info" },
    {
      write(chunk: string) {
        const text = chunk.trimEnd();
        if (text) sink(format(text));
      },
    },
  ) as unknown as ILogger;
};

// Active logger used by modules that import `logger` directly (providers,
// tools, agents). `createHarness` installs the injected one here.
let active: ILogger = createLogger();

export const setLogger = (next: ILogger) => {
  active = next;
};

export const logger: ILogger = {
  fatal: (obj, msg) => active.fatal(obj, msg),
  error: (obj, msg) => active.error(obj, msg),
  warn: (obj, msg) => active.warn(obj, msg),
  info: (obj, msg) => active.info(obj, msg),
  debug: (obj, msg) => active.debug(obj, msg),
  trace: (obj, msg) => active.trace(obj, msg),
};
