import type { AgentApproval, AgentDefinition } from "./AgentDefinition";

export interface ParsedAgentFile {
  definition?: AgentDefinition;
  errors: string[];
}

type FrontmatterValue = string | string[];
type Frontmatter = Record<string, FrontmatterValue>;

const APPROVALS: AgentApproval[] = ["auto", "ask", "deny"];
const DELIMITER = "---";

const unquote = (value: string) => {
  const trimmed = value.trim();
  const match = trimmed.match(/^(['"])([\s\S]*)\1$/);
  return match ? match[2] : trimmed;
};

const parseValue = (value: string): FrontmatterValue => {
  const trimmed = value.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => unquote(item))
      .filter(Boolean);
  }

  return unquote(trimmed);
};

// Minimal frontmatter parser: key: value, inline lists and "- item" lists.
// Kept dependency-free on purpose; enough for agent definitions.
const parseFrontmatter = (raw: string): { data: Frontmatter; body: string; errors: string[] } => {
  const text = raw.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);

  if ((lines[0] ?? "").trim() !== DELIMITER) {
    return { data: {}, body: text, errors: [] };
  }

  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === DELIMITER);
  if (closing === -1) {
    return {
      data: {},
      body: "",
      errors: ["Unclosed frontmatter block"],
    };
  }

  const data: Frontmatter = {};
  const errors: string[] = [];
  let currentListKey: string | undefined;

  for (const line of lines.slice(1, closing)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const item = trimmed.match(/^-\s+(.+)$/);
    if (item) {
      if (!currentListKey) {
        errors.push(`List item without a key: ${trimmed}`);
        continue;
      }

      const current = data[currentListKey];
      if (!Array.isArray(current)) data[currentListKey] = [];
      (data[currentListKey] as string[]).push(unquote(item[1]));
      continue;
    }

    const entry = trimmed.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!entry) {
      errors.push(`Invalid frontmatter line: ${trimmed}`);
      continue;
    }

    const [, key, value] = entry;
    const parsed = parseValue(value);
    data[key] = parsed;
    currentListKey = parsed === "" ? key : undefined;
  }

  return {
    data,
    body: lines.slice(closing + 1).join("\n"),
    errors,
  };
};

const parseAgentFile = (raw: string, fallbackId: string): ParsedAgentFile => {
  const { data, body, errors } = parseFrontmatter(raw);
  const id = (fallbackId.trim() || "agent").toLowerCase();

  const personality = body.trim();
  if (!personality) errors.push("Agent personality (markdown body) is empty");

  const provider = data.provider;
  if (provider !== undefined && typeof provider !== "string") {
    errors.push("provider must be a string");
  }

  const model = data.model;
  if (model !== undefined && typeof model !== "string") {
    errors.push("model must be a string");
  }

  let tools: string[] | undefined;
  if (data.tools !== undefined) {
    if (!Array.isArray(data.tools)) {
      errors.push("tools must be a list");
    } else {
      tools = data.tools.filter(Boolean);
    }
  }

  let approval: AgentApproval | undefined;
  if (data.approval !== undefined) {
    if (typeof data.approval !== "string" || !APPROVALS.includes(data.approval as AgentApproval)) {
      errors.push(`approval must be one of: ${APPROVALS.join(", ")}`);
    } else {
      approval = data.approval as AgentApproval;
    }
  }

  let maxIterations: number | undefined;
  if (data.maxIterations !== undefined) {
    const value = Number(data.maxIterations);
    if (!Number.isInteger(value) || value < 1) {
      errors.push("maxIterations must be a positive integer");
    } else {
      maxIterations = value;
    }
  }

  if (errors.length) return { errors };

  const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : id;

  return {
    definition: {
      id,
      name,
      description:
        typeof data.description === "string" && data.description.trim()
          ? data.description.trim()
          : undefined,
      personality,
      provider: provider as string | undefined,
      model: model as string | undefined,
      tools,
      approval,
      maxIterations,
    },
    errors,
  };
};

export { parseAgentFile, parseFrontmatter };
export type { Frontmatter, FrontmatterValue };
