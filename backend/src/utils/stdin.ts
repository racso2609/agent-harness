import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import terminalImage from "terminal-image";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

export function input(message) {
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      resolve(answer);
    });
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
