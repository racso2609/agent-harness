import { describe, expect, it, vi } from "vitest";
import {
  CommandDefinition,
  CommandContext,
  CommandRepository,
} from "../../src/commands/CommandRepository";

const makeContext = (): CommandContext => ({
  session: {
    changeProvider: vi.fn(async () => true),
    changeModel: vi.fn(async () => true),
    changeAgent: vi.fn(async () => true),
    listAgents: vi.fn(() => [
      { id: "default", name: "Default" },
      { id: "reviewer", name: "Reviewer" },
    ]),
    compactSession: vi.fn(async () => true),
    status: vi.fn(() => ({
      sessionId: "session-1",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      contextTokens: 0,
      contextUsage: 0,
      autoCompact: true,
      autoCompactThreshold: 80,
    })),
  },
  exit: vi.fn(),
  clear: vi.fn(),
  notify: vi.fn(),
  help: () => "/help — List available commands",
});

describe("CommandRepository", () => {
  it("lists built-in commands without their handlers", () => {
    const repository = new CommandRepository();

    const commands = repository.list();

    expect(commands.map((command) => command.name)).toEqual([
      "help",
      "exit",
      "clear",
      "model",
      "provider",
      "agent",
      "compact",
      "status",
    ]);
    expect(commands[0]).not.toHaveProperty("run");
  });

  it("finds commands by name and alias case-insensitively", () => {
    const repository = new CommandRepository();

    expect(repository.find("EXIT")?.name).toBe("exit");
    expect(repository.find("quit")?.name).toBe("exit");
    expect(repository.find("?")?.name).toBe("help");
  });

  it("returns false for unknown commands", async () => {
    const repository = new CommandRepository();
    const context = makeContext();

    await expect(repository.run("/missing", context)).resolves.toBe(false);
    expect(context.notify).not.toHaveBeenCalled();
  });

  it("runs a command matched through an alias", async () => {
    const repository = new CommandRepository();
    const context = makeContext();

    await expect(repository.run("/quit", context)).resolves.toBe(true);
    expect(context.exit).toHaveBeenCalledOnce();
  });

  it("passes the help text to the context", async () => {
    const repository = new CommandRepository();
    const context = makeContext();

    await repository.run("/help", context);

    expect(context.notify).toHaveBeenCalledWith(context.help());
  });

  it("forwards arguments to custom commands", async () => {
    const run = vi.fn();
    const command: CommandDefinition = {
      name: "echo",
      description: "Echo text",
      run,
    };
    const repository = new CommandRepository([command]);
    const context = makeContext();

    await repository.run("/echo hello world", context);

    expect(run).toHaveBeenCalledWith(context, ["hello", "world"]);
  });

  it("renders aliases and descriptions in the help text", () => {
    const repository = new CommandRepository();

    expect(repository.helpText()).toContain(
      "/exit (/quit) — Exit the session",
    );
  });

  it("reports failed model changes", async () => {
    const repository = new CommandRepository();
    const context = makeContext();
    context.session.changeModel = vi.fn(async () => false);

    await repository.run("/model", context);

    expect(context.notify).toHaveBeenCalledWith("Model not changed");
  });

  it("renders the current session status", async () => {
    const repository = new CommandRepository();
    const context = makeContext();

    await repository.run("/status", context);

    expect(context.notify).toHaveBeenCalledWith(
      expect.stringContaining("Session session-1"),
    );
  });
});
