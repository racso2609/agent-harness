import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLoader } from "../../src/agents/AgentLoader";

const dirs: string[] = [];

const makeDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-agents-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("AgentLoader", () => {
  it("always exposes the embedded default agent", () => {
    const registry = new AgentLoader(makeDir()).load();

    expect(registry.get("default")).toBeDefined();
  });

  it("returns only the default when the directory is missing", () => {
    const registry = new AgentLoader(
      path.join(os.tmpdir(), "does-not-exist-agents"),
    ).load();

    expect(registry.list().map((agent) => agent.id)).toEqual(["default"]);
  });

  it("loads markdown definitions from disk", () => {
    const dir = makeDir();
    fs.writeFileSync(
      path.join(dir, "Reviewer.md"),
      "---\ntools: [readFile]\n---\nReview code.",
      "utf8",
    );

    const registry = new AgentLoader(dir).load();
    const agent = registry.get("reviewer");

    expect(agent?.id).toBe("reviewer");
    expect(agent?.tools).toEqual(["readFile"]);
    expect(agent?.personality).toBe("Review code.");
    expect(agent?.source).toContain("Reviewer.md");
  });

  it("skips invalid files and keeps valid ones", () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "broken.md"), "---\nname: x\n---", "utf8");
    fs.writeFileSync(
      path.join(dir, "good.md"),
      "---\n---\nValid persona.",
      "utf8",
    );

    const registry = new AgentLoader(dir).load();

    expect(registry.has("broken")).toBe(false);
    expect(registry.get("good")?.personality).toBe("Valid persona.");
  });
});
