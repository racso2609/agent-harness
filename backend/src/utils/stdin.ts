import fs from "node:fs";
import path from "node:path";
import terminalImage from "terminal-image";

// State of the prompt currently waiting for input, kept so async output
// (logs) can wipe and redraw the line without losing what the user typed.
let activePrompt: string | null = null;
let typed = "";

const renderPrompt = () => {
  if (activePrompt === null) return;
  process.stdout.write(`\r\x1b[2K${activePrompt}${typed}`);
};

export function input(message: string): Promise<string> {
  return new Promise((resolve) => {
    activePrompt = message;
    typed = "";
    renderPrompt();

    const onData = (buf: Buffer) => {
      const str = buf.toString("utf8");

      for (const char of str) {
        if (char === "\r" || char === "\n") {
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
          if (typed.length) {
            typed = typed.slice(0, -1);
            renderPrompt();
          }
          continue;
        }
        if (char >= " ") {
          typed += char;
          process.stdout.write(char);
        }
      }
    };

    const finish = () => {
      cleanup();
      process.stdout.write("\n");
      const answer = typed;
      typed = "";
      resolve(answer);
    };

    const cleanup = () => {
      activePrompt = null;
      process.stdin.removeListener("data", onData);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    };

    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

// Clears the current line before writing async output (logs) so it does not
// overwrite what the user is typing.
export function clearPrompt() {
  if (activePrompt === null || !process.stdout.isTTY) return;
  process.stdout.write("\r\x1b[2K");
}

// Redraws the prompt and the buffered input after async output was written.
export function restorePrompt() {
  if (activePrompt === null || !process.stdout.isTTY) return;
  renderPrompt();
}

export function closeInput() {
  activePrompt = null;
  typed = "";
}

export async function select(
  message: string,
  options: string[],
): Promise<string> {
  if (!options.length) throw new Error("select requires at least one option");

  console.log(message);
  options.forEach((option, index) => console.log(`  ${index + 1}) ${option}`));

  while (true) {
    const answer = await input("Select an option: ");
    const index = Number(answer.trim()) - 1;
    if (Number.isInteger(index) && index >= 0 && index < options.length) {
      return options[index];
    }
    console.log(
      `Invalid option. Enter a number between 1 and ${options.length}.`,
    );
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
  return fs.readFileSync(
    path.join(import.meta.dirname, "..", "..", "racso-logo.txt"),
    "utf8",
  );
};

export const printLogo = () => {
  console.log(loadLogo(), "\n");
};

export const printImage = async (base64: string) => {
  const cleanBase64 = base64.replace(/^data:image\/\w+;base64,/, "");

  const buffer = Buffer.from(cleanBase64, "base64");
  console.log(await terminalImage.buffer(buffer));
};
