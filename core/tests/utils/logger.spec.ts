import { afterEach, describe, expect, it } from "vitest";
import {
  createLogger,
  DEFAULT_LOG_LEVEL,
  getLoggerLevel,
  setLoggerLevel,
  type LogLevel,
} from "../../src/utils/logger";

// Pino writes synchronously to the destination, so a plain accumulator is
// enough: no timers, no streams, no flushing.
const sink = () => {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
};

const original = getLoggerLevel();

afterEach(() => {
  setLoggerLevel(original);
});

describe("createLogger level gate", () => {
  it("defaults to error, so info and warn never reach the sink", () => {
    expect(DEFAULT_LOG_LEVEL).toBe("error");
    const out = sink();
    const log = createLogger(out.write);

    log.info({}, "un mensaje informativo");
    log.warn({}, "un aviso");
    // Discriminant: reverting the default to "info" would make both calls
    // above produce a line, breaking the assertions below.
    expect(out.lines).toEqual([]);

    log.error({}, "un error");
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain("un error");
  });

  it("emits info and warn once the level is debug via the setter", () => {
    setLoggerLevel("debug");
    const out = sink();
    const log = createLogger(out.write);

    log.info({}, "info visible");
    log.warn({}, "warn visible");
    log.debug({}, "debug visible");
    // Discriminant: with the old "info" default the debug line would be
    // missing, so the count pins the setter actually being honoured.
    expect(out.lines).toHaveLength(3);
    expect(out.lines.join("\n")).toContain("info visible");
    expect(out.lines.join("\n")).toContain("warn visible");
  });

  it("accepts a per-logger level override without touching the active one", () => {
    setLoggerLevel("error");
    const out = sink();
    const log = createLogger(out.write, { level: "debug" });

    log.info({}, "override visible");
    expect(out.lines).toHaveLength(1);
    // The override is local: a logger created afterwards is still at "error".
    expect(getLoggerLevel()).toBe("error");
  });

  it("drops everything, even fatal, when the level is silent", () => {
    setLoggerLevel("silent");
    const out = sink();
    const log = createLogger(out.write);

    log.fatal({}, "boom");
    log.error({}, "boom");
    log.warn({}, "boom");
    log.info({}, "boom");
    // Discriminant: "silent" is a pino level above every severity, so any
    // level that does not filter fatal would produce a line here.
    expect(out.lines).toEqual([]);
  });

  it("only affects loggers created after the setter runs", () => {
    // Ordering contract: the level is captured when createLogger runs, so a
    // logger already built keeps the level it was built with. This is why the
    // CLI applies --debug before MainLoop constructs the UI logger.
    setLoggerLevel("error");
    const early = sink();
    const earlyLog = createLogger(early.write);

    setLoggerLevel("debug");
    const late = sink();
    const lateLog = createLogger(late.write);

    earlyLog.info({}, "before");
    lateLog.info({}, "after");

    expect(early.lines).toEqual([]);
    expect(late.lines).toHaveLength(1);
    expect(late.lines[0]).toContain("after");
  });

  it("accepts every documented level as a setter argument", () => {
    const levels: LogLevel[] = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];
    for (const level of levels) {
      setLoggerLevel(level);
      expect(getLoggerLevel()).toBe(level);
    }
  });
});
