import type { IHarness, SpawnHandle } from "@racso/core";
import type { Flows } from "@/flows";
import {
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
    description: "Switch the active provider",
    run: async (context) => {
      const changed = await context.flows.changeProvider(context.harness);
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
      context.notify(
        changed ? `Agent updated to ${name}` : `Agent not changed: ${name}`,
      );
    },
  },
  {
    name: "sessions",
    aliases: ["session"],
    description: "List persisted sessions",
    run: (context) => {
      const current = context.harness.status().sessionId;
      context.notify(
        formatSessionList(context.harness.listSessions(), current),
      );
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

      context.notify(
        `Session resumed\n${formatSessionStatus(context.harness.status())}`,
      );
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
    name: "status",
    description: "Show session usage, cost and context",
    run: (context) =>
      context.notify(formatSessionStatus(context.harness.status())),
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
        context.notify(
          `Spawned ${handle.spawnId} (agent ${handle.agentId})`,
        );
      } catch (err) {
        context.notify(
          `Spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        );
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

const truncate = (text: string, max = 100) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

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
