import { describe, expect, it } from "vitest";
import { parseFlags } from "../src/flags";

// parseFlags is the only place that turns argv into "debug on/off" (and now
// "print the version"), so these tests pin the spellings and the defaults
// without booting the CLI.
describe("parseFlags", () => {
  it("stays quiet without flags", () => {
    // Discriminant: making debug default to true would flip every assertion
    // here, which is exactly the leak this guards against.
    expect(parseFlags(["node", "main.js"])).toEqual({ tui: false, debug: false, version: false });
  });

  it("recognises --debug", () => {
    expect(parseFlags(["node", "main.js", "--debug"])).toEqual({
      tui: false,
      debug: true,
      version: false,
    });
  });

  it("recognises -v as an alias", () => {
    expect(parseFlags(["node", "main.js", "-v"])).toEqual({
      tui: false,
      debug: true,
      version: false,
    });
  });

  it("combines with --tui in any order", () => {
    expect(parseFlags(["node", "main.js", "--tui", "--debug"])).toEqual({
      tui: true,
      debug: true,
      version: false,
    });
    expect(parseFlags(["node", "main.js", "-v", "--tui"])).toEqual({
      tui: true,
      debug: true,
      version: false,
    });
    // --tui alone must not turn debug on.
    expect(parseFlags(["node", "main.js", "--tui"])).toEqual({
      tui: true,
      debug: false,
      version: false,
    });
  });

  it("recognises --version", () => {
    expect(parseFlags(["node", "main.js", "--version"])).toEqual({
      tui: false,
      debug: false,
      version: true,
    });
  });

  it("recognises -V as the version shorthand", () => {
    expect(parseFlags(["node", "main.js", "-V"])).toEqual({
      tui: false,
      debug: false,
      version: true,
    });
  });

  it("keeps --version from flipping the other flags", () => {
    // Requesting the version must not drag debug (and its log level change) on.
    expect(parseFlags(["node", "main.js", "--version"])).toMatchObject({
      tui: false,
      debug: false,
    });
  });

  it("keeps -v on debug and off version", () => {
    // `-v` is taken by `--debug`; reusing it for the version would silently
    // break every invocation that passes it expecting log output.
    const flags = parseFlags(["node", "main.js", "-v"]);
    expect(flags.debug).toBe(true);
    expect(flags.version).toBe(false);
  });
});

