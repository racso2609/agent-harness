import { describe, expect, it } from "vitest";
import { parseAgentFile, parseFrontmatter } from "../../src/agents/parseAgentFile";

describe("parseFrontmatter", () => {
  it("returns the whole text as body when no frontmatter is present", () => {
    const { data, body } = parseFrontmatter("You are an agent.");

    expect(data).toEqual({});
    expect(body).toBe("You are an agent.");
  });

  it("parses key values, inline lists and bullet lists", () => {
    const raw = [
      "---",
      "name: Reviewer",
      "tools: [readFile, listDir]",
      "model: gpt",
      "---",
      "body",
    ].join("\n");

    const { data, errors } = parseFrontmatter(raw);

    expect(errors).toEqual([]);
    expect(data.name).toBe("Reviewer");
    expect(data.tools).toEqual(["readFile", "listDir"]);
    expect(data.model).toBe("gpt");
  });

  it("supports multi-line bullet lists", () => {
    const raw = ["---", "tools:", "  - readFile", "  - listDir", "---", "x"].join("\n");

    const { data } = parseFrontmatter(raw);

    expect(data.tools).toEqual(["readFile", "listDir"]);
  });

  it("flags an unclosed frontmatter block", () => {
    const { errors } = parseFrontmatter("---\nname: x");

    expect(errors).toContain("Unclosed frontmatter block");
  });
});

describe("parseAgentFile", () => {
  it("builds a definition from frontmatter and body", () => {
    const raw = [
      "---",
      "name: Reviewer",
      "description: Reviews code",
      "provider: openai",
      "model: gpt",
      "tools: [readFile]",
      "approval: deny",
      "maxIterations: 3",
      "---",
      "You review code.",
    ].join("\n");

    const { definition, errors } = parseAgentFile(raw, "reviewer");

    expect(errors).toEqual([]);
    expect(definition).toEqual({
      id: "reviewer",
      name: "Reviewer",
      description: "Reviews code",
      personality: "You review code.",
      provider: "openai",
      model: "gpt",
      tools: ["readFile"],
      approval: "deny",
      maxIterations: 3,
    });
  });

  it("defaults the name to the file id", () => {
    const { definition } = parseAgentFile("Persona body", "helper");

    expect(definition?.id).toBe("helper");
    expect(definition?.name).toBe("helper");
  });

  it("rejects an empty body", () => {
    const { definition, errors } = parseAgentFile("---\nname: x\n---", "x");

    expect(definition).toBeUndefined();
    expect(errors).toContain("Agent personality (markdown body) is empty");
  });

  it("rejects invalid approval and maxIterations", () => {
    const raw = ["---", "approval: sometimes", "maxIterations: 0", "---", "body"].join("\n");

    const { definition, errors } = parseAgentFile(raw, "x");

    expect(definition).toBeUndefined();
    expect(errors.some((error) => error.includes("approval"))).toBe(true);
    expect(errors.some((error) => error.includes("maxIterations"))).toBe(true);
  });
});
