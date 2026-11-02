import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveInWorkspace } from "../../src/tools/paths";

describe("resolveInWorkspace", () => {
  let workspace: string;
  let outside: string;

  beforeAll(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paths-"));
    workspace = path.join(root, "workspace");
    outside = path.join(root, "outside");
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "top secret");
  });

  afterAll(() => {
    fs.rmSync(path.dirname(workspace), { recursive: true, force: true });
  });

  it("resolves a relative path inside the workspace", () => {
    expect(resolveInWorkspace(workspace, "a/b.txt")).toBe(path.join(workspace, "a", "b.txt"));
  });

  it("accepts an absolute path inside the workspace", () => {
    const target = path.join(workspace, "nested", "file.txt");
    expect(resolveInWorkspace(workspace, target)).toBe(target);
  });

  it("allows the workspace root itself", () => {
    expect(resolveInWorkspace(workspace, ".")).toBe(workspace);
  });

  it("rejects a relative path escaping with ..", () => {
    expect(() => resolveInWorkspace(workspace, "../outside/secret.txt")).toThrow(
      /escapes the workspace/,
    );
  });

  it("rejects an absolute path outside the workspace", () => {
    expect(() => resolveInWorkspace(workspace, path.join(outside, "secret.txt"))).toThrow(
      /escapes the workspace/,
    );
  });

  it("rejects a symlink pointing outside the workspace", () => {
    const link = path.join(workspace, "link.txt");
    fs.symlinkSync(path.join(outside, "secret.txt"), link);

    expect(() => resolveInWorkspace(workspace, "link.txt")).toThrow(/escapes the workspace/);
  });
});
