import fs from "node:fs";
import path from "node:path";

// Directory shipped with the package holding the example agent definitions.
// Both the source layout (src/agents/seed.ts) and the build output
// (dist/agents/seed.js) sit two levels below the package root, so the same
// relative hop resolves in both.
export const bundledAgentsDir = () =>
  path.join(import.meta.dirname, "..", "..", "agents");

const listMarkdown = (dir: string) => {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith(".md"));
  } catch {
    return [];
  }
};

// Seeds the runtime agents directory with the bundled example definitions.
// Only runs on a clean install: an existing target with at least one .md is
// left untouched so user agents are never overwritten.
export const ensureAgentsDir = (
  target = "",
  source = bundledAgentsDir(),
): boolean => {
  if (!target) return false;
  if (listMarkdown(target).length) return false;

  const files = listMarkdown(source);
  if (!files.length) return false;

  fs.mkdirSync(target, { recursive: true });

  for (const file of files) {
    fs.copyFileSync(path.join(source, file), path.join(target, file));
  }

  return true;
};
