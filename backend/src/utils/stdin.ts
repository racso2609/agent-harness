import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";

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
