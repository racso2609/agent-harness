import type { AssistantTurn, ToolCall } from "@/types/providers";

interface ParsedCall {
  name: string;
  args: unknown;
  rawArgs: string;
  id?: string;
}

interface Pattern {
  // Extracts every raw tool-call payload from the assistant text.
  match: (text: string) => Array<{ raw: string; json: string; id?: string }>;
  // Removes the matched markup once a call was successfully parsed.
  strip: (text: string) => string;
}

const FENCE = /```tool_call\s*([\s\S]*?)```/g;
const TOOL_CALL_TAG = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
const DEEPSEEK_MARKUP = /<\|tool▁calls▁begin\|>\s*([\s\S]*?)\s*<\|tool▁calls▁end\|>/g;

// Extract the JSON body and optional id from a raw payload. Accepts either a
// bare object (`{"name":...}`) or the common `{"name":..., "arguments":...}`
// and DeepSeek `{"tool":..., "arguments":...}` shapes.
const toCall = (raw: string, id?: string): ParsedCall | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;

  const record = parsed as Record<string, unknown>;
  const name = record.name ?? record.tool ?? record.function;
  if (typeof name !== "string" || !name.trim()) return null;

  let args: unknown = record.arguments ?? record.args ?? record.parameters;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }

  return {
    name: name.trim(),
    args: args ?? {},
    rawArgs: typeof args === "string" ? args : JSON.stringify(args ?? {}),
    id,
  };
};

const PATTERNS: Pattern[] = [
  {
    match: (text) =>
      [...text.matchAll(TOOL_CALL_TAG)].map((m) => ({
        raw: m[1],
        json: m[1],
      })),
    strip: (text) => text.replace(TOOL_CALL_TAG, ""),
  },
  {
    match: (text) => [...text.matchAll(FENCE)].map((m) => ({ raw: m[1], json: m[1] })),
    strip: (text) => text.replace(FENCE, ""),
  },
  {
    match: (text) =>
      [...text.matchAll(DEEPSEEK_MARKUP)].map((m) => ({
        raw: m[1],
        json: m[1],
      })),
    strip: (text) => text.replace(DEEPSEEK_MARKUP, ""),
  },
];

// Reinterprets tool calls that models emit as plain text (no `delta.tool_calls`)
// back into structured calls. Returns the turn untouched when nothing parses,
// so a false positive can never drop legitimate assistant text.
export const normalizeToolMarkup = (turn: AssistantTurn): AssistantTurn => {
  if (turn.toolCalls.length) return turn;

  for (const pattern of PATTERNS) {
    const matches = pattern.match(turn.text);
    if (!matches.length) continue;

    const calls: ToolCall[] = [];
    for (const [index, match] of matches.entries()) {
      const parsed = toCall(match.json, match.id);
      if (!parsed) continue;

      calls.push({
        id: parsed.id ?? `textCall${index}`,
        name: parsed.name,
        args: parsed.args,
        rawArgs: parsed.rawArgs,
      });
    }

    if (!calls.length) continue;

    const text = pattern.strip(turn.text).trim();
    return { text, toolCalls: calls, finishReason: "toolCalls" };
  }

  return turn;
};
