import { describe, expect, it } from "vitest";
import { AgentRegistry } from "../../src/agents/AgentRegistry";
import {
  builtInDefaultAgent,
  composeSystemPrompt,
  strictestApproval,
} from "../../src/agents/defaults";

const agent = (id: string, name = id) => ({
  id,
  name,
  personality: `persona-${id}`,
});

describe("AgentRegistry", () => {
  it("normalizes ids to lowercase", () => {
    const registry = new AgentRegistry([agent("Reviewer")]);

    expect(registry.get("reviewer")?.id).toBe("reviewer");
    expect(registry.has("REVIEWER")).toBe(true);
  });

  it("lists agents sorted by id", () => {
    const registry = new AgentRegistry([agent("zeta"), agent("alpha")]);

    expect(registry.list().map((entry) => entry.id)).toEqual(["alpha", "zeta"]);
  });

  it("resolves the fallback default agent", () => {
    const registry = new AgentRegistry([builtInDefaultAgent()]);

    expect(registry.resolve("missing")?.id).toBe("default");
  });

  it("exposes summaries without the personality", () => {
    const registry = new AgentRegistry([agent("reviewer", "Reviewer")]);
    const [summary] = registry.summaries();

    expect(summary).toEqual({ id: "reviewer", name: "Reviewer", description: undefined });
    expect(summary).not.toHaveProperty("personality");
  });
});

describe("agent helpers", () => {
  it("composes the system prompt from harness rules and persona", () => {
    const prompt = composeSystemPrompt({
      id: "x",
      name: "X",
      personality: "Be terse.",
    });

    expect(prompt).toContain("terminal agent harness");
    expect(prompt).toContain("Be terse.");
  });

  it("keeps the strictest approval policy", () => {
    expect(strictestApproval("auto", "deny")).toBe("deny");
    expect(strictestApproval("ask", "auto")).toBe("ask");
    expect(strictestApproval("deny", "ask")).toBe("deny");
  });
});
