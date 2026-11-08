import { describe, expect, it, vi } from "vitest";
import {
  CommandDefinition,
  CommandContext,
  CommandRepository,
} from "../../src/commands/CommandRepository";

const makeContext = (): CommandContext => ({
  harness: {
    initialize: vi.fn(async () => {}),
    ask: vi.fn(),
    status: vi.fn(() => ({
      sessionId: "session-1",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      contextTokens: 0,
      contextUsage: 0,
      autoCompact: true,
      autoCompactThreshold: 80,
    })),
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
    resolveSession: vi.fn(() => "session-1"),
    loadSession: vi.fn(async () => true),
    save: vi.fn(),
    listProviders: vi.fn(() => ["openai"]),
    listProviderDetails: vi.fn(() => [
      {
        id: "openai",
        type: "openai",
        url: "https://api.example.com",
        apikey: "key",
        model: "model",
        isDefault: true,
      },
    ]),
    configureProvider: vi.fn(),
    removeProvider: vi.fn(() => true),
    setProvider: vi.fn(async () => true),
    listModels: vi.fn(() => []),
    setModel: vi.fn(() => true),
    listAgents: vi.fn(() => [
      { id: "default", name: "Default" },
      { id: "reviewer", name: "Reviewer" },
    ]),
    setAgent: vi.fn(async () => true),
    listSkills: vi.fn(() => [
      {
        id: "deploy",
        name: "Deploy",
        description: "How to ship a release.",
        tags: ["ops"],
        source: "/skills/deploy/SKILL.md",
      },
    ]),
    reloadSkills: vi.fn(() => [
      {
        id: "deploy",
        name: "Deploy",
        description: "How to ship a release.",
        tags: ["ops"],
        source: "/skills/deploy/SKILL.md",
      },
    ]),
    approveWith: vi.fn(),
    spawn: vi.fn((agentId: string, prompt: string) => ({
      spawnId: "spawn-1",
      sessionId: "session-1",
      agentId,
      prompt,
      status: "running" as const,
      startedAt: "2024-01-01T00:00:00.000Z",
    })),
    pollSpawn: vi.fn(() => undefined),
    listSpawns: vi.fn(() => []),
    waitSpawn: vi.fn(async () => undefined),
    collectSpawns: vi.fn(async () => []),
    compactSession: vi.fn(async () => true),
    listMcpServers: vi.fn(() => []),
    reloadMcp: vi.fn(async () => []),
    mcpTools: vi.fn(() => []),
    shutdown: vi.fn(),
  } as unknown as CommandContext["harness"],
  flows: {
    changeProvider: vi.fn(async () => true),
    addProvider: vi.fn(async () => true),
    removeProvider: vi.fn(async () => true),
    changeModel: vi.fn(async () => true),
    changeAgent: vi.fn(async () => true),
    changeSession: vi.fn(async () => true),
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
      "skills",
      "skill",
      "mcp",
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

    expect(repository.helpText()).toContain("/exit (/quit) — Exit the session");
  });

  it("reports failed model changes", async () => {
    const repository = new CommandRepository();
    const context = makeContext();
    context.flows.changeModel = vi.fn(async () => false);

    await repository.run("/model", context);

    expect(context.notify).toHaveBeenCalledWith("Model not changed");
  });

  it("lists providers marking the active and default ones", async () => {
    const repository = new CommandRepository();
    const context = makeContext();
    context.harness.status = vi.fn(() => ({
      sessionId: "session-1",
      provider: "openai",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      contextTokens: 0,
      contextUsage: 0,
      autoCompact: true,
      autoCompactThreshold: 80,
    }));

    await repository.run("/provider ls", context);

    expect(context.notify).toHaveBeenCalledWith(
      expect.stringContaining("openai (openai) https://api.example.com — model [default, active]"),
    );
  });

  it("lists providers through the alias and opens the picker with no args", async () => {
    const repository = new CommandRepository();
    const context = makeContext();

    await repository.run("/providers", context);

    expect(context.flows.changeProvider).toHaveBeenCalledWith(context.harness);
  });

  it("adds a provider instance", async () => {
    const repository = new CommandRepository();
    const context = makeContext();

    await repository.run("/provider add", context);

    expect(context.flows.addProvider).toHaveBeenCalledWith(context.harness);
    expect(context.notify).toHaveBeenCalledWith("Provider added");
  });

  it("removes a provider instance by id", async () => {
    const repository = new CommandRepository();
    const context = makeContext();

    await repository.run("/provider rm cheap", context);

    expect(context.flows.removeProvider).toHaveBeenCalledWith(context.harness, "cheap");
    expect(context.notify).toHaveBeenCalledWith("Provider removed");
  });

  it("reports provider removal failures", async () => {
    const repository = new CommandRepository();
    const context = makeContext();
    context.flows.removeProvider = vi.fn(async () => {
      throw new Error("Cannot remove the last configured provider");
    });

    await repository.run("/provider rm openai", context);

    expect(context.notify).toHaveBeenCalledWith(
      "Provider not removed: Cannot remove the last configured provider",
    );
  });

  it("switches to a provider when given its id", async () => {
    const repository = new CommandRepository();
    const context = makeContext();

    await repository.run("/provider cheap", context);

    expect(context.flows.changeProvider).toHaveBeenCalledWith(context.harness, "cheap");
    expect(context.notify).toHaveBeenCalledWith("Provider updated");
  });

  it("renders the current session status", async () => {
    const repository = new CommandRepository();
    const context = makeContext();

    await repository.run("/status", context);

    expect(context.notify).toHaveBeenCalledWith(expect.stringContaining("Session session-1"));
  });

  it("lists persisted sessions marking the active one", async () => {
    const repository = new CommandRepository();
    const context = makeContext();

    await repository.run("/sessions", context);

    expect(context.harness.listSessions).toHaveBeenCalledOnce();
    expect(context.notify).toHaveBeenCalledWith(expect.stringContaining("* 1) session-1 — hello"));
  });

  it("resumes a persisted session by id or index", async () => {
    const repository = new CommandRepository();
    const context = makeContext();

    await repository.run("/resume 1", context);

    expect(context.flows.changeSession).toHaveBeenCalledWith(context.harness, "1");
    expect(context.notify).toHaveBeenCalledWith(expect.stringContaining("Session resumed"));
  });

  it("reports failed session switches", async () => {
    const repository = new CommandRepository();
    const context = makeContext();
    context.flows.changeSession = vi.fn(async () => false);

    await repository.run("/resume missing", context);

    expect(context.notify).toHaveBeenCalledWith("Session not changed: missing");
  });

  it("spawns a background agent from agent and prompt args", async () => {
    const repository = new CommandRepository();
    const context = makeContext();

    await repository.run("/spawn coder write the docs", context);

    expect(context.harness.spawn).toHaveBeenCalledWith("coder", "write the docs");
    expect(context.notify).toHaveBeenCalledWith(expect.stringContaining("Spawned spawn-1"));
  });

  it("explains spawn usage when arguments are missing", async () => {
    const repository = new CommandRepository();
    const context = makeContext();

    await repository.run("/spawn coder", context);

    expect(context.harness.spawn).not.toHaveBeenCalled();
    expect(context.notify).toHaveBeenCalledWith("Usage: /spawn <agent> <prompt>");
  });

  it("reports spawn failures from the session", async () => {
    const repository = new CommandRepository();
    const context = makeContext();
    context.harness.spawn = vi.fn(() => {
      throw new Error("Spawning is disabled");
    });

    await repository.run("/spawn coder task", context);

    expect(context.notify).toHaveBeenCalledWith("Spawn failed: Spawning is disabled");
  });

  it("lists spawned agents", async () => {
    const repository = new CommandRepository();
    const context = makeContext();
    context.harness.listSpawns = vi.fn(() => [
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

    expect(context.notify).toHaveBeenCalledWith(expect.stringContaining("[DONE] spawn-1 (coder)"));
  });

  it("joins a spawned agent and shows its result", async () => {
    const repository = new CommandRepository();
    const context = makeContext();
    context.harness.waitSpawn = vi.fn(async () => ({
      spawnId: "spawn-1",
      sessionId: "session-1",
      agentId: "coder",
      prompt: "task",
      status: "done" as const,
      startedAt: "2024-01-01T00:00:00.000Z",
      result: "the result",
    }));

    await repository.run("/join spawn-1", context);

    expect(context.notify).toHaveBeenCalledWith(expect.stringContaining("the result"));
  });

  it("reports unknown spawn ids on join", async () => {
    const repository = new CommandRepository();
    const context = makeContext();

    await repository.run("/join nope", context);

    expect(context.notify).toHaveBeenCalledWith("Unknown spawn: nope");
  });

  it("lists skills with their ids, names and origin", () => {
    const context = makeContext();

    new CommandRepository().find("skills")?.run(context, []);

    expect(context.notify).toHaveBeenCalledWith("- deploy (Deploy) [ops]: How to ship a release.");
  });

  it("reports when there are no skills", () => {
    const context = makeContext();
    vi.mocked(context.harness.listSkills).mockReturnValueOnce([]);

    new CommandRepository().find("skills")?.run(context, []);

    expect(context.notify).toHaveBeenCalledWith("No skills available");
  });

  it("shows one skill without calling the model", () => {
    const context = makeContext();

    new CommandRepository().find("skill")?.run(context, ["deploy"]);

    expect(context.notify).toHaveBeenCalledWith(
      "# Deploy (deploy)\nHow to ship a release.\nsource: /skills/deploy/SKILL.md\ntags: ops",
    );
    expect(context.harness.ask).not.toHaveBeenCalled();
  });

  it("rejects an unknown skill", () => {
    const context = makeContext();

    new CommandRepository().find("skill")?.run(context, ["nope"]);

    expect(context.notify).toHaveBeenCalledWith("Unknown skill: nope");
  });

  it("reloads skills and reports the new count", () => {
    const context = makeContext();

    new CommandRepository().find("skill")?.run(context, ["reload"]);

    expect(context.harness.reloadSkills).toHaveBeenCalled();
    expect(context.notify).toHaveBeenCalledWith(
      "Skills reloaded (1)\n- deploy (Deploy) [ops]: How to ship a release.",
    );
  });

  it("explains the skill usage when called with no arguments", () => {
    const context = makeContext();

    new CommandRepository().find("skill")?.run(context, []);

    expect(context.notify).toHaveBeenCalledWith("Usage: /skill <id> | /skill reload");
  });
});
