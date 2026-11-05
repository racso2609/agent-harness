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
