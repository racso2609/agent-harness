import { describe, expect, it } from "vitest";
import { normalizeToolMarkup } from "../../src/providers/normalizeToolMarkup";
import type { AssistantTurn } from "../../src/types/providers";

const turn = (text: string): AssistantTurn => ({
  text,
  toolCalls: [],
  finishReason: "stop",
});

describe("normalizeToolMarkup", () => {
  it("parses <tool_call> tags", () => {
    const result = normalizeToolMarkup(
      turn(
        'Calling now <tool_call>{"name":"readFile","arguments":{"path":"a.txt"}}</tool_call>',
      ),
    );

    expect(result.toolCalls).toEqual([
      {
        id: "textCall0",
        name: "readFile",
        args: { path: "a.txt" },
        rawArgs: '{"path":"a.txt"}',
      },
    ]);
    expect(result.text).toBe("Calling now");
    expect(result.finishReason).toBe("toolCalls");
  });

  it("parses ```tool_call fences", () => {
    const result = normalizeToolMarkup(
      turn('```tool_call\n{"name":"shell","arguments":{"command":"ls"}}\n```'),
    );

    expect(result.toolCalls).toEqual([
      {
        id: "textCall0",
        name: "shell",
        args: { command: "ls" },
        rawArgs: '{"command":"ls"}',
      },
    ]);
    expect(result.text).toBe("");
    expect(result.finishReason).toBe("toolCalls");
  });

  it("parses DeepSeek markup", () => {
    const result = normalizeToolMarkup(
      turn(
        '<|tool▁calls▁begin|>{"name":"listDir","arguments":{"path":"."}}<|tool▁calls▁end|>',
      ),
    );

    expect(result.toolCalls).toEqual([
      {
        id: "textCall0",
        name: "listDir",
        args: { path: "." },
        rawArgs: '{"path":"."}',
      },
    ]);
    expect(result.finishReason).toBe("toolCalls");
  });

  it("parses multiple calls in one turn", () => {
    const result = normalizeToolMarkup(
      turn(
        '<tool_call>{"name":"a","arguments":{}}</tool_call><tool_call>{"name":"b","arguments":{}}</tool_call>',
      ),
    );

    expect(result.toolCalls.map((call) => call.name)).toEqual(["a", "b"]);
    expect(result.toolCalls.map((call) => call.id)).toEqual([
      "textCall0",
      "textCall1",
    ]);
  });

  it("keeps static text intact when there is no markup (false positive)", () => {
    const original = turn("Just a normal answer about JSON, no tools here.");

    expect(normalizeToolMarkup(original)).toBe(original);
  });

  it("leaves text untouched when the JSON does not parse", () => {
    const original = turn("<tool_call>{not json}</tool_call>");

    expect(normalizeToolMarkup(original)).toBe(original);
  });

  it("ignores turns that already carry structured tool calls", () => {
    const original: AssistantTurn = {
      text: "<tool_call>{\"name\":\"x\",\"arguments\":{}}</tool_call>",
      toolCalls: [{ id: "call_1", name: "x", args: {} }],
      finishReason: "toolCalls",
    };

    expect(normalizeToolMarkup(original)).toBe(original);
  });
});
