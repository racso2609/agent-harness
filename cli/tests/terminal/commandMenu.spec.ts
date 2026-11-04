import { describe, expect, it } from "vitest";
import type { CommandOption } from "../../src/commands/CommandRepository";
import {
COMMAND_KEYS,
clampSelection,
filterCommands,
menuItems,
menuMove,
menuRows,
menuSelectAt,
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

describe("menuItems", () => {
it("returns the list itself for an empty query, not a copy", () => {
// A renderer may compare by identity to tell "nothing typed" from
// "filtered", and a cleared query must not allocate on every keystroke.
expect(menuItems("", commands, COMMAND_KEYS)).toBe(commands);
});

it("filters commands by name or alias prefix", () => {
expect(menuItems("mo", commands, COMMAND_KEYS).map((c) => c.name)).toEqual(["model"]);
expect(menuItems("?", commands, COMMAND_KEYS).map((c) => c.name)).toEqual(["help"]);
});

it("is case-insensitive and ignores surrounding spaces", () => {
expect(menuItems("  PRO ", commands, COMMAND_KEYS).map((c) => c.name)).toEqual(["provider"]);
});

it("filters any item type through its keys", () => {
const sessions = [{ id: "a", title: "alpha" }, { id: "b", title: "beta" }];

expect(menuItems("be", sessions, (s) => [s.id, s.title])).toEqual([sessions[1]]);
});
});

describe("menuMove", () => {
const state = { items: commands, query: "", selected: 1 };

it("moves the selection one step in either direction", () => {
expect(menuMove(state, 1).selected).toBe(2);
expect(menuMove(state, -1).selected).toBe(0);
});

it("wraps around both ends", () => {
expect(menuMove({ ...state, selected: 3 }, 1).selected).toBe(0);
expect(menuMove({ ...state, selected: 0 }, -1).selected).toBe(3);
});

it("stays at zero on an empty list", () => {
expect(menuMove({ items: [], query: "zzz", selected: 0 }, 1).selected).toBe(0);
});

it("leaves the items and the query alone", () => {
const moved = menuMove(state, 1);

expect(moved.items).toBe(commands);
expect(moved.query).toBe("");
});
});

describe("menuSelectAt", () => {
it("keeps an index that is inside the list", () => {
expect(menuSelectAt({ items: commands, query: "", selected: 0 }, 2).selected).toBe(2);
});

it("clamps an index past either end", () => {
expect(menuSelectAt({ items: commands, query: "", selected: 0 }, 9).selected).toBe(3);
expect(menuSelectAt({ items: commands, query: "", selected: 0 }, -2).selected).toBe(0);
});

it("falls back to zero when the filter emptied the list", () => {
expect(menuSelectAt({ items: [], query: "zzz", selected: 2 }, 2).selected).toBe(0);
});
});

describe("menuRows", () => {
it("shows every row when the list fits", () => {
const rows = menuRows({ items: commands, query: "", selected: 0 }, 8);

expect(rows.rows).toBe(commands);
expect(rows.start).toBe(0);
expect(rows.hiddenAbove).toBe(0);
expect(rows.hiddenBelow).toBe(0);
});

it("keeps the selection inside a window and reports what stays hidden", () => {
const rows = menuRows({ items: commands, query: "", selected: 3 }, 2);

expect(rows.rows.map((c) => c.name)).toEqual(["provider", "compact"]);
expect(rows.start).toBe(2);
expect(rows.hiddenAbove).toBe(2);
expect(rows.hiddenBelow).toBe(0);
});

it("centres the window as far as the ends allow", () => {
// Two rows and a selection on the second one: half a window fits above it, so
// the slice starts at the top instead of centring perfectly.
const rows = menuRows({ items: commands, query: "", selected: 2 }, 2);

expect(rows.rows.map((c) => c.name)).toEqual(["model", "provider"]);
expect(rows.hiddenAbove).toBe(1);
expect(rows.hiddenBelow).toBe(1);
});

it("reports an empty list without pretending something is hidden", () => {
expect(menuRows({ items: [], query: "zzz", selected: 0 }, 4)).toEqual({
start: 0,
rows: [],
hiddenAbove: 0,
hiddenBelow: 0,
});
});

it("never paints more rows than asked, even when the list is huge", () => {
const many = Array.from({ length: 20 }, (_, index) => ({
name: `c${index}`,
description: "",
}));

expect(menuRows({ items: many, query: "", selected: 10 }, 4).rows).toHaveLength(4);
});

it("survives a maxVisible of zero instead of returning nothing", () => {
expect(menuRows({ items: commands, query: "", selected: 0 }, 0).rows).toHaveLength(1);
});
});
});
