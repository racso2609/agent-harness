import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AskOptions,
  ConversationEntry,
  IHarness,
  SpawnHandle,
  SpawnEventListener,
} from "@racso/core";
import type { TuiState } from "../../src/ui/tui/App";
import type { UiEvent } from "../../src/ui/UiAdapter";

// Ink patches the console the moment it mounts, which a headless run cannot
// take, so the renderer is stubbed: these tests are about the wiring of the
// loop, not about what ink paints.
// The loop would otherwise run the interactive setup on a machine with no
// usable config, and that flow reads stdin. The config these cases build has no
// providers, so `needsSetup()` is true by construction and the flow is stubbed.
vi.mock("../../src/flows/startSetup", () => ({ startSetup: async () => {} }));

vi.mock("ink", () => ({
  render: () => ({ rerender: () => {}, unmount: () => {} }),
  Box: () => null,
  Text: () => null,
  useInput: () => {},
  useStdout: () => ({ stdout: { columns: 80, rows: 24 } }),
}));

const { MainLoop } = await import("../../src/MainLoop");
const { Config, SUPPORTED_PROVIDERS } = await import("@racso/core");
const { TuiUiAdapter } = await import("../../src/ui/TuiUiAdapter");
const { createFlows } = await import("../../src/flows");

// The loop runs a stdin loop that cannot be mounted, so the prompts are handed
// to it the way the TUI does: through the callback the adapter gets from
// start(). This is the real MainLoop — its queue, its slash dispatch and its
// turns — with only the renderer substituted where it touches the terminal.
class Probe extends TuiUiAdapter {
  get view(): TuiState {
    return this.state as TuiState as TuiState;
  }

  get events(): UiEvent[] {
    return this.seen;
  }

  // Everything rendered, in order, for the assertions about the repaint.
  protected seen: UiEvent[] = [];

  override render(event: UiEvent) {
    this.seen.push(event);
    super.render(event);
  }

  // What the input box reports when the user sends a prompt.
  submit(prompt: string) {
    this.reportDraft("");
    this.onSubmit(prompt);
  }

  // Forgets what was rendered so far, so an assertion can be about one command.
  clearEvents() {
    this.seen = [];
  }
}

const CONTINUATION =
  "Continue with the work left by the children whose results you just received. If nothing is left, say so and stop.";

const handle = (overrides: Partial<SpawnHandle> = {}): SpawnHandle => ({
  spawnId: "spawn-1",
  sessionId: "session-old",
  agentId: "coder",
  prompt: "implement",
  status: "running",
  startedAt: new Date(0).toISOString(),
  ...overrides,
});

interface FakeOptions {
  // Session `loadSession` switches to; undefined means the switch failed.
  resumeTo?: string;
  conversation?: ConversationEntry[];
  history?: SpawnHandle[];
  // Undelivered children of the parent; drained once a continuation turn runs,
  // which is what delivery does in core.
  pending?: SpawnHandle[];
}

