import pino from "pino";
import { prettyFactory } from "pino-pretty";
import type { ILogger, LoggerSink } from "@/contract";
import { env } from "./env";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

const stderrSink: LoggerSink = (line) => {
  process.stderr.write(`${line}\n`);
};

// The default level is "error" on purpose: warn/info from the core are
// diagnostics, not conversation, and they used to leak into the transcript.
// They are emitted only when the user asks for them explicitly (LOG_LEVEL, or
// the CLI --debug flag). The filter lives in pino, so a suppressed entry never
// reaches the sink and is never formatted.
export const DEFAULT_LOG_LEVEL: LogLevel = "error";

// Level used by loggers created from now on. It is mutable because the CLI
// parses its flags after the modules are already loaded: ESM evaluates env.ts
// at import time, so writing process.env.LOG_LEVEL there would be too late.
// Ordering contract: `setLoggerLevel` only affects loggers created AFTER the
// call, which is why the CLI applies the flag during startup, before anything
// builds a logger.
let currentLevel: LogLevel = env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL;

export const setLoggerLevel = (level: LogLevel) => {
  currentLevel = level;
};

export const getLoggerLevel = (): LogLevel => currentLevel;

export interface LoggerOptions {
  // Per-logger override of the active level. Optional, so existing
  // `createLogger(sink)` call sites keep compiling and behaving.
  level?: LogLevel;
}

// Builds a logger that formats one line at a time and hands it to the sink.
// The sink owns rendering concerns (prompt clearing, colors, transport);
// the core logger never touches stdin or the terminal.
export const createLogger = (
  sink: LoggerSink = stderrSink,
  options: LoggerOptions = {},
): ILogger => {
  const format = prettyFactory({
    colorize: true,
    translateTime: "HH:MM:ss",
    ignore: "pid,hostname",
  });

  const level = options.level ?? currentLevel;

  return pino(
    { level },
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
