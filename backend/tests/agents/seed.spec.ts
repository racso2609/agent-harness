import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureAgentsDir } from "../../src/agents/seed";

const dirs: string[] = [];

const makeDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-seed-"));
  dirs.push(dir);
  return dir;
};

const makeSource = (files: Record<string, string>) => {
  const dir = makeDir();
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, "utf8");
  }
  return dir;
};

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("ensureAgentsDir", () => {
  it("copies every markdown file into an empty target", () => {
    const source = makeSource({
      "default.md": "persona",
      "coder.md": "code",
      "notes.txt": "ignored",
    });
    const target = path.join(makeDir(), "agents");

    expect(ensureAgentsDir(target, source)).toBe(true);
    expect(fs.readdirSync(target).sort()).toEqual(["coder.md", "default.md"]);
  });

  it("creates the target directory when missing", () => {
    const source = makeSource({ "default.md": "persona" });
    const target = path.join(makeDir(), "nested", "agents");

    ensureAgentsDir(target, source);

    expect(fs.existsSync(target)).toBe(true);
  });

  it("leaves an existing directory with agents untouched", () => {
    const source = makeSource({ "default.md": "bundled" });
    const target = makeDir();
    fs.writeFileSync(path.join(target, "custom.md"), "mine", "utf8");

    expect(ensureAgentsDir(target, source)).toBe(false);
    expect(fs.readdirSync(target)).toEqual(["custom.md"]);
  });

  it("does nothing when the source has no markdown", () => {
    const source = makeSource({ "readme.txt": "x" });
    const target = makeDir();

    expect(ensureAgentsDir(target, source)).toBe(false);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it("returns false when no target is given", () => {
    expect(ensureAgentsDir("", makeSource({ "a.md": "x" }))).toBe(false);
  });
});
