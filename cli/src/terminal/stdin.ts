import fs from "node:fs";
import path from "node:path";
import terminalImage from "terminal-image";
import type { CommandOption } from "@/commands/CommandRepository";
import { clampSelection, filterCommands, moveSelection, visibleCommands } from "./commandMenu";

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

const matches = () => filterCommands(activeCommands, typed.slice(1));

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
  const state = menu;

  const commands = matches();
  state.selected = clampSelection(state.selected, commands.length);

  if (!commands.length) return ["  No matching commands"];

  const maxVisible = Math.max(1, Math.min(MAX_VISIBLE_COMMANDS, (process.stdout.rows ?? 24) - 4));
  const visible = visibleCommands(commands, state.selected, maxVisible);
  const width = Math.max(20, (process.stdout.columns ?? 80) - 1);

  return visible.map((command) => {
    const aliases = command.aliases?.length
      ? ` (${command.aliases.map((alias) => `/${alias}`).join(", ")})`
      : "";
    const label = `  /${command.name}${aliases}  ${command.description}`;
    const text = label.length > width ? `${label.slice(0, Math.max(0, width - 1))}…` : label;

    return command === commands[state.selected] ? `\x1b[7m${text}\x1b[0m` : text;
  });
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

const selectedCommand = () => {
  if (!menu) return undefined;
  const commands = matches();
  return commands[clampSelection(menu.selected, commands.length)];
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

    // Partial escape sequence (e.g. arrow key split across data events).
    let pending = "";

    const closeMenu = () => {
      menu = null;
      render();
    };

    const onData = (buf: Buffer) => {
      const str = pending + buf.toString("utf8");
      pending = "";

      for (let i = 0; i < str.length; i++) {
        const char = str[i];

        if (char === "\u001b") {
          const rest = str.slice(i);

          if (rest.startsWith("\u001b[A") || rest.startsWith("\u001b[B")) {
            i += 2;
            if (menu) {
              const delta = rest.startsWith("\u001b[A") ? -1 : 1;
              menu.selected = moveSelection(menu.selected, delta, matches().length);
              render();
            }
            continue;
          }

          if (rest.startsWith("\u001b[C") || rest.startsWith("\u001b[D")) {
            i += 2;
            continue;
          }

          if (rest.length < 3 && rest.startsWith("\u001b[")) {
            pending = rest;
            return;
          }

          closeMenu();
          continue;
        }

        if (char === "\r" || char === "\n") {
          if (menu) {
            const command = selectedCommand();
            if (!command) continue;
            typed = `/${command.name}`;
            render();
          }
          finish();
          return;
        }

        if (char === "\u0003") {
          // Ctrl-C
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
        }

        if (char === "\u007f" || char === "\b") {
          if (!typed.length) continue;
          typed = typed.slice(0, -1);
          if (menu) {
            if (typed.startsWith("/")) menu.selected = 0;
            else menu = null;
          }
          render();
          continue;
        }

        if (
          char === "/" &&
          !menu &&
          typed === "" &&
          activeCommands.length &&
          process.stdin.isTTY &&
          process.stdout.isTTY
        ) {
          typed = "/";
          menu = { selected: 0 };
          render();
          continue;
        }

        if (char >= " ") {
          typed += char;
          if (menu) menu.selected = 0;
          render();
        }
      }
    };

    const finish = () => {
      const answer = typed;
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
