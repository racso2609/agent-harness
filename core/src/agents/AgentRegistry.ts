import type { AgentDefinition, AgentSummary } from "./AgentDefinition";
import { DEFAULT_AGENT_ID } from "./defaults";

class AgentRegistry {
  protected agents = new Map<string, AgentDefinition>();

  constructor(agents: AgentDefinition[] = []) {
    for (const agent of agents) this.register(agent);
  }

  // Registers (or replaces) an agent, normalizing its id.
  register(agent: AgentDefinition) {
    const id = agent.id.trim().toLowerCase();
    if (!id) throw new Error("Agent id is required");

    this.agents.set(id, { ...agent, id });
  }

  get(id?: string) {
    if (!id) return undefined;
    return this.agents.get(id.trim().toLowerCase());
  }

  has(id: string) {
    return Boolean(this.get(id));
  }

  list(): AgentDefinition[] {
    return [...this.agents.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  summaries(): AgentSummary[] {
    return this.list().map(({ id, name, description }) => ({
      id,
      name,
      description,
    }));
  }

  // Resolves an id, falling back to the embedded default agent.
  resolve(id?: string): AgentDefinition | undefined {
    return this.get(id) ?? this.get(DEFAULT_AGENT_ID) ?? this.list()[0];
  }
}

export { AgentRegistry };
