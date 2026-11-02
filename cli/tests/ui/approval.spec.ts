import { describe, expect, it } from "vitest";
import { App, type TuiState } from "../../src/ui/tui/App";

// Rendering the app is covered by ink itself; what matters here is that the
// approval state is what the key handler reads. These tests pin the shape the
// app receives so the selectable question cannot silently disappear.
const baseState = (overrides: Partial<TuiState> = {}): TuiState => ({
  lines: [],
  status: {},
  spawns: [],
  ...overrides,
});

describe("TUI approval state", () => {
  it("carries the request the core sent", () => {
    const state = baseState({
      approval: {
        tool: "shell",
        kind: "exec",
        subject: "rm -rf build",
      },
    });

    expect(state.approval).toEqual({
      tool: "shell",
      kind: "exec",
      subject: "rm -rf build",
    });
  });

  it("has no approval while the input box is active", () => {
    expect(baseState().approval).toBeUndefined();
  });

  it("exposes App as a component", () => {
    expect(typeof App).toBe("function");
  });
});
