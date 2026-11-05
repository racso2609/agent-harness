import { describe, expect, it } from "vitest";
import type { CommandOption } from "../../src/commands/CommandRepository";
import { menuCommandLine, menuCompletion, menuQueryFor, menuView } from "../../src/ui/tui/menu";

// Which drafts open the dropdown and what the keys do with it. The keys are
// read off the pure helpers the app calls, so a list that stops opening, or a
// Tab that completes the wrong thing, fails here instead of on a real TTY.

const commands: CommandOption[] = [
  { name: "help", aliases: ["?"], description: "List available commands" },
  { name: "model", description: "Switch the active model" },
  { name: "provider", aliases: ["providers"], description: "Switch provider" },
  { name: "resume", description: "Resume a session" },
  { name: "compact", description: "Compact the history" },
];

describe("the slash dropdown", () => {
  describe("when it opens", () => {
    it("opens on a bare slash", () => {
      expect(menuQueryFor("/")).toBe("");
    });

    it("opens on a partial command", () => {
      expect(menuQueryFor("/mo")).toBe("mo");
    });

    it("stays shut while nothing has been typed", () => {
      expect(menuQueryFor("")).toBeNull();
    });

    it("stays shut on a plain prompt", () => {
      expect(menuQueryFor("run the tests")).toBeNull();
    });

    it("stays shut once arguments are being typed", () => {
      // The first token is the command; a space means the user is done choosing
      // and a list that kept filtering would cover the transcript for nothing.
      expect(menuQueryFor("/provider add")).toBeNull();
      expect(menuQueryFor("/resume ")).toBeNull();
    });
  });

  describe("when it filters", () => {
    it("lists every command on the empty query", () => {
      expect(menuView(commands, "", 0).state.items).toBe(commands);
    });

    it("narrows to the names the query matches", () => {
      expect(menuView(commands, "mo", 0).state.items.map((c) => c.name)).toEqual(["model"]);
    });

    it("matches aliases too", () => {
      expect(menuView(commands, "?", 0).state.items.map((c) => c.name)).toEqual(["help"]);
    });

    it("reports no match without inventing one", () => {
      const view = menuView(commands, "zzz", 0);

      expect(view.state.items).toEqual([]);
      expect(view.rows.rows).toEqual([]);
    });

    it("keeps the selection inside the filtered list", () => {
      // The index survives a keystroke that shrank the list, so it has to be
      // clamped before the window is computed.
      expect(menuView(commands, "mo", 4).state.selected).toBe(0);
    });
  });

  describe("what the keys do", () => {
    it("completes to the command name plus a space", () => {
      expect(menuCompletion(commands[0]!)).toBe("/help ");
    });

    it("runs only the command, dropping whatever was typed after it", () => {
      expect(menuCommandLine(commands[2]!)).toBe("/provider");
    });
  });
});
