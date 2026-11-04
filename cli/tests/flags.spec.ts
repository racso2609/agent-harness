import { describe, expect, it } from "vitest";
import { parseFlags } from "../src/flags";

// parseFlags is the only place that turns argv into "debug on/off", so these
// tests pin the two spellings and the default without booting the CLI.
describe("parseFlags", () => {
  it("stays quiet without flags", () => {
    // Discriminant: making debug default to true would flip every assertion
    // here, which is exactly the leak this guards against.
    expect(parseFlags(["node", "main.js"])).toEqual({ tui: false, debug: false });
  });

  it("recognises --debug", () => {
    expect(parseFlags(["node", "main.js", "--debug"])).toEqual({ tui: false, debug: true });
  });

  it("recognises -v as an alias", () => {
    expect(parseFlags(["node", "main.js", "-v"])).toEqual({ tui: false, debug: true });
  });

  it("combines with --tui in any order", () => {
    expect(parseFlags(["node", "main.js", "--tui", "--debug"])).toEqual({ tui: true, debug: true });
    expect(parseFlags(["node", "main.js", "-v", "--tui"])).toEqual({ tui: true, debug: true });
    // --tui alone must not turn debug on.
    expect(parseFlags(["node", "main.js", "--tui"])).toEqual({ tui: true, debug: false });
  });
});
