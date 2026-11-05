import { describe, expect, it } from "vitest";
import type { CommandOption } from "@/commands/CommandRepository";
import { menuRows } from "@/terminal/commandMenu";
import {
  interpretMenuInput,
  menuRangeLabel,
  promptMenuSelection,
  promptMenuState,
  type PromptMenuState,
  type PromptMenuAction,
} from "@/terminal/promptMenu";

// A short list with one alias, so both ways of matching a command show up.
const commands: CommandOption[] = [
  { name: "model", description: "pick a model", aliases: ["m"] },
  { name: "mode", description: "pick a mode" },
  { name: "help", description: "list the commands" },
  { name: "clear", description: "wipe the transcript" },
] as CommandOption[];

const fresh = (overrides: Partial<PromptMenuState> = {}): PromptMenuState => ({
  pending: "",
  draft: "",
  read: 0,
  selected: null,
  commands,
  enabled: true,
  ...overrides,
});

// Feeds the input one chunk at a time, the way a terminal does, and hands back
// the last state plus the first action that was not a repaint.
const type = (chunks: string[], state = fresh()) => {
  let current = state;
  let action: PromptMenuAction = { kind: "none" };

  for (const chunk of chunks) {
    const result = interpretMenuInput(current, chunk);
    current = result.state;
    action = result.action;
    if (action.kind === "submit" || action.kind === "exit") break;
  }

  return { state: current, action };
};

const visibleLabels = (state: PromptMenuState) =>
  promptMenuState(state.draft, state.selected, state.commands).items.map((command) => command.name);