// A complete harness, not just the two methods the helpers use: the real loop
// calls initialize, status, ask and the spawn subscription too, and a stub that
// lied about them would let the wiring under test go untested.
const fakeHarness = (options: FakeOptions = {}) => {
  const calls = { ask: [] as { prompt: string; options?: AskOptions }[] };
  const listeners: SpawnEventListener[] = [];
  let sessionId = "session-new";
  let pending = options.pending ?? [];

  const harness: IHarness = {
    initialize: async () => {},
    ask: async (prompt, askOptions) => {
      calls.ask.push({ prompt, options: askOptions });
      if (prompt === CONTINUATION) pending = [];
      return { text: "done" };
    },
    status: () => ({
      sessionId,
      provider: "openai",
      model: "gpt-test",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      contextTokens: 0,
      contextUsage: 0,
      autoCompact: true,
      autoCompactThreshold: 60,
    }),
    listSessions: () => [
      {
        id: "session-old",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-02T00:00:00.000Z",
        provider: "openai",
        model: "gpt-test",
        messageCount: 2,
        title: "hola",
      },
    ],
    resolveSession: () => undefined,
    loadSession: async () => {
      if (!options.resumeTo) return false;
      sessionId = options.resumeTo;
      return true;
    },
    save: () => {},
    conversation: () => options.conversation ?? [],
    listProviders: () => [...SUPPORTED_PROVIDERS],
    listProviderDetails: () => [],
    configureProvider: () => {},
    removeProvider: () => false,
    setProvider: async () => false,
    listModels: () => [],
    setModel: () => false,
    listAgents: () => [],
    listSkills: () => [],
    reloadSkills: () => [],
    setAgent: async () => false,
    approveWith: () => {},
    spawn: () => handle(),
    pollSpawn: () => undefined,
    listSpawns: () => [],
    childHistory: () => options.history ?? [],
    pendingSpawns: () => pending,
    onSpawnEvent: (listener) => {
      listeners.push(listener);
      return () => {};
    },
    waitSpawn: async () => undefined,
    collectSpawns: async () => [],
    compactSession: async () => false,
    shutdown: () => {},
  };

  // Plays one child settling, the way core tells the loop about it.
  const settle = (settled: SpawnHandle) => {
    for (const listener of listeners) listener({ type: "settled", handle: settled });
  };

  return { harness, calls, settle };
};

const sleep = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits for the loop to reach a state, so no case depends on how many
// microtasks a turn happens to take.
const until = async (done: () => boolean) => {
  for (let attempt = 0; attempt < 500 && !done(); attempt += 1) await sleep(1);

  expect(done()).toBe(true);
};

// Boots a real MainLoop in TUI mode on that fake harness and lets the test type
// into it. TUI mode is what parks the loop, which is the only state a turn can
// start on its own from.
const boot = async (options: FakeOptions = {}) => {
  const { harness, calls, settle } = fakeHarness(options);
  // A hand-built config with no providers is the one shape that never prompts:
  // it keeps the setup flow (which does read stdin) out of the run.
  const config = new Config();
  config.config.providers = {};
  config.config.defaultProvider = undefined;

  const loop = new MainLoop({ config, tui: true });
  const ui = new Probe();
  loop.harness = harness;
  loop.ui = ui;

  void loop.start();
  // Parked in nextPrompt(): the callbacks are wired and a turn may start on its
  // own, which is the only state these cases make sense in.
  await until(() => (loop as unknown as { isWaitingForPrompt(): boolean }).isWaitingForPrompt());

  return { ui, calls, settle };
};

// Nothing here exits the process: the loop stays parked and the pending
// promise goes with the test.
afterEach(() => {
  vi.restoreAllMocks();
});

// /resume repaints the session it switched to: the transcript on screen must be
// the new one, and the turn the loop starts on its own must not read as
// something the user typed. Both are exercised through the real loop.
describe("the session now in charge", () => {
  it("repaints the conversation and the children of the resumed session", async () => {
    const entries: ConversationEntry[] = [
      { role: "user", content: "hola" },
      { role: "assistant", content: "buenas" },
    ];
    const restored = handle({ spawnId: "spawn-old", status: "done" });
    const { ui } = await boot({
      resumeTo: "session-old",
      conversation: entries,
      history: [restored],
    });

    ui.submit("/resume session-old");
    await until(() => ui.view.lines.length === 2);

    // The conversation replaces the whole transcript, styled like a live answer.
    expect(ui.view.lines.map((line) => line.role)).toEqual(["user", "answer"]);
    // The strip belongs to the session on screen too, and its restored children
    // arrive right after.
    expect(ui.view.history.map((entry) => entry.id)).toEqual(["spawn-old"]);
    // Painted once: a second conversation event would clear what it just showed.
    const repaints = ui.events.filter((event) => event.type === "conversation");
    expect(repaints).toHaveLength(1);
  });

  it("leaves the renderer at rest when it repaints", async () => {
    // The turn that was running belonged to the session we left: a transcript
    // repainted with the loop still `running` keeps the clock ticking and every
    // tool/reasoning entry previewing a tail for a turn that will never end.
    const entries: ConversationEntry[] = [{ role: "user", content: "hola" }];
    const { ui } = await boot({ resumeTo: "session-old", conversation: entries });

    ui.render({ type: "turnStart", prompt: "de la sesión anterior" });
    await until(() => ui.view.running === true);

    ui.submit("/resume session-old");
    await until(() => ui.view.lines.length === 1);

    expect(ui.view.running).toBe(false);
    expect(ui.view.activity).toBeUndefined();
  });

  it("ships nothing on boot for a session with nothing to show", async () => {
    const { ui } = await boot();

    ui.submit("/status");
    await until(() => ui.events.some((event) => event.type === "notice"));

    expect(ui.events.some((event) => event.type === "conversation")).toBe(false);
    expect(ui.events.some((event) => event.type === "spawnHistory")).toBe(false);
  });

  it("repaints nothing when a command kept the session", async () => {
    // Boot already painted this conversation once; what matters is that /help,
    // which does not switch sessions, paints nothing on top of it.
    const { ui } = await boot({ conversation: [{ role: "user", content: "de la anterior" }] });
    ui.clearEvents();

    ui.submit("/help");
    await until(() => ui.events.some((event) => event.type === "notice"));

    expect(ui.events.some((event) => event.type === "conversation")).toBe(false);
    expect(ui.events.some((event) => event.type === "spawnHistory")).toBe(false);
  });
});

