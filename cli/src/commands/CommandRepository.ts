import type {
  Config,
  IHarness,
  McpServerSummary,
  McpToolSummary,
  SkillSummary,
  SpawnHandle,
} from "@racso2609/core";
import type { Flows } from "@/flows";
import {
  formatMemoryForget,
  formatMemoryHits,
  formatMemoryRecent,
  formatMemoryStatus,
  formatSessionList,
  formatSessionStatus,
} from "@/render/status";

export interface CommandOption {
  name: string;
  description: string;
  aliases?: string[];
}

export interface CommandContext {
  harness: IHarness;
  flows: Flows;
  // Needed by commands that persist a setting, such as /memory on|off.
  config: Config;
  // Whether config.mcp.enabled is on. `/mcp` needs it to explain an empty
  // listing: with MCP off the servers are not even resolved, so the reason
  // is the switch and not a broken definition. Undefined means not asked.
  mcpEnabled?: boolean;
  exit: () => void;
  clear: () => void;
  notify: (message: string) => void;
  help: () => string;
}

export interface CommandDefinition extends CommandOption {
  run: (context: CommandContext, args: string[]) => void | Promise<void>;
}

const BUILT_IN_COMMANDS: CommandDefinition[] = [
  {
    name: "help",
    aliases: ["?"],
    description: "List available commands",
    run: (context) => context.notify(context.help()),
  },
  {
    name: "exit",
    aliases: ["quit"],
    description: "Exit the session",
    run: (context) => context.exit(),
  },
  {
    name: "clear",
    description: "Clear the screen",
    run: (context) => context.clear(),
  },
  {
    name: "model",
    description: "Switch the active model",
    run: async (context) => {
      const changed = await context.flows.changeModel(context.harness);
      context.notify(changed ? "Model updated" : "Model not changed");
    },
  },
  {
    name: "provider",
    aliases: ["providers"],
    description: "List, switch, add or remove providers: /provider [add|rm|ls] [id]",
    run: async (context, args) => {
      const [action, id] = args;

      if (!action) {
        const changed = await context.flows.changeProvider(context.harness);
        context.notify(changed ? "Provider updated" : "Provider not changed");
        return;
      }

      if (action === "ls" || action === "list") {
        context.notify(formatProviderList(context));
        return;
      }

      if (action === "add") {
        try {
          const created = await context.flows.addProvider(context.harness);
          context.notify(created ? "Provider added" : "Provider not added");
        } catch (err) {
          context.notify(`Provider not added: ${errorMessage(err)}`);
        }
        return;
      }

      if (action === "rm" || action === "remove") {
        try {
          const removed = await context.flows.removeProvider(context.harness, id);
          context.notify(removed ? "Provider removed" : "Provider not removed");
        } catch (err) {
          context.notify(`Provider not removed: ${errorMessage(err)}`);
        }
        return;
      }

      // Anything else is treated as a provider id and switched to directly.
      const changed = await context.flows.changeProvider(context.harness, action);
      context.notify(changed ? "Provider updated" : "Provider not changed");
    },
  },
  {
    name: "agent",
    description: "List agents or switch the active one",
    run: async (context, args) => {
      const [name] = args;
      if (!name) {
        const current = context.harness.status().agent;
        const lines = context.harness.listAgents().map((agent) => {
          const marker = agent.id === current ? "*" : " ";
          const description = agent.description ? ` — ${agent.description}` : "";
          return `${marker} ${agent.id} (${agent.name})${description}`;
        });
        context.notify(lines.join("\n") || "No agents available");
        return;
      }

      const changed = await context.flows.changeAgent(context.harness, name);
      context.notify(changed ? `Agent updated to ${name}` : `Agent not changed: ${name}`);
    },
  },
  {
    name: "sessions",
    aliases: ["session"],
    description: "List persisted sessions",
    run: (context) => {
      const current = context.harness.status().sessionId;
      context.notify(formatSessionList(context.harness.listSessions(), current));
    },
  },
  {
    name: "resume",
    aliases: ["switch"],
    description: "Switch to a persisted session by id or index",
    run: async (context, args) => {
      const [target] = args;
      const changed = await context.flows.changeSession(context.harness, target);
      if (!changed) {
        context.notify(`Session not changed: ${target ?? "canceled"}`);
        return;
      }

      context.notify(`Session resumed\n${formatSessionStatus(context.harness.status())}`);
    },
  },
  {
    name: "compact",
    description: "Compact the conversation history",
    run: async (context) => {
      const compacted = await context.harness.compactSession();
      context.notify(compacted ? "Session compacted" : "Nothing to compact");
    },
  },
  {
    name: "skills",
    description: "List the available skills",
    run: (context) => {
      context.notify(formatSkillList(context.harness.listSkills()));
    },
  },
  {
    name: "skill",
    description: "Inspect a skill (no model call) or reload: /skill <id> | reload",
    run: (context, args) => {
      const [target] = args;

      if (!target) {
        context.notify("Usage: /skill <id> | /skill reload");
        return;
      }

      if (target === "reload") {
        const skills = context.harness.reloadSkills();
        context.notify(`Skills reloaded (${skills.length})\n${formatSkillList(skills)}`);
        return;
      }

      // Reads the registry directly: no model call and no history entry,
      // which makes it useful when debugging a skill definition.
      const skill = context.harness.listSkills().find((entry) => entry.id === target.toLowerCase());
      if (!skill) {
        context.notify(`Unknown skill: ${target}`);
        return;
      }

      context.notify(formatSkill(skill));
    },
  },
  {
    name: "memory",
    description: "Memory backend: /memory | search <q> | recent [n] | forget <id> | on | off",
    run: async (context, args) => {
      const [action, ...rest] = args;

      if (!action) {
        // Reporting a down backend is the point of this command, so it never throws.
        const status = await context.harness.memoryStatus();
        const enabled = context.config.config.memory?.enabled ? "on" : "off";
        context.notify(`${formatMemoryStatus(status)}\nEnabled: ${enabled}`);
        return;
      }

      if (action === "search") {
        const query = rest.join(" ").trim();
        if (!query) {
          context.notify("Usage: /memory search <query>");
          return;
        }

        // Reads the provider directly: no model call and no history entry, the same
        // criterion as /skill <id>.
        const hits = await context.harness.searchMemory(query);
        context.notify(formatMemoryHits(hits, query));
        return;
      }

      if (action === "on" || action === "off") {
        const enabled = action === "on";
        context.config.config.memory ??= {};
        context.config.config.memory.enabled = enabled;
        context.config.writeConfig();

        // The active session keeps the provider it booted with, so saying so is
        // cheaper than pretending the switch already took effect.
        context.notify(`Memory ${action} (takes effect on the next session)`);
        return;
      }

      if (action === "recent") {
        // No limit means the contract default: passing undefined through would
        // be the same thing, but leaving the argument out says so.
        const raw = rest[0];
        const limit = raw === undefined ? undefined : Number(raw);
        if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
          context.notify("Usage: /memory recent [n]");
          return;
        }

        const hits = await context.harness.listMemories(limit);
        context.notify(formatMemoryRecent(hits, limit));
        return;
      }

      if (action === "forget") {
        const [id] = rest;
        if (!id) {
          context.notify("Usage: /memory forget <id>");
          return;
        }

        const forgotten = await context.harness.forgetMemory(id);
        context.notify(formatMemoryForget(id, forgotten));
        return;
      }

      context.notify(
        "Usage: /memory | /memory search <query> | /memory recent [n] | /memory forget <id> | /memory on|off",
      );
    },
  },
  {
    name: "mcp",
    description: "List the MCP servers, or reload them: /mcp [reload]",
    run: async (context, args) => {
      const [action] = args;

      if (!action) {
        context.notify(formatMcpServers(context));
        return;
      }

      if (action !== "reload") {
        context.notify("Usage: /mcp | /mcp reload");
        return;
      }

      let servers: McpServerSummary[];
      try {
        servers = await context.harness.reloadMcp();
      } catch (err) {
        context.notify(`MCP not reloaded: ${errorMessage(err)}`);
        return;
      }

      context.notify(`MCP reloaded\n${formatMcpServers(context, servers)}`);
    },
  },
  {
    name: "status",
    description: "Show session usage, cost and context",
    run: (context) => context.notify(formatSessionStatus(context.harness.status())),
  },
  {
    name: "spawn",
    description: "Launch a background agent: /spawn <agent> <prompt>",
    run: (context, args) => {
      const [agent, ...rest] = args;
      const prompt = rest.join(" ").trim();
      if (!agent || !prompt) {
        context.notify("Usage: /spawn <agent> <prompt>");
        return;
      }

      try {
        const handle = context.harness.spawn(agent, prompt);
        context.notify(`Spawned ${handle.spawnId} (agent ${handle.agentId})`);
      } catch (err) {
        context.notify(`Spawn failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  },
  {
    name: "children",
    description: "List spawned background agents",
    run: (context) => {
      const spawns = context.harness.listSpawns();
      context.notify(formatSpawnList(spawns));
    },
  },
  {
    name: "join",
    description: "Wait for a spawned agent and show its result",
    run: async (context, args) => {
      const [spawnId] = args;
      if (!spawnId) {
        context.notify("Usage: /join <spawnId>");
        return;
      }

      const handle = await context.harness.waitSpawn(spawnId);
      if (!handle) {
        context.notify(`Unknown spawn: ${spawnId}`);
        return;
      }

      context.notify(formatSpawnResult(handle));
    },
  },
];

const formatSkill = (skill: SkillSummary) =>
  [
    `# ${skill.name} (${skill.id})`,
    skill.description,
    skill.source ? `source: ${skill.source}` : undefined,
    (skill.tags ?? []).length ? `tags: ${skill.tags?.join(", ")}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");

const formatSkillList = (skills: SkillSummary[]) =>
  skills.length
    ? skills
        .map((skill) => {
          const tags = (skill.tags ?? []).length ? ` [${skill.tags?.join(", ")}]` : "";
          return `- ${skill.id} (${skill.name})${tags}: ${skill.description}`;
        })
        .join("\n")
    : "No skills available";

// Explains an empty listing: with the switch off no server is even resolved,
// so the message names the switch instead of leaving the user with an empty
// list. Both ways to turn MCP off are named, because the environment one
// overrides the config.
const MCP_DISABLED_NOTICE =
  "MCP is disabled: set mcp.enabled to true in the config " +
  "(RACSO_HARNESS_MCP_DISABLED also switches it off, whatever the config says)";

// One line per server (id, transport, status, tool count, and the error of a
// failed one), with the tools underneath. `servers` defaults to the session
// listing, which never connects: `idle` means nothing tried yet.
const formatMcpServers = (context: CommandContext, servers?: McpServerSummary[]) => {
  if (context.mcpEnabled === false) return MCP_DISABLED_NOTICE;

  const list = servers ?? context.harness.listMcpServers();
  if (!list.length) return "No MCP servers configured";

  const lines = list.map((server) => {
    const count = `${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`;
    const error = server.error ? ` - ${truncate(server.error, 200)}` : "";
    return `- ${server.id} [${server.transport}] ${server.status}, ${count}${error}`;
  });

  for (const [serverId, tools] of groupMcpTools(context.harness.mcpTools())) {
    lines.push(`    ${serverId}:`);
    for (const tool of tools) {
      lines.push(`        ${tool.name} - ${truncate(tool.description, 120)}`);
    }
  }

  return lines.join("\n");
};

// Tools grouped by server, preserving the order the manager reported them in.
const groupMcpTools = (tools: McpToolSummary[]) => {
  const groups = new Map<string, McpToolSummary[]>();
  for (const tool of tools) {
    const group = groups.get(tool.serverId) ?? [];
    group.push(tool);
    groups.set(tool.serverId, group);
  }

  return groups;
};

const truncate = (text: string, max = 100) => (text.length > max ? `${text.slice(0, max)}…` : text);

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

// One line per provider instance, marking the default and the active one.
const formatProviderList = (context: CommandContext) => {
  const details = context.harness.listProviderDetails();
  if (!details.length) return "No providers configured";

  const current = context.harness.status().provider;

  return details
    .map((provider) => {
      const markers = [
        provider.isDefault ? "default" : "",
        provider.id === current ? "active" : "",
      ].filter(Boolean);
      const suffix = markers.length ? ` [${markers.join(", ")}]` : "";
      const model = provider.model ? ` — ${provider.model}` : "";

      return `${provider.id} (${provider.type}) ${provider.url}${model}${suffix}`;
    })
    .join("\n");
};

const formatSpawnList = (spawns: SpawnHandle[]) => {
  if (!spawns.length) return "No spawned agents";

  return spawns
    .map((spawn) => {
      const label = spawn.status.toUpperCase();
      const detail = spawn.status === "error" ? spawn.error : spawn.result;
      const suffix = detail ? ` — ${truncate(detail)}` : "";
      return `[${label}] ${spawn.spawnId} (${spawn.agentId})${suffix}`;
    })
    .join("\n");
};

const formatSpawnResult = (spawn: SpawnHandle) => {
  if (spawn.status === "error") {
    return `${spawn.spawnId} failed: ${spawn.error ?? "unknown error"}`;
  }
  return `${spawn.spawnId} ${spawn.status}:\n${spawn.result ?? "(no output)"}`;
};

class CommandRepository {
  protected commands: CommandDefinition[];

  constructor(commands: CommandDefinition[] = BUILT_IN_COMMANDS) {
    this.commands = commands;
  }

  // Commands exposed to the input menu, without their handlers.
  list(): CommandOption[] {
    return this.commands.map(({ name, description, aliases }) => ({
      name,
      description,
      aliases,
    }));
  }

  // Resolves a command by name or alias, case-insensitively.
  find(name: string): CommandDefinition | undefined {
    const needle = name.toLowerCase();
    return this.commands.find((command) =>
      [command.name, ...(command.aliases ?? [])].some(
        (candidate) => candidate.toLowerCase() === needle,
      ),
    );
  }

  // Runs a slash command. Returns false when the command is unknown.
  async run(input: string, context: CommandContext): Promise<boolean> {
    const [name, ...args] = input.trim().replace(/^\//, "").split(/\s+/);
    if (!name) return false;

    const command = this.find(name);
    if (!command) return false;

    await command.run(context, args);
    return true;
  }

  // Human-readable command list used by /help.
  helpText(): string {
    return this.commands
      .map((command) => {
        const aliases = command.aliases?.length
          ? ` (${command.aliases.map((alias) => `/${alias}`).join(", ")})`
          : "";
        return `/${command.name}${aliases} — ${command.description}`;
      })
      .join("\n");
  }
}

export { CommandRepository };
