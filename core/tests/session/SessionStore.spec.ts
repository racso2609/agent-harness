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

expect(raw.version).toBe(4);
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

it("persists the spawn history of a session", () => {
const { dir, store } = makeStore();
store.save({
...baseRecord(),
spawns: [
{
spawnId: "spawn-1",
sessionId: "session-1",
agentId: "coder",
prompt: "implement",
status: "done",
startedAt: "2026-01-01T00:00:00.000Z",
finishedAt: "2026-01-01T00:00:05.000Z",
result: "ok",
},
{
spawnId: "spawn-2",
sessionId: "session-1",
agentId: "code-reviewer",
prompt: "review",
status: "error",
startedAt: "2026-01-01T00:01:00.000Z",
finishedAt: "2026-01-01T00:01:01.000Z",
error: "provider down",
},
],
});

const raw = JSON.parse(
fs.readFileSync(path.join(dir, "session-1.json"), "utf8"),
);

expect(raw.spawns).toHaveLength(2);
expect(raw.spawns[0]).toMatchObject({ spawnId: "spawn-1", status: "done" });
expect(raw.spawns[1]).toMatchObject({ spawnId: "spawn-2", status: "error" });

const loaded = store.load("session-1");
expect(loaded?.spawns).toEqual(raw.spawns);
});

it("migrates a v3 record to an empty spawn history", () => {
const { dir, store } = makeStore();
const legacy = { ...baseRecord(), version: 3 };
delete (legacy as { spawns?: unknown }).spawns;

fs.writeFileSync(
path.join(dir, "session-1.json"),
JSON.stringify(legacy),
"utf8",
);

const loaded = store.load("session-1");

expect(loaded?.spawns).toEqual([]);
});

it("keeps an empty spawn list out of the record when unused", () => {
const { dir, store } = makeStore();
store.save(baseRecord());

const raw = JSON.parse(
fs.readFileSync(path.join(dir, "session-1.json"), "utf8"),
);

expect(raw.spawns).toBeUndefined();
});

});
