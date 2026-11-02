import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Formatting is a workspace-level concern, so the repo root is the only entry
// point. This pins the hook wiring in text form because the repo has no YAML
// dependency and this spec must not add one.
const repoRoot = path.resolve(import.meta.dirname, "../..");
const config = readFileSync(path.join(repoRoot, ".pre-commit-config.yaml"), "utf8");

const hookBlock = (id: string): string | undefined => {
  const lines = config.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- id: ${id}`);

  if (start === -1) return undefined;

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trimStart().startsWith("- "));
  const body = end === -1 ? rest : rest.slice(0, end);

  return body.join("\n");
};

describe("pre-commit hook wiring", () => {
  it("keeps a prettier hook that checks instead of writing", () => {
    const block = hookBlock("prettier");

    expect(block).toBeDefined();
    expect(block).toMatch(/entry:.*prettier --check/);
    expect(block).not.toMatch(/entry:.*--write/);
  });

  it("keeps the logo out of the generic whitespace hooks", () => {
    for (const id of ["trailing-whitespace", "end-of-file-fixer"]) {
      expect(hookBlock(id)).toMatch(/exclude: \^cli\/racso-logo\\\.txt\$/);
    }
  });
});
