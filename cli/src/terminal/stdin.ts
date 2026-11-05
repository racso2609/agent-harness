import fs from "node:fs";
import path from "node:path";
import terminalImage from "terminal-image";
import type { CommandOption } from "@/commands/CommandRepository";
import { clampSelection, menuRows } from "./commandMenu";
import {
  interpretMenuInput,
  menuRangeLabel,
  promptMenuState,
  type PromptMenuState,
} from "./promptMenu";

// State of the prompt currently waiting for input, kept so async output
// (logs) can wipe and redraw the line without losing what the user typed.
let activePrompt: string | null = null;
let typed = "";
// Commands offered by the "/" menu for the current input.
let activeCommands: CommandOption[] = [];
// Open command menu state; null when the menu is closed.
let menu: { selected: number } | null = null;
// How many terminal lines the menu currently occupies below the prompt.
let linesBelow = 0;

const MAX_VISIBLE_COMMANDS = 8;

// Writes a line to stdout. This is terminal rendering (menus, prompts,
// logo, images), not application logging, so it deliberately bypasses
// the structured logger.
const write = (text: string) => {
  process.stdout.write(`${text}\n`);
};

// The filtered list in the shared shape. Storing the selection next to it
// lets the window maths come from commandMenu instead of being written again
// here, where it could drift from what the TUI paints.
const menuState = () => promptMenuState(typed, menu?.selected ?? null, activeCommands);

// How many rows fit under the prompt without pushing the menu off screen.
const maxVisibleRows = () =>
  Math.max(1, Math.min(MAX_VISIBLE_COMMANDS, (process.stdout.rows ?? 24) - 4));

// Erases the menu lines and leaves the cursor at the start of the prompt line.
const clearRenderedLines = () => {
  if (!process.stdout.isTTY || linesBelow <= 0) {
    linesBelow = 0;
    return;
  }

  for (let i = 0; i < linesBelow; i++) {
    process.stdout.write("\r\x1b[2K\x1b[1A");
  }
  linesBelow = 0;
};

const renderMenuLines = (): string[] => {
  if (!menu) return [];

  const state = menuState();
  // The stored index is clamped in place: the user's next arrow starts from
  // where the list actually is, not from where it was before the query shrank
  // it.
  state.selected = clampSelection(state.selected, state.items.length);
  menu = { selected: state.selected };

  // The dropdown says so instead of vanishing: an empty list looks like the
  // menu broke, and enter still sends the draft.
  if (!state.items.length) return [" no matching commands"];

  const rows = menuRows(state, maxVisibleRows());
  const width = Math.max(20, (process.stdout.columns ?? 80) - 1);
  // The range only appears when part of the list is out of sight, so it does
  // not become noise on the usual short list.
  const rangeLabel = menuRangeLabel(state, rows);
  const range = rangeLabel ? ` ${rangeLabel}` : "";

  const painted = rows.rows.map((command, index) => {
    const aliases = command.aliases?.length
      ? ` (${command.aliases.map((alias) => `/${alias}`).join(", ")})`
      : "";
    const label = ` /${command.name}${aliases} ${command.description}${
      index === rows.rows.length - 1 ? range : ""
    }`;
    const text = label.length > width ? `${label.slice(0, Math.max(0, width - 1))}…` : label;

    return rows.start + index === state.selected ? `\x1b[7m${text}\x1b[0m` : text;
  });

  return painted;
};

const render = () => {
  if (activePrompt === null || !process.stdout.isTTY) return;

  clearRenderedLines();
  process.stdout.write(`\r\x1b[2K${activePrompt}${typed}`);

  const lines = renderMenuLines();
  for (const line of lines) process.stdout.write(`\n\x1b[2K${line}`);
  linesBelow = lines.length;
};

const reset = () => {
  activePrompt = null;
  typed = "";
  activeCommands = [];
  menu = null;
  linesBelow = 0;
};

export interface InputOptions {
  // When present, typing "/" on an empty prompt opens a command menu.
  commands?: CommandOption[];
}

