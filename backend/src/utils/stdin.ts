import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import terminalImage from "terminal-image";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

export function input(message: string) {
  return new Promise<string>((resolve) => {
    rl.question(message, (answer) => {
      resolve(answer);
    });
  });
}

export function closeInput() {
  rl.close();
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
