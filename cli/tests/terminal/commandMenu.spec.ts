import { describe, expect, it } from "vitest";
import type { CommandOption } from "../../src/commands/CommandRepository";
import {
  clampSelection,
  filterCommands,
  moveSelection,
  visibleCommands,
} from "../../src/terminal/commandMenu";

const commands: CommandOption[] = [
  { name: "help", aliases: ["?"], description: "List commands" },
  { name: "model", description: "Switch model" },
  { name: "provider", description: "Switch provider" },
  { name: "compact", description: "Compact history" },
];

describe("commandMenu", () => {
  describe("filterCommands", () => {
    it("returns every command for an empty query", () => {
      expect(filterCommands(commands, "")).toBe(commands);
    });

    it("filters by name prefix", () => {
      expect(filterCommands(commands, "mo").map((c) => c.name)).toEqual(["model"]);
    });

    it("filters by alias prefix", () => {
      expect(filterCommands(commands, "?").map((c) => c.name)).toEqual(["help"]);
    });

    it("is case-insensitive", () => {
      expect(filterCommands(commands, "PRO").map((c) => c.name)).toEqual(["provider"]);
    });

    it("returns no matches when the prefix does not exist", () => {
      expect(filterCommands(commands, "zzz")).toEqual([]);
    });
  });

  describe("clampSelection", () => {
    it("keeps valid indexes", () => {
      expect(clampSelection(2, 4)).toBe(2);
    });

    it("clamps negative and overflowing indexes", () => {
      expect(clampSelection(-1, 4)).toBe(0);
      expect(clampSelection(9, 4)).toBe(3);
    });

    it("returns zero for an empty list", () => {
      expect(clampSelection(3, 0)).toBe(0);
    });
  });

  describe("moveSelection", () => {
    it("moves down and up", () => {
      expect(moveSelection(1, 1, 3)).toBe(2);
      expect(moveSelection(1, -1, 3)).toBe(0);
    });

    it("wraps around the ends", () => {
      expect(moveSelection(2, 1, 3)).toBe(0);
      expect(moveSelection(0, -1, 3)).toBe(2);
    });

    it("returns zero for an empty list", () => {
      expect(moveSelection(0, 1, 0)).toBe(0);
    });
  });

  describe("visibleCommands", () => {
    it("returns all commands when they fit", () => {
      expect(visibleCommands(commands, 0, 8)).toBe(commands);
    });

    it("keeps the selected command inside a sliding window", () => {
      const visible = visibleCommands(commands, 3, 2);

      expect(visible.map((c) => c.name)).toEqual(["provider", "compact"]);
    });

    it("keeps the window at the start when selection is near the top", () => {
      const visible = visibleCommands(commands, 0, 2);

      expect(visible.map((c) => c.name)).toEqual(["help", "model"]);
    });
  });
});
