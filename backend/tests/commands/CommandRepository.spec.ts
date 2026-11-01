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
    listSessions: vi.fn(() => [
      {
        id: "session-1",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-02T00:00:00.000Z",
        provider: "openai",
        model: "model",
        messageCount: 3,
        title: "hello",
      },
    ]),
    changeSession: vi.fn(async () => true),
    compactSession: vi.fn(async () => true),
    spawn: vi.fn((agentId: string, prompt: string) => ({
      spawnId: "spawn-1",
      sessionId: "session-1",
      agentId,
      prompt,
      status: "running" as const,
      startedAt: "2024-01-01T00:00:00.000Z",
    })),
    listSpawns: vi.fn(() => []),
    waitSpawn: vi.fn(async () => undefined),
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
      "sessions",
      "resume",
      "compact",
      "status",
      "spawn",
      "children",
      "join",
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

  it("lists persisted sessions marking the active one", async () => {
    const repository = new CommandRepository();
    const context = makeContext();

    await repository.run("/sessions", context);

    expect(context.session.listSessions).toHaveBeenCalledOnce();
    expect(context.notify).toHaveBeenCalledWith(
      expect.stringContaining("* 1) session-1 — hello"),
    );
  });

  it("resumes a persisted session by id or index", async () => {
    const repository = new CommandRepository();
    const context = makeContext();

    await repository.run("/resume 1", context);

    expect(context.session.changeSession).toHaveBeenCalledWith("1");
    expect(context.notify).toHaveBeenCalledWith(
      expect.stringContaining("Session resumed"),
    );
  });

  it("reports failed session switches", async () => {
    const repository = new CommandRepository();
    const context = makeContext();
    context.session.changeSession = vi.fn(async () => false);

    await repository.run("/resume missing", context);

    expect(context.notify).toHaveBeenCalledWith(
      "Session not changed: missing",
    );
  });

  it("spawns a background agent from agent and prompt args", async () => {
    const repository = new CommandRepository();
    const context = makeContext();

    await repository.run("/spawn coder write the docs", context);

    expect(context.session.spawn).toHaveBeenCalledWith(
      "coder",
      "write the docs",
    );
    expect(context.notify).toHaveBeenCalledWith(
      expect.stringContaining("Spawned spawn-1"),
    );
  });

  it("explains spawn usage when arguments are missing", async () => {
    const repository = new CommandRepository();
    const context = makeContext();

    await repository.run("/spawn coder", context);

    expect(context.session.spawn).not.toHaveBeenCalled();
    expect(context.notify).toHaveBeenCalledWith("Usage: /spawn <agent> <prompt>");
  });

  it("reports spawn failures from the session", async () => {
    const repository = new CommandRepository();
    const context = makeContext();
    context.session.spawn = vi.fn(() => {
      throw new Error("Spawning is disabled");
    });

    await repository.run("/spawn coder task", context);

    expect(context.notify).toHaveBeenCalledWith(
      "Spawn failed: Spawning is disabled",
    );
  });

  it("lists spawned agents", async () => {
    const repository = new CommandRepository();
    const context = makeContext();
    context.session.listSpawns = vi.fn(() => [
      {
        spawnId: "spawn-1",
        sessionId: "session-1",
        agentId: "coder",
        prompt: "task",
        status: "done" as const,
        startedAt: "2024-01-01T00:00:00.000Z",
        result: "all done",
      },
    ]);

    await repository.run("/children", context);

    expect(context.notify).toHaveBeenCalledWith(
      expect.stringContaining("[DONE] spawn-1 (coder)"),
    );
  });

  it("joins a spawned agent and shows its result", async () => {
    const repository = new CommandRepository();
    const context = makeContext();
    context.session.waitSpawn = vi.fn(async () => ({
      spawnId: "spawn-1",
      sessionId: "session-1",
      agentId: "coder",
      prompt: "task",
      status: "done" as const,
      startedAt: "2024-01-01T00:00:00.000Z",
      result: "the result",
    }));

    await repository.run("/join spawn-1", context);

    expect(context.notify).toHaveBeenCalledWith(
      expect.stringContaining("the result"),
    );
  });

  it("reports unknown spawn ids on join", async () => {
    const repository = new CommandRepository();
    const context = makeContext();

    await repository.run("/join nope", context);

    expect(context.notify).toHaveBeenCalledWith("Unknown spawn: nope");
  });
});
