import type { MemoryKind, MemoryScope } from "@/memory";
import type { Tool, ToolContext, ToolResult } from "./Tool";

// Kinds that must carry a `topicKey`. They are the ones that get revised: two
// facts about the same subject without a key would pile up as duplicates
// instead of replacing each other. An episode is a one-off, so it may omit it.
const KEYED_KINDS: MemoryKind[] = ["fact", "decision", "preference"];

const KINDS: MemoryKind[] = ["fact", "decision", "episode", "preference"];

const SCOPES: MemoryScope[] = ["user", "project", "session"];

const MAX_TITLE_CHARS = 120;

const DEFAULT_MAX_CONTENT_CHARS = 4000;

export interface RememberToolOptions {
  // Cap on the content, from memory.maxCaptureChars. Passed in because a tool
  // never reads the config: the schema it advertises has to match the limit the
  // user actually configured.
  maxContentChars?: number;
  // True when the active backend ignores topicKey (the http one, whose capture
  // never sends it). Demanding a key the backend drops would only make the model
  // invent one, so it becomes optional and the tool says what it loses.
  topicKeyUnsupported?: boolean;
}

// Writes what the user asked to keep. The memory injected at start-up is what
// an earlier session chose to record; this tool is how the model decides that
// something said right now is worth keeping after the session is gone.
class RememberTool implements Tool {
  name = "remember";
  description =
    "Store one durable memory: a fact, a decision, a preference or an episode worth keeping after this session ends. Use it when the user asks you to remember something, or when a decision is settled and recording it saves asking again later.";
  parameters;
  private readonly maxContentChars: number;
  private readonly topicKeyUnsupported: boolean;

  constructor(options: RememberToolOptions = {}) {
    this.maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
    this.topicKeyUnsupported = options.topicKeyUnsupported === true;
    this.parameters = {
      type: "object" as const,
      properties: {
        kind: {
          type: "string" as const,
          enum: KINDS,
          description:
            "What kind of memory this is. Defaults to fact. An episode is something that happened; a decision is a choice that was made; a preference is how the user wants things done.",
        },
        scope: {
          type: "string" as const,
          enum: SCOPES,
          description:
            "Who the memory belongs to: user (every project), project (this workspace only) or session (forgotten with this session).",
        },
        title: {
          type: "string" as const,
          description: `Short headline for the memory, at most ${MAX_TITLE_CHARS} characters.`,
        },
        content: {
          type: "string" as const,
          description: `The memory itself, self-contained and at most ${this.maxContentChars} characters.`,
        },
        topicKey: {
          type: "string" as const,
          description:
            "Stable key naming the subject (for example 'auth.login'). Stores a new revision instead of a duplicate, and is required for facts, decisions and preferences. Optional when this backend cannot upsert: every write then stores a new memory.",
        },
      },
      required: ["scope", "title", "content"],
      additionalProperties: false,
    };
  }

  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const input = args as
      | { kind?: unknown; scope?: unknown; title?: unknown; content?: unknown; topicKey?: unknown }
      | null
      | undefined;

    const kind = input?.kind === undefined ? "fact" : input.kind;
    if (typeof kind !== "string" || !KINDS.includes(kind as MemoryKind)) {
      return {
        output: `remember expects 'kind' to be one of: ${KINDS.join(", ")}`,
        isError: true,
      };
    }

    const scope = input?.scope;
    if (typeof scope !== "string" || !SCOPES.includes(scope as MemoryScope)) {
      return {
        output: `remember expects 'scope' to be one of: ${SCOPES.join(", ")}`,
        isError: true,
      };
    }

    if (typeof input?.title !== "string" || !input.title.trim()) {
      return {
        output: "remember expects a non-empty 'title' string",
        isError: true,
      };
    }
    const title = input.title.trim();
    // Checked after the trim: trailing spaces are not what overflows a column.
    if (title.length > MAX_TITLE_CHARS) {
      return {
        output: `remember expects 'title' to be at most ${MAX_TITLE_CHARS} characters, got ${title.length}`,
        isError: true,
      };
    }

    if (typeof input.content !== "string" || !input.content.trim()) {
      return {
        output: "remember expects a non-empty 'content' string",
        isError: true,
      };
    }
    const content = input.content.trim();
    if (content.length > this.maxContentChars) {
      return {
        output: `remember expects 'content' to be at most ${this.maxContentChars} characters, got ${content.length}. Keep the essential part and leave the rest to the conversation.`,
        isError: true,
      };
    }

    let topicKey: string | undefined;
    if (input.topicKey !== undefined) {
      if (typeof input.topicKey !== "string" || !input.topicKey.trim()) {
        return {
          output: "remember expects 'topicKey' to be a non-empty string when it is given",
          isError: true,
        };
      }
      topicKey = input.topicKey.trim();
    }
    // The key is what makes a write a revision; a backend that drops it cannot
    // honour that, so the requirement only exists where the upsert does.
    if (!topicKey && !this.topicKeyUnsupported && KEYED_KINDS.includes(kind as MemoryKind)) {
      return {
        output: `remember requires 'topicKey' for kind '${kind}': it is what makes a later memory replace this one instead of duplicating it. Only 'episode' may omit it.`,
        isError: true,
      };
    }

    if (!ctx.rememberMemory) {
      return {
        output: "Memory is not available in this session",
        isError: true,
      };
    }

    try {
      const result = await ctx.rememberMemory({
        kind: kind as MemoryKind,
        scope: scope as MemoryScope,
        title,
        content,
        ...(topicKey ? { topicKey } : {}),
      });

      if ("error" in result) {
        // "unsupported" is about the setup and "failed" about the write: telling
        // them apart is what lets the model report the right thing to the user.
        if (result.error === "unsupported") {
          return {
            output:
              "Memory is not available in this session: the configured backend cannot store memories",
            isError: true,
          };
        }
        return {
          output: `remember failed: the memory backend did not store the entry${
            result.detail ? ` (${result.detail})` : ""
          }`,
          isError: true,
        };
      }

      return { output: `Remembered as id ${result.id} (${kind}, scope ${scope}).` };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      return { output: `remember failed: ${detail}`, isError: true };
    }
  }
}

export { RememberTool };
