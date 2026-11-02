import { describe, expect, it } from "vitest";
import { ShellTool } from "../../src/tools/shell";
import type { ApprovalDecision, ToolContext } from "../../src/tools/Tool";

const makeContext = (
  decision: ApprovalDecision = "allow",
  onOutput?: (chunk: string) => void,
): ToolContext => ({
  cwd: process.cwd(),
  sessionId: "session",
  approve: async () => decision,
  onOutput,
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

describe("ShellTool live output", () => {
  it("streams the command output through onOutput", async () => {
    const chunks: string[] = [];
    const tool = new ShellTool({ outputThrottleMs: 0 });

    await tool.execute(
      makeContext("allow", (chunk) => chunks.push(chunk)),
      {
        command: "printf 'alpha\\nbeta\\n'",
      },
    );

    const streamed = chunks.join("");
    expect(streamed).toContain("alpha");
    expect(streamed).toContain("beta");
  });

  it("works without onOutput and keeps the buffered result", async () => {
    const tool = new ShellTool({ outputThrottleMs: 0 });

    const result = await tool.execute(makeContext(), {
      command: "printf 'gamma\\n'",
    });

    expect(result.isError).toBe(false);
    expect(result.output).toContain("gamma");
  });

  it("does not truncate the streamed chunks", async () => {
    const chunks: string[] = [];
    // The result is capped at 16 bytes, but the live stream is not.
    const tool = new ShellTool({ outputThrottleMs: 0, maxOutputBytes: 16 });

    const result = await tool.execute(
      makeContext("allow", (chunk) => chunks.push(chunk)),
      { command: "printf '0123456789abcdefghij\\n'" },
    );

    expect(result.output).toContain("[output truncated]");
    expect(chunks.join("")).toContain("abcdefghij");
  });

  it("coalesces chunks within the throttle window", async () => {
    const chunks: string[] = [];
    // A long window means everything lands in the single flush at exit.
    const tool = new ShellTool({ outputThrottleMs: 60_000 });

    await tool.execute(
      makeContext("allow", (chunk) => chunks.push(chunk)),
      {
        command: "printf 'one\\ntwo\\n'",
      },
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("one");
    expect(chunks[0]).toContain("two");
  });
});