// Core keeps an automatic turn in the history but leaves it out of
// conversation(), which is what makes /resume look right. The loop is what has
// to say so: without the mark the continuation text reads as a prompt the user
// wrote themselves.
describe("the turn the session starts on its own", () => {
  it("marks the continuation as unprompted", async () => {
    const child = handle({ status: "done", result: "all tests pass" });
    const { calls, settle } = await boot({ pending: [child] });

    // A child settling while the loop waits for a prompt starts a turn on its own.
    settle(child);
    await until(() => calls.ask.length === 1);

    expect(calls.ask[0]!.prompt).toBe(CONTINUATION);
    // Core's option is `?: true`: the flag says "nobody typed this", it is not a
    // boolean switch.
    expect(calls.ask[0]!.options?.unprompted).toBe(true);
  });

  it("does not mark a prompt the user sent, even with children waiting", async () => {
    const child = handle({ status: "done", result: "all tests pass" });
    const { ui, calls } = await boot({ pending: [child] });

    ui.submit("run the tests");
    await until(() => calls.ask.length === 1);

    expect(calls.ask[0]!.prompt).toBe("run the tests");
    expect(calls.ask[0]!.options?.unprompted).toBeUndefined();
  });
});

// /resume without an argument is a picker, and the picker used to hand back a
// "N) id" label that the flow decoded with a regex. These cases pin the two
// halves of that contract: the app receives the catalog of commands, and the
// flow hands the harness the id the option carried.
describe("the session picker", () => {
  it("identifies a session by its id, not by its position in the list", async () => {
    // The harness can order listSessions() differently between two calls, so a
    // position was never a stable identity for the session the user chose.
    const loaded: string[] = [];
    const { harness } = fakeHarness();
    const ui = {
      select: async (request: { options: { label: string }[] }) => {
        expect(request.options.map((option) => option.label)).toEqual(["session-old — hola"]);

        return "session-old";
      },
    } as unknown as Parameters<typeof createFlows>[0];

    const changed = await createFlows(ui, []).changeSession({
      ...harness,
      loadSession: async (id: string) => (loaded.push(id), true),
    } as IHarness);

    expect(changed).toBe(true);
    expect(loaded).toEqual(["session-old"]);
  });

  it("sends the command catalog to the app, which is what the dropdown lists", async () => {
    const start = vi.spyOn(TuiUiAdapter.prototype, "start");

    await boot();

    const received = start.mock.calls[0]?.[0] as { commands?: { name: string }[] };
    const names = received.commands?.map((command) => command.name) ?? [];

    expect(names).toContain("resume");
    expect(names).toContain("model");
  });
});
