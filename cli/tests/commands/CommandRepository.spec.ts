import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Config } from "@racso2609/core";
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
    cancelSpawn: vi.fn(() => true),
    waitSpawn: vi.fn(async () => undefined),
    collectSpawns: vi.fn(async () => []),
    compactSession: vi.fn(async () => true),
    memoryStatus: vi.fn(async () => ({
      provider: "local",
      ok: true,
      project: "racso2609/agent-harness",
      projectSource: "git",
    })),
    searchMemory: vi.fn(async () => []),
    listMemories: vi.fn(async () => []),
    forgetMemory: vi.fn(async () => true),
    listMcpServers: vi.fn(() => []),
    reloadMcp: vi.fn(async () => []),
    mcpTools: vi.fn(() => []),
    shutdown: vi.fn(),
  } as unknown as CommandContext["harness"],
  flows: {
    ui: {
      select: vi.fn(async () => undefined),
    } as unknown as CommandContext["flows"]["ui"],
    changeProvider: vi.fn(async () => true),
    addProvider: vi.fn(async () => true),
    removeProvider: vi.fn(async () => true),
    changeModel: vi.fn(async () => true),
    changeAgent: vi.fn(async () => true),
    changeSession: vi.fn(async () => true),
  },
  config: tempConfig(),
  exit: vi.fn(),
  clear: vi.fn(),
  notify: vi.fn(),
  help: () => "/help — List available commands",
});

let dir: string;

const configPath = () => path.join(dir, "config.json");

