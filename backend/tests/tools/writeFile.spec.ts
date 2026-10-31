import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WriteFileTool } from "../../src/tools/writeFile";
import type { ToolContext } from "../../src/tools/Tool";

describe("WriteFileTool", () => {
  let workspace: string;
  let ctx: ToolContext;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "writefile-"));
    ctx = { cwd: workspace, sessionId: "s", approve: async () => true };
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("writes a file inside the workspace", async () => {
    const tool = new WriteFileTool();

    const result = await tool.execute(ctx, {
      path: "a/b.txt",
      content: "hello",
    });

    expect(result.isError).toBeUndefined();
    expect(fs.readFileSync(path.join(workspace, "a", "b.txt"), "utf8")).toBe(
      "hello",
    );
  });

  it("refuses to write outside the workspace", async () => {
    const tool = new WriteFileTool();

    await expect(
      tool.execute(ctx, { path: "../escape.txt", content: "x" }),
    ).rejects.toThrow(/escapes the workspace/);
  });

  it("refuses to write inside .git", async () => {
    const tool = new WriteFileTool();

    await expect(
      tool.execute(ctx, { path: ".git/config", content: "x" }),
    ).rejects.toThrow(/denied path/);
  });

  it("honours extra deny patterns from config", async () => {
    const tool = new WriteFileTool({ deny: ["secrets/*"] });

    await expect(
      tool.execute(ctx, { path: "secrets/token.txt", content: "x" }),
    ).rejects.toThrow(/denied path/);
  });
});
