import { describe, expect, it } from "vitest";
import { ShellTool } from "../../src/tools/shell";
import type { ApprovalDecision, ToolContext } from "../../src/tools/Tool";

const makeContext = (decision: ApprovalDecision = "allow"): ToolContext => ({
  cwd: process.cwd(),
  sessionId: "session",
  approve: async () => decision,
});

describe("ShellTool", () => {
  it("runs a command and returns stdout and the exit code", async () => {
    const tool = new ShellTool();

    const result = await tool.execute(makeContext(), {
      command: "echo hello",
    });

    expect(result.isError).toBe(false);
    expect(result.output).toContain("exitCode: 0");
    expect(result.output).toContain("hello");
  });

  it("does not execute when approval is denied", async () => {
    const tool = new ShellTool();

    const result = await tool.execute(makeContext("deny"), {
      command: "echo hello",
    });

    expect(result).toEqual({
      output: "Command rejected by the user",
      isError: true,
    });
  });

  it("rejects missing commands", async () => {
    const tool = new ShellTool();

    await expect(tool.execute(makeContext(), {})).rejects.toThrow(
      "shell expects a non-empty 'command' string",
    );
  });
});