// Resuming is the one flag that carries a value, so its spellings are pinned
// apart from the switches above: a parser that quietly ate the next flag would
// resume a session nobody named.
describe("parseFlags resuming a session", () => {
  it("takes the id from --resume, -r, --session and -s", () => {
    for (const spelling of ["--resume", "-r", "--session", "-s"]) {
      expect(parseFlags(["node", "main.js", spelling, "abc123"]).sessionId).toBe("abc123");
    }
  });

  it("takes the id from the = form", () => {
    expect(parseFlags(["node", "main.js", "--resume=abc123"]).sessionId).toBe("abc123");
    expect(parseFlags(["node", "main.js", "--session=abc123"]).sessionId).toBe("abc123");
  });

  it("takes the id from the = form of the shorthands", () => {
    // These used to be ignored in silence, which read as "the flag did nothing".
    expect(parseFlags(["node", "main.js", "-r=abc123"]).sessionId).toBe("abc123");
    expect(parseFlags(["node", "main.js", "-s=abc123"]).sessionId).toBe("abc123");
    expect(parseFlags(["node", "main.js", "-r="]).usageError).toBeTruthy();
    expect(parseFlags(["node", "main.js", "-s="]).usageError).toBeTruthy();
  });

  it("passes the value through untouched", () => {
    // The parser only trims; the resolution (full id, unique prefix, 1-based
    // index) happens in MainLoop.start() through harness.resolveSession(),
    // which is the only gate that may validate it.
    expect(parseFlags(["node", "main.js", "--resume", "3"]).sessionId).toBe("3");
    expect(parseFlags(["node", "main.js", "-r", "2024"]).sessionId).toBe("2024");
    expect(parseFlags(["node", "main.js", "--resume", "zz-not-a-session"]).sessionId).toBe(
      "zz-not-a-session",
    );
  });

  it("trims the value the same way in both forms", () => {
    expect(parseFlags(["node", "main.js", "--resume", " abc "]).sessionId).toBe("abc");
    expect(parseFlags(["node", "main.js", "--resume= abc "]).sessionId).toBe("abc");
    expect(parseFlags(["node", "main.js", "-r", " abc "]).sessionId).toBe("abc");
    expect(parseFlags(["node", "main.js", "-r= abc "]).sessionId).toBe("abc");
  });

  it("resumes the latest session on a bare --resume or -r", () => {
    for (const spelling of ["--resume", "-r"]) {
      const flags = parseFlags(["node", "main.js", spelling]);
      expect(flags.resumeLatest).toBe(true);
      expect(flags.sessionId).toBeUndefined();
      expect(flags.usageError).toBeUndefined();
    }
  });

  it("does not steal the flag that follows a bare --resume", () => {
    // `--resume --tui` means "the latest one, with the TUI on". Reading --tui
    // as an id would resume a session that cannot exist and drop the renderer.
    const flags = parseFlags(["node", "main.js", "--resume", "--tui"]);

    expect(flags.resumeLatest).toBe(true);
    expect(flags.sessionId).toBeUndefined();
    expect(flags.tui).toBe(true);
  });

  it("does not eat a short flag as the id, whatever its length", () => {
    // `-r -v` used to read "-v" as an id, dropping the debug flag and resuming
    // a session that cannot exist.
    for (const next of ["-v", "-V", "-s", "-r", "--tui", "--debug", "--version"]) {
      const resume = parseFlags(["node", "main.js", "--resume", next]);
      expect(resume.sessionId).toBeUndefined();
      expect(resume.resumeLatest).toBe(true);

      const session = parseFlags(["node", "main.js", "--session", next]);
      expect(session.sessionId).toBeUndefined();
      expect(session.usageError).toBeTruthy();
    }
    // `-r -r` is the bare form twice: still "the latest one", never an id.
    const double = parseFlags(["node", "main.js", "-r", "-r"]);
    expect(double.sessionId).toBeUndefined();
    expect(double.resumeLatest).toBe(true);
  });

  it("fails on --session with no id instead of resuming the latest", () => {
    // The name carries a value by definition: a missing one is a mistake, not a
    // request for the most recent session (that is bare --resume).
    for (const spelling of ["--session", "-s"]) {
      const flags = parseFlags(["node", "main.js", spelling]);
      expect(flags.usageError).toBeTruthy();
      expect(flags.sessionId).toBeUndefined();
      expect(flags.resumeLatest).toBeUndefined();
    }
  });

  it("treats an empty value as a usage error, joined or separated", () => {
    expect(parseFlags(["node", "main.js", "--resume="]).usageError).toBeTruthy();
    expect(parseFlags(["node", "main.js", "--session="]).usageError).toBeTruthy();
    // An empty argument is the same mistake as `--resume=`: reading it as
    // "resume nothing" would boot a fresh session.
    for (const argv of [
      ["--resume", ""],
      ["-r", ""],
      ["--session", ""],
      ["-s", ""],
    ]) {
      expect(parseFlags(["node", "main.js", ...argv]).usageError).toBeTruthy();
    }
  });

  it("keeps the last explicit id when the flag repeats", () => {
    expect(parseFlags(["node", "main.js", "--resume", "first", "-r", "second"]).sessionId).toBe(
      "second",
    );
    // An explicit id also beats an earlier bare --resume: it is the more
    // specific request.
    const flags = parseFlags(["node", "main.js", "--resume", "--resume=abc123"]);
    expect(flags.sessionId).toBe("abc123");
    expect(flags.resumeLatest).toBeUndefined();
  });

  it("drops the id when a later bare --resume asks for the latest", () => {
    // One request, not two: carrying both left the caller choosing between them.
    const flags = parseFlags(["node", "main.js", "--resume", "abc", "--resume"]);

    expect(flags.sessionId).toBeUndefined();
    expect(flags.resumeLatest).toBe(true);
  });

  it("keeps the first usage error when the argv has several", () => {
    // Sticky and winning: the run fails with the mistake that came first
    // instead of hiding it behind a later one.
    expect(parseFlags(["node", "main.js", "--resume=", "--session"]).usageError).toBe(
      "--resume=<id> needs a session id after the `=`.",
    );
    expect(parseFlags(["node", "main.js", "--session", "--resume="]).usageError).toBe(
      "--session needs a session id (use bare --resume for the most recent one).",
    );
  });

  it("keeps a usage error even when another flag of the argv is valid", () => {
    // Both orders: a valid id does not clear a mistake, and a mistake does not
    // get cleared by a valid id that follows it.
    const mistakeFirst = parseFlags(["node", "main.js", "--resume=", "--resume", "abc"]);
    expect(mistakeFirst.usageError).toBeTruthy();
    const mistakeLast = parseFlags(["node", "main.js", "--session", "abc", "--resume="]);
    expect(mistakeLast.usageError).toBeTruthy();
    // The valid part still parses, so nothing is silent about what it read.
    expect(mistakeLast.sessionId).toBe("abc");
  });

  it("leaves the other flags alone", () => {
    expect(parseFlags(["node", "main.js", "--resume", "abc123", "--tui", "-v"])).toMatchObject({
      tui: true,
      debug: true,
      version: false,
    });
  });

  it("keeps the flag object unchanged when nothing is asked of it", () => {
    // toEqual ignores undefined keys, so it would pass even if the
    // implementation set `sessionId: undefined` explicitly: the key list is
    // what can actually fail.
    expect(Object.keys(parseFlags(["node", "main.js", "--tui"])).sort()).toEqual([
      "debug",
      "tui",
      "version",
    ]);
    expect(Object.keys(parseFlags(["node", "main.js"])).sort()).toEqual([
      "debug",
      "tui",
      "version",
    ]);
  });
});
