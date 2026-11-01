#!/usr/bin/env node
// Launches the compiled CLI with the tsconfig `paths` alias resolver enabled.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const child = spawn(
  process.execPath,
  ["--import", path.join(root, "loader.mjs"), path.join(root, "dist/main.js"), ...process.argv.slice(2)],
  { stdio: "inherit" },
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
