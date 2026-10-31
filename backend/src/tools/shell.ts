import { spawn } from "node:child_process";
import type { Tool, ToolContext, ToolResult } from "./Tool";

interface ShellOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

// Only pass variables that are safe/useful for commands. Keeps provider
// credentials (API keys, tokens) out of child processes.
const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "USER",
  "LOGNAME",
];

const safeEnv = (): NodeJS.ProcessEnv => {
  const entries = SAFE_ENV_KEYS.flatMap((key) => {
    const value = process.env[key];
    return value ? [[key, value] as const] : [];
  });

  return Object.fromEntries(entries);
};

class ShellTool implements Tool {
  name = "shell";
  description =
    "Run a shell command in the workspace and return its stdout, stderr and exit code.";
  parameters = {
    type: "object" as const,
    properties: {
      command: {
        type: "string" as const,
        description: "Shell command to execute.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  };

  protected timeoutMs: number;
  protected maxOutputBytes: number;

  constructor(options: ShellOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 32_768;
  }

  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const input = args as { command?: unknown } | null | undefined;
    if (typeof input?.command !== "string" || !input.command.trim()) {
      throw new Error("shell expects a non-empty 'command' string");
    }

    const command = input.command;
    if (!(await ctx.approve(command))) {
      return { output: "Command rejected by the user", isError: true };
    }

    return this.run(ctx, command);
  }

  protected run(ctx: ToolContext, command: string): Promise<ToolResult> {
    return new Promise((resolve) => {
      const child = spawn("/bin/bash", ["-lc", command], {
        cwd: ctx.cwd,
        env: safeEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        // Run in its own process group so the whole tree can be killed.
        detached: process.platform !== "win32",
      });

      let stdout = "";
      let stderr = "";
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const append = (current: string, chunk: string) => {
        if (current.length >= this.maxOutputBytes) {
          truncated = true;
          return current;
        }

        const room = this.maxOutputBytes - current.length;
        if (chunk.length > room) {
          truncated = true;
          return current + chunk.slice(0, room);
        }

        return current + chunk;
      };

      const kill = () => {
        if (!child.pid) return;

        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };

      const onAbort = () => {
        timedOut = true;
        kill();
      };

      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, this.timeoutMs);

      ctx.signal?.addEventListener("abort", onAbort);

      const finish = (result: ToolResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk.toString("utf8"));
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk.toString("utf8"));
      });

      child.on("error", (err) => {
        finish({ output: `Failed to start command: ${err.message}`, isError: true });
      });

      child.on("close", (code, signal) => {
        const parts: string[] = [];

        if (timedOut) {
          parts.push(`Command timed out after ${this.timeoutMs}ms`);
        }

        parts.push(
          `exitCode: ${code ?? "null"}${signal ? ` (signal ${signal})` : ""}`,
        );
        if (stdout) parts.push(`stdout:\n${stdout}`);
        if (stderr) parts.push(`stderr:\n${stderr}`);
        if (truncated) parts.push("[output truncated]");

        finish({
          output: parts.join("\n"),
          isError: timedOut || (code ?? 1) !== 0,
        });
      });
    });
  }
}

export { ShellTool };
export type { ShellOptions };