// Config reads RACSO_HARNESS_CONFIG_LOCATION once, at import time, so the env
// var alone does not reach it here: the location is pointed at the temp dir on
// the instance, which is what writeConfig() uses.
const tempConfig = () => {
  const config = new Config();
  config.configLocation = configPath();
  return config;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "racso-cli-memory-"));
  vi.stubEnv("RACSO_HARNESS_CONFIG_LOCATION", configPath());
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
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
      "memory",
      "mcp",
      "status",
      "spawn",
      "children",
      "stop",
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

  const liveSpawn = (spawnId: string, agentId: string, prompt: string) => ({
    spawnId,
    sessionId: "session-1",
    agentId,
    prompt,
    status: "running" as const,
    startedAt: "2024-01-01T00:00:00.000Z",
  });

  it("offers every running child in a picker when there are several", async () => {
    const repository = new CommandRepository();
    const context = makeContext();
    context.harness.listSpawns = vi.fn(() => [
      liveSpawn("spawn-1", "coder", "write\nthe   docs"),
      liveSpawn("spawn-2", "reviewer", "review it"),
      // A settled child cannot be stopped, so it is not offered.
      { ...liveSpawn("spawn-3", "coder", "old task"), status: "done" as const },
    ]);
    context.flows.ui.select = vi.fn(async () => "spawn-2");

    await repository.run("/stop", context);

    expect(context.flows.ui.select).toHaveBeenCalledWith({
      message: "Select the agent to stop:",
      options: [
        { id: "spawn-1", label: "spawn-1 · coder · write the docs" },
        { id: "spawn-2", label: "spawn-2 · reviewer · review it" },
      ],
    });
    expect(context.harness.cancelSpawn).toHaveBeenCalledWith("spawn-2");
    expect(context.notify).toHaveBeenCalledWith("Stopping spawn-2");
  });

  it("stops the only running child without asking", async () => {
    const repository = new CommandRepository();
    const context = makeContext();
    context.harness.listSpawns = vi.fn(() => [liveSpawn("spawn-1", "coder", "task")]);

    await repository.run("/stop", context);

    expect(context.flows.ui.select).not.toHaveBeenCalled();
    expect(context.harness.cancelSpawn).toHaveBeenCalledWith("spawn-1");
    expect(context.notify).toHaveBeenCalledWith("Stopping spawn-1");
  });

  it("stops the child named as an argument without asking", async () => {
    const repository = new CommandRepository();
    const context = makeContext();
    context.harness.listSpawns = vi.fn(() => [
      liveSpawn("spawn-1", "coder", "task"),
      liveSpawn("spawn-2", "coder", "other task"),
    ]);

    await repository.run("/stop spawn-2", context);

    expect(context.flows.ui.select).not.toHaveBeenCalled();
    expect(context.harness.cancelSpawn).toHaveBeenCalledWith("spawn-2");
  });

  it("does not claim a child was stopped when the cancel was not delivered", async () => {
    const repository = new CommandRepository();
    const context = makeContext();
    context.harness.cancelSpawn = vi.fn(() => false);

    await repository.run("/stop nope", context);

    expect(context.notify).toHaveBeenCalledWith("Unknown or already finished child: nope");
  });

  it("reports when there is nothing running to stop", async () => {
    const repository = new CommandRepository();
    const context = makeContext();

    await repository.run("/stop", context);

    expect(context.flows.ui.select).not.toHaveBeenCalled();
    expect(context.harness.cancelSpawn).not.toHaveBeenCalled();
    expect(context.notify).toHaveBeenCalledWith("No running spawned agents to stop");
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

  it("reports a down memory backend without throwing", async () => {
    const context = makeContext();
    // Pinned: must not depend on this machine's config.json.
    context.config.config.memory = { enabled: false };
    vi.mocked(context.harness.memoryStatus).mockResolvedValueOnce({
      provider: "http",
      ok: false,
      detail: "ECONNREFUSED",
    });

    await expect(new CommandRepository().find("memory")?.run(context, [])).resolves.toBeUndefined();
    expect(context.notify).toHaveBeenCalledWith(
      "Memory: http (down)\nDetail: ECONNREFUSED\nEnabled: off",
    );
  });

  it("reports an up memory backend with its project", async () => {
    const context = makeContext();
    // Pinned: must not depend on this machine's config.json.
    context.config.config.memory = { enabled: false };

    await new CommandRepository().find("memory")?.run(context, []);

    expect(context.notify).toHaveBeenCalledWith(
      "Memory: local (ok)\nProject: racso2609/agent-harness (git)\nEnabled: off",
    );
  });

  it("searches memory without calling the model or opening a turn", async () => {
    const context = makeContext();
    const askCalls = vi.mocked(context.harness.ask).mock.calls.length;
    const statusCalls = vi.mocked(context.harness.status).mock.calls.length;

    await new CommandRepository().run("/memory search deploy", context);

    expect(context.harness.searchMemory).toHaveBeenCalledWith("deploy");
    // A turn would call the model and re-read the session status; neither may
    // happen, which is what "no history entry" means from the CLI side.
    expect(context.harness.ask).toHaveBeenCalledTimes(askCalls);
    expect(vi.mocked(context.harness.status).mock.calls.length).toBe(statusCalls);
    expect(context.notify).toHaveBeenCalledWith('No memories found for: "deploy"');
  });

  it("formats the memory hits one bullet per hit", async () => {
    const context = makeContext();
    vi.mocked(context.harness.searchMemory).mockResolvedValueOnce([
      {
        id: "mem-1",
        kind: "decision",
        scope: "project",
        title: "Deploy flow",
        content: "Releases go through the tag pipeline.",
      },
    ]);

    await new CommandRepository().run("/memory search deploy", context);

    expect(context.notify).toHaveBeenCalledWith(
      "- [decision] **Deploy flow**: Releases go through the tag pipeline.",
    );
  });

  it("explains the memory search usage when called with no query", async () => {
    const context = makeContext();

    await new CommandRepository().run("/memory search", context);

    expect(context.notify).toHaveBeenCalledWith("Usage: /memory search <query>");
    expect(context.harness.searchMemory).not.toHaveBeenCalled();
  });

  it("turns memory off and persists it to the config file", async () => {
    const context = makeContext();
    context.config = tempConfig();

    await new CommandRepository().run("/memory off", context);

    expect(context.config.config.memory.enabled).toBe(false);
    const written = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    expect(written.memory.enabled).toBe(false);
    expect(context.notify).toHaveBeenCalledWith("Memory off (takes effect on the next session)");
  });

  it("turns memory on and persists it to the config file", async () => {
    const context = makeContext();
    context.config = tempConfig();

    await new CommandRepository().run("/memory on", context);

    expect(context.config.config.memory.enabled).toBe(true);
    const written = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    expect(written.memory.enabled).toBe(true);
    expect(context.notify).toHaveBeenCalledWith("Memory on (takes effect on the next session)");
  });

  it("explains the memory usage for an unknown action", async () => {
    const context = makeContext();

    await new CommandRepository().run("/memory nope", context);

    expect(context.notify).toHaveBeenCalledWith(
      "Usage: /memory | /memory search <query> | /memory recent [n] | /memory forget <id> | /memory on|off",
    );
  });

  it("lists the most recent memories with the requested limit", async () => {
    const context = makeContext();
    vi.mocked(context.harness.listMemories).mockResolvedValueOnce([
      {
        id: "12",
        kind: "decision",
        scope: "project",
        title: "Deploy flow",
        content: "Releases go through the tag pipeline.",
      },
    ]);

    await new CommandRepository().run("/memory recent 5", context);

    expect(context.harness.listMemories).toHaveBeenCalledWith(5);
    expect(context.notify).toHaveBeenCalledWith("12 [decision] Deploy flow");
  });

  it("leaves the limit to the contract when /memory recent has no argument", async () => {
    const context = makeContext();

    await new CommandRepository().run("/memory recent", context);

    expect(context.harness.listMemories).toHaveBeenCalledWith(undefined);
    expect(context.notify).toHaveBeenCalledWith("No memories stored yet.");
  });

  it("explains the recent usage for a limit that is not a number", async () => {
    const context = makeContext();

    await new CommandRepository().run("/memory recent lots", context);

    expect(context.harness.listMemories).not.toHaveBeenCalled();
    expect(context.notify).toHaveBeenCalledWith("Usage: /memory recent [n]");
  });

  it("forgets a memory by id without calling the model", async () => {
    const context = makeContext();

    await new CommandRepository().run("/memory forget 12", context);

    expect(context.harness.forgetMemory).toHaveBeenCalledWith("12");
    expect(context.notify).toHaveBeenCalledWith("Forgot memory 12.");
    expect(context.harness.ask).not.toHaveBeenCalled();
  });

  it("reports an id that was not forgotten", async () => {
    const context = makeContext();
    vi.mocked(context.harness.forgetMemory).mockResolvedValueOnce(false);

    await new CommandRepository().run("/memory forget 99", context);

    expect(context.notify).toHaveBeenCalledWith(expect.stringContaining("was not forgotten"));
  });

  it("explains the forget usage when the id is missing", async () => {
    const context = makeContext();

    await new CommandRepository().run("/memory forget", context);

    expect(context.harness.forgetMemory).not.toHaveBeenCalled();
    expect(context.notify).toHaveBeenCalledWith("Usage: /memory forget <id>");
  });
});
