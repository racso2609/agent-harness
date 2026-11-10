import { describe, expect, it, vi } from "vitest";
import { ForgetTool } from "../../src/tools/forget";
import type { ForgetResult, MemoryScope, ToolContext } from "../../src/tools/Tool";

const makeCtx = (
  forgetMemory?: (id: string, scope: MemoryScope) => Promise<ForgetResult>,
): ToolContext => ({
  cwd: process.cwd(),
  sessionId: "session",
  approve: async () => "allow",
  ...(forgetMemory ? { forgetMemory } : {}),
});

describe("ForgetTool", () => {
  it("rejects a non-numeric id without calling the callback", async () => {
    for (const id of ["0", "-12", "1e3", "12.0", "abc", ""]) {
      const forgetMemory = vi.fn(async () => ({ forgotten: true, reason: "ok" as const }));
      const tool = new ForgetTool();

      const result = await tool.execute(makeCtx(forgetMemory), { id });

      expect(result.isError).toBe(true);
      expect(forgetMemory).not.toHaveBeenCalled();
    }
  });

  it("reports an unusable session when the callback is missing", async () => {
    const tool = new ForgetTool();

    const result = await tool.execute(makeCtx(), { id: "12" });

    expect(result.isError).toBe(true);
    expect(result.output).toBe("Memory is not available in this session");
  });

  it("deletes the memory and confirms the id", async () => {
    const forgetMemory = vi.fn(async () => ({ forgotten: true, reason: "ok" as const }));
    const tool = new ForgetTool();

    const result = await tool.execute(makeCtx(forgetMemory), { id: "12" });

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("Forgot memory 12.");
    expect(forgetMemory).toHaveBeenCalledWith("12", "project");
  });

  it("gives every reason its own message and error flag", async () => {
    const outcomes: {
      reason: ForgetResult["reason"];
      forgotten: boolean;
      isError: boolean;
      contains: string;
    }[] = [
      { reason: "ok", forgotten: true, isError: false, contains: "Forgot memory 12." },
      { reason: "not-found", forgotten: false, isError: true, contains: "No memory with id 12" },
      {
        reason: "out-of-scope",
        forgotten: false,
        isError: true,
        contains: "belongs to another session or project",
      },
      {
        reason: "unsupported",
        forgotten: false,
        isError: true,
        contains: "cannot delete memories",
      },
      {
        reason: "failed",
        forgotten: false,
        isError: true,
        contains: "forget failed for memory 12",
      },
    ];

    const messages: string[] = [];
    for (const outcome of outcomes) {
      const tool = new ForgetTool();

      const result = await tool.execute(
        makeCtx(async () => ({ forgotten: outcome.forgotten, reason: outcome.reason })),
        { id: "12" },
      );

      expect(result.isError ?? false).toBe(outcome.isError);
      expect(result.output).toContain(outcome.contains);
      messages.push(result.output);
    }

    // Distinct per reason: the model picks its answer from the wording.
    expect(new Set(messages).size).toBe(outcomes.length);
  });

  it("does not leak a thrown provider error as a rejection", async () => {
    const tool = new ForgetTool();

    const result = await tool.execute(
      makeCtx(async () => {
        throw new Error("backend down");
      }),
      { id: "12" },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("backend down");
  });
});
