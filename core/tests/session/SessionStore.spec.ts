import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionRecord, SessionStore } from "../../src/session/SessionStore";

const dirs: string[] = [];

const makeStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sessions-"));
  dirs.push(dir);
  return { dir, store: new SessionStore(dir) };
};

const baseRecord = (): SessionRecord => ({
  id: "session-1",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  provider: "openai",
  model: "model",
  history: [
    { role: "user", content: "hello" },
    { role: "system", content: "old assistant response" },
  ],
});

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("SessionStore", () => {
  it("persists the current session schema version", () => {
    const { dir, store } = makeStore();
    store.save(baseRecord());

    const raw = JSON.parse(
      fs.readFileSync(path.join(dir, "session-1.json"), "utf8"),
    );

    expect(raw.version).toBe(3);
  });

  it("migrates legacy assistant messages stored as system", () => {
    const { dir, store } = makeStore();
    fs.writeFileSync(
      path.join(dir, "session-1.json"),
      JSON.stringify(baseRecord()),
      "utf8",
    );

    const loaded = store.load("session-1");

    expect(loaded?.history).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "old assistant response" },
    ]);
  });

  it("preserves system messages for current-version sessions", () => {
    const { store } = makeStore();
    store.save({
      ...baseRecord(),
      version: 3,
      history: [
        { role: "system", content: "persona" },
        { role: "user", content: "hello" },
      ],
    });

    const loaded = store.load("session-1");

    expect(loaded?.history[0]).toEqual({ role: "system", content: "persona" });
  });

  it("persists the agent id", () => {
    const { store } = makeStore();
    store.save({ ...baseRecord(), agentId: "reviewer" });

    expect(store.load("session-1")?.agentId).toBe("reviewer");
  });
});
