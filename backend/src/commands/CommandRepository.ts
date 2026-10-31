import type { AgentSummary } from "@/agents";
import type { SessionStatus } from "@/types/session";
import { formatSessionStatus } from "@/utils/status";

export interface CommandOption {
  name: string;
  description: string;
  aliases?: string[];
}

export interface CommandSession {
  changeProvider: (name?: string) => Promise<boolean>;
  changeModel: (model?: string) => Promise<boolean>;
  changeAgent: (name?: string) => Promise<boolean>;
  listAgents: () => AgentSummary[];
  compactSession: () => Promise<boolean>;
  status: () => SessionStatus;
}

export interface CommandContext {
  session: CommandSession;
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
      const changed = await context.session.changeModel();
      context.notify(changed ? "Model updated" : "Model not changed");
    },
  },
  {
    name: "provider",
    description: "Switch the active provider",
    run: async (context) => {
      const changed = await context.session.changeProvider();
      context.notify(changed ? "Provider updated" : "Provider not changed");
    },
  },
  {
    name: "agent",
    description: "List agents or switch the active one",
    run: async (context, args) => {
      const [name] = args;
      if (!name) {
        const current = context.session.status().agent;
        const lines = context.session.listAgents().map((agent) => {
          const marker = agent.id === current ? "*" : " ";
          const description = agent.description ? ` — ${agent.description}` : "";
          return `${marker} ${agent.id} (${agent.name})${description}`;
        });
        context.notify(lines.join("\n") || "No agents available");
        return;
      }

      const changed = await context.session.changeAgent(name);
      context.notify(
        changed ? `Agent updated to ${name}` : `Agent not changed: ${name}`,
      );
    },
  },
  {
    name: "compact",
    description: "Compact the conversation history",
    run: async (context) => {
      const compacted = await context.session.compactSession();
      context.notify(compacted ? "Session compacted" : "Nothing to compact");
    },
  },
  {
    name: "status",
    description: "Show session usage, cost and context",
    run: (context) =>
      context.notify(formatSessionStatus(context.session.status())),
  },
];

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