export function input(message: string, options: InputOptions = {}): Promise<string> {
  return new Promise((resolve) => {
    activePrompt = message;
    typed = "";
    activeCommands = options.commands ?? [];
    menu = null;
    linesBelow = 0;
    render();

    // What the prompt has read and not acted on yet. The keys themselves live in
    // the reducer, which is pure and tested on its own; this closure owns the
    // terminal and nothing else. The dropdown only exists on a terminal: with a
    // redirected stdin, "/" has to stay plain text as it always did.
    let read: PromptMenuState = {
      pending: "",
      draft: "",
      read: 0,
      selected: null,
      commands: activeCommands,
      enabled: process.stdin.isTTY && process.stdout.isTTY,
    };

    // The reducer decides and this applies: fold the chunk into the draft, then
    // paint, submit or leave as the action says. Following the reducer's `selected`
    // is what closes the dropdown the moment the text stops being a bare command.
    const onData = (buf: Buffer) => {
      // The tty flags are read per chunk: the dropdown is a thing only a terminal
      // can paint, and a redirected stdin must keep treating "/" as plain text.
      const result = interpretMenuInput(read, buf.toString("utf8"));

      read = { ...result.state, enabled: process.stdin.isTTY && process.stdout.isTTY };
      typed = read.draft;
      menu = read.selected === null ? null : { selected: read.selected };

      switch (result.action.kind) {
        case "render":
          render();
          return;
        case "submit":
          finish(result.action.value);
          return;
        case "exit":
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
          return;
        default:
          return;
      }
    };

    const finish = (answer: string) => {
      clearRenderedLines();
      cleanup();
      process.stdout.write("\n");
      resolve(answer);
    };

    const cleanup = () => {
      reset();
      process.stdin.removeListener("data", onData);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    };

    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

// Clears the prompt and menu before writing async output (logs) so they do
// not overwrite what the user is typing.
export function clearPrompt() {
  if (activePrompt === null || !process.stdout.isTTY) return;
  clearRenderedLines();
  process.stdout.write("\r\x1b[2K");
}

// Redraws the prompt and menu after async output was written.
export function restorePrompt() {
  if (activePrompt === null || !process.stdout.isTTY) return;
  render();
}

export function closeInput() {
  reset();
}

export async function select(message: string, options: string[]): Promise<string> {
  if (!options.length) throw new Error("select requires at least one option");

  write(message);
  options.forEach((option, index) => write(`  ${index + 1}) ${option}`));

  while (true) {
    const answer = await input("Select an option: ");
    const index = Number(answer.trim()) - 1;
    if (Number.isInteger(index) && index >= 0 && index < options.length) {
      return options[index];
    }
    write(`Invalid option. Enter a number between 1 and ${options.length}.`);
  }
}

export function askHidden(message: string): Promise<string> {
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;

  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  process.stdout.write(message);

  return new Promise((resolve) => {
    let value = "";

    const onData = (buf: Buffer) => {
      const char = buf.toString();

      if (char === "\r" || char === "\n") return done();
      if (char === "\u0003") {
        stdin.removeListener("data", onData);
        if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
        process.stdout.write("\n");
        process.exit(130);
      }
      if (char === "\u007f" || char === "\b") {
        if (value.length) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      if (char >= " ") {
        value += char;
        process.stdout.write("*");
      }
    };

    const done = () => {
      stdin.removeListener("data", onData);
      if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
      process.stdout.write("\n");
      resolve(value);
    };

    stdin.on("data", onData);
  });
}

export const loadLogo = () => {
  return fs.readFileSync(path.join(import.meta.dirname, "..", "..", "racso-logo.txt"), "utf8");
};

export const printLogo = () => {
  write(loadLogo());
  write("");
};

export const printImage = async (base64: string) => {
  const cleanBase64 = base64.replace(/^data:image\/\w+;base64,/, "");

  const buffer = Buffer.from(cleanBase64, "base64");
  write(await terminalImage.buffer(buffer));
};
