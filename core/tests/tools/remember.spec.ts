import { describe, expect, it, vi } from "vitest";
import { RememberTool } from "../../src/tools/remember";
import type { RememberInput, RememberResult, ToolContext } from "../../src/tools/Tool";

const makeCtx = (
  rememberMemory?: (input: RememberInput) => Promise<RememberResult>,
): ToolContext => ({
  cwd: process.cwd(),
  sessionId: "session",
  approve: async () => "allow",
  ...(rememberMemory ? { rememberMemory } : {}),
});

const valid = {
  kind: "fact",
  scope: "project",
  title: "Deploy pipeline",
  content: "CI runs the deploy through GitHub Actions.",
  topicKey: "deploy.pipeline",
};

describe("RememberTool", () => {
  it("reports an unusable session when the callback is missing", async () => {
    const tool = new RememberTool();

    const result = await tool.execute(makeCtx(), valid);

    expect(result.isError).toBe(true);
    expect(result.output).toBe("Memory is not available in this session");
  });

  it("rejects a kind outside the enum without calling the callback", async () => {
    const rememberMemory = vi.fn(async () => ({ id: "1" }));
    const tool = new RememberTool();

    const result = await tool.execute(makeCtx(rememberMemory), { ...valid, kind: "procedure" });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("'kind' to be one of");
    expect(rememberMemory).not.toHaveBeenCalled();
  });

  it("rejects a scope outside the enum without calling the callback", async () => {
    const rememberMemory = vi.fn(async () => ({ id: "1" }));
    const tool = new RememberTool();

    const result = await tool.execute(makeCtx(rememberMemory), { ...valid, scope: "global" });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("'scope' to be one of");
    expect(rememberMemory).not.toHaveBeenCalled();
  });

  it("rejects a title longer than 120 characters", async () => {
    const rememberMemory = vi.fn(async () => ({ id: "1" }));
    const tool = new RememberTool();

    const result = await tool.execute(makeCtx(rememberMemory), {
      ...valid,
      title: "t".repeat(121),
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("at most 120 characters");
    expect(rememberMemory).not.toHaveBeenCalled();
  });

  it("rejects content longer than the configured cap", async () => {
    const rememberMemory = vi.fn(async () => ({ id: "1" }));
    const tool = new RememberTool({ maxContentChars: 10 });

    const result = await tool.execute(makeCtx(rememberMemory), {
      ...valid,
      content: "c".repeat(11),
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("at most 10 characters");
    expect(rememberMemory).not.toHaveBeenCalled();
  });

  it("requires a topicKey for fact, decision and preference", async () => {
    for (const kind of ["fact", "decision", "preference"]) {
      const rememberMemory = vi.fn(async () => ({ id: "1" }));
      const tool = new RememberTool();

      const result = await tool.execute(makeCtx(rememberMemory), {
        ...valid,
        kind,
        topicKey: undefined,
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("requires 'topicKey'");
      expect(rememberMemory).not.toHaveBeenCalled();
    }
  });

  it("does not require a topicKey when the backend cannot upsert", async () => {
    const rememberMemory = vi.fn(async () => ({ id: "1" }));
    const tool = new RememberTool({ topicKeyUnsupported: true });

    const result = await tool.execute(makeCtx(rememberMemory), {
      ...valid,
      topicKey: undefined,
    });

    expect(result.isError).toBeUndefined();
    expect(rememberMemory).toHaveBeenCalledWith(expect.objectContaining({ kind: "fact" }));
    // Still no invented key: the backend would drop it anyway.
    expect(rememberMemory.mock.calls[0]?.[0]).not.toHaveProperty("topicKey");
  });
  it("lets an episode omit the topicKey", async () => {
    const rememberMemory = vi.fn(async () => ({ id: "1" }));
    const tool = new RememberTool();

    const result = await tool.execute(makeCtx(rememberMemory), {
      ...valid,
      kind: "episode",
      topicKey: undefined,
    });

    expect(result.isError).toBeUndefined();
    expect(rememberMemory).toHaveBeenCalledWith({
      kind: "episode",
      scope: "project",
      title: valid.title,
      content: valid.content,
    });
  });

  it("stores the memory and reports its id", async () => {
    const rememberMemory = vi.fn(async () => ({ id: "42" }));
    const tool = new RememberTool();

    const result = await tool.execute(makeCtx(rememberMemory), valid);

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("42");
    expect(rememberMemory).toHaveBeenCalledWith({
      kind: "fact",
      scope: "project",
      title: valid.title,
      content: valid.content,
      topicKey: valid.topicKey,
    });
  });

  it("turns an unsupported backend into an error that never says remembered", async () => {
    const tool = new RememberTool();

    const result = await tool.execute(
      makeCtx(async () => ({ error: "unsupported" })),
      valid,
    );

    expect(result.isError).toBe(true);
    expect(result.output).not.toContain("Remembered");
    expect(result.output).toContain("cannot store memories");
  });

  it("turns a failed write into an error that carries the detail", async () => {
    const tool = new RememberTool();

    const result = await tool.execute(
      makeCtx(async () => ({ error: "failed", detail: "disk full" })),
      valid,
    );

    expect(result.isError).toBe(true);
    expect(result.output).not.toContain("Remembered");
    expect(result.output).toContain("disk full");
  });
});