describe("the / menu of the prompt", () => {
  it("opens on a lone slash over an empty prompt", () => {
    const { state, action } = type(["/"]);

    expect(state.draft).toBe("/");
    expect(state.selected).toBe(0);
    expect(action).toEqual({ kind: "render" });
  });

  it("does not open when the prompt already has text", () => {
    const { state } = type(["hola", "/"]);

    expect(state.draft).toBe("hola/");
    expect(state.selected).toBeNull();
  });

  it("does not open when there is no command to offer", () => {
    const { state } = type(["/"], fresh({ commands: [] }));

    expect(state.draft).toBe("/");
    expect(state.selected).toBeNull();
  });

  it("does not open without a terminal to paint it on", () => {
    // A redirected stdin used to treat "/" as plain text, and still must.
    const { state } = type(["/"], fresh({ enabled: false }));

    expect(state.draft).toBe("/");
    expect(state.selected).toBeNull();
  });

  it("filters by name prefix", () => {
    const { state } = type(["/", "mo"]);

    expect(visibleLabels(state)).toEqual(["model", "mode"]);
    expect(state.selected).toBe(0);
  });

  it("filters by alias", () => {
    const { state } = type(["/", "m"]);

    expect(visibleLabels(state)).toEqual(["model", "mode"]);
  });

  it("says nothing matches when the query matches no command", () => {
    const { state } = type(["/", "zz"]);

    // An open dropdown with no row is what the renderer turns into
    // " no matching commands"; the state keeps the draft intact.
    expect(state.selected).toBe(0);
    expect(visibleLabels(state)).toEqual([]);
  });

  it("clamps the selection when the filter shrinks the list", () => {
    const moved = type(["/", "\u001b[B", "\u001b[B", "\u001b[B"]);
    expect(moved.state.selected).toBe(3);

    const { state } = type(["h"], moved.state);
    expect(visibleLabels(state)).toEqual(["help"]);
    expect(state.selected).toBe(0);
  });

  it("moves the selection down with wrap-around", () => {
    const { state } = type(["/", "\u001b[B", "\u001b[B", "\u001b[B", "\u001b[B"]);

    expect(state.selected).toBe(0);
  });

  it("moves the selection up with wrap-around", () => {
    const { state } = type(["/", "\u001b[A"]);

    expect(state.selected).toBe(commands.length - 1);
  });

  it("keeps the arrow key meaning when the sequence arrives split", () => {
    // The terminal may hand the arrow over in two chunks: "\u001b[" then "B".
    const split = type(["/", "\u001b[", "B"]);

    expect(split.state.pending).toBe("");
    expect(split.state.draft).toBe("/");
    expect(split.state.selected).toBe(1);

    // The byte that starts a sequence must never leak into the draft as text.
    const held = interpretMenuInput(fresh({ draft: "/", selected: 0 }), "\u001b[");
    expect(held.state.pending).toBe("\u001b[");
    expect(held.state.draft).toBe("/");
  });

  it("completes with Tab and closes the menu", () => {
    const { state } = type(["/", "mo", "\t"]);

    expect(state.draft).toBe("/model ");
    expect(state.selected).toBeNull();
  });

  it("closes with Esc and keeps what the user typed", () => {
    const { state, action } = type(["/", "mo", "\u001b"]);

    expect(state.draft).toBe("/mo");
    expect(state.selected).toBeNull();
    expect(action).toEqual({ kind: "render" });
  });

  it("closes the menu on the backspace that stops the draft being a command", () => {
    const { state } = type(["/", "\u007f"]);

    expect(state.draft).toBe("");
    expect(state.selected).toBeNull();
  });

  it("sends the highlighted command on Enter", () => {
    const down = type(["/", "mo", "\u001b[B"]);
    expect(promptMenuSelection(down.state.draft, down.state.selected, commands)?.name).toBe("mode");

    const { action } = type(["\r"], down.state);
    expect(action).toEqual({ kind: "submit", value: "/mode" });
  });

  it("sends the draft as it is on Enter when nothing matches", () => {
    // The dead end the old handler left: Enter did nothing at all here.
    const { state, action } = type(["/", "zz", "\r"]);

    expect(action).toEqual({ kind: "submit", value: "/zz" });
    expect(state.selected).toBeNull();
  });

  it("sends what was typed when there is no menu at all", () => {
    const { action } = type(["hola", "\r"]);

    expect(action).toEqual({ kind: "submit", value: "hola" });
  });

  it("closes the menu at the first space and stops filtering the arguments", () => {
    const { state } = type(["/", "mo", "\t"]);

    expect(state.draft).toBe("/model ");
    expect(state.selected).toBeNull();

    // With the menu shut the arguments are text, not a query that matches nothing.
    const args = type(["gpt"], state);
    expect(args.state.draft).toBe("/model gpt");
    expect(args.state.selected).toBeNull();
    // The draft is no longer a bare command, so nothing is filtered by the args.
    expect(promptMenuState(args.state.draft, args.state.selected, commands).query).toBe("");
  });

  it("closes the menu on a space typed right after the slash", () => {
    const { state } = type(["/", " "]);

    expect(state.draft).toBe("/ ");
    expect(state.selected).toBeNull();
  });

  it("shows the range only when part of the list is out of sight", () => {
    // The indicator is the function the line renderer paints with, so this case
    // reads the same decision the user sees instead of recomputing the counter.
    const { state } = type(["/"]);
    const whole = promptMenuState(state.draft, state.selected, state.commands);

    expect(menuRows(whole, commands.length).hiddenBelow).toBe(0);
    expect(menuRangeLabel(whole, menuRows(whole, commands.length))).toBe("");

    // A window shorter than the list leaves rows out of sight and says so.
    const far = type(["/", "\u001b[A"], fresh());
    const farModel = promptMenuState(far.state.draft, far.state.selected, commands);
    const farRows = menuRows(farModel, 2);

    expect(farRows.rows.length).toBe(2);
    expect(farRows.hiddenAbove + farRows.hiddenBelow).toBeGreaterThan(0);
    // The range names the row the cursor is on, which is the last one here.
    expect(menuRangeLabel(farModel, farRows)).toBe(`${commands.length}/${commands.length}`);
  });

  it("acks Ctrl-C as a way out and not as text", () => {
    const { state, action } = type(["/", "mo", "\u0003"]);

    expect(action).toEqual({ kind: "exit" });
    expect(state.draft).toBe("/mo");
  });

  it("counts the chars it has read so far", () => {
    const { state } = type(["ho", "la"]);

    expect(state.read).toBe(4);
    expect(state.draft).toBe("hola");
  });
});
