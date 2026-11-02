import type { ApprovalDecision, ApprovalRequest, ILogger, UiTheme } from "@racso/core";
import { createLogger } from "@racso/core";
import { render } from "ink";
import { formatSpawnOutcome, formatTurnOutcome } from "./outcome";
import { App, type TuiApproval, type TuiLine, type TuiState } from "./tui/App";
import { noAnchors, trimAnchored, writeAnchored, type RoleAnchors } from "./tui/entries";
import { MarkdownStream } from "./tui/markdown";
import { toSpawnEntry } from "./tui/progress";
import { resolveTheme, type Theme } from "./tui/theme";
import type { UiAdapter, UiEvent } from "./UiAdapter";

const MAX_LINES = 400;

// Ink-backed renderer: full-screen panes, live activity and a spawn strip.
// It owns one Ink instance and re-renders on every state change; the loop
// keeps calling render(event) exactly as it does with the line renderer.
class TuiUiAdapter implements UiAdapter {
  protected state: TuiState;
  protected instance?: ReturnType<typeof render>;
  protected onSubmit: (prompt: string) => void = () => {};
  protected onExit: () => void = () => {};
  // Resolver for the approval currently on screen, if any.
  protected pendingApproval: ((decision: ApprovalDecision) => void) | null = null;
  // Markdown accumulators for the two streamed roles. Kept out of the state so
  // keystrokes never re-parse what already arrived.
  protected streams: Partial<Record<"answer" | "reasoning", MarkdownStream>> = {};
  // Index of the entry each streamed role is writing. Anchoring by role instead
  // of by position keeps a delta going into its own entry when something else
  // (a child settling, a tool line) lands in between.
  protected anchors: RoleAnchors = noAnchors();

  constructor(theme?: UiTheme) {
    this.state = {
      lines: [],
      status: {},
      spawns: [],
      history: [],
      theme: resolveTheme(theme),
      expanded: new Set<number>(),
    };
  }

  // Registers the callbacks the app needs and mounts Ink.
  start(options: { onSubmit: (prompt: string) => void; onExit: () => void }) {
    this.onSubmit = options.onSubmit;
    this.onExit = options.onExit;
    this.mount();
  }

  protected get theme(): Theme {
    return this.state.theme;
  }

  protected element() {
    return (
      <App
        state={this.state}
        onSubmit={(prompt) => this.onSubmit(prompt)}
        onExit={() => this.onExit()}
        onDecision={(decision) => this.resolveApproval(decision)}
        onToggle={(kind, index) => this.toggleEntry(kind, index)}
        onToggleAll={(kind) => this.toggleAll(kind)}
      />
    );
  }

  protected mount() {
    const element = this.element();

    if (!this.instance) {
      this.instance = render(element);
      return;
    }

    this.instance.rerender(element);
  }

  // Resolves the approval shown in the app and returns to the input box.
  protected resolveApproval(decision: ApprovalDecision) {
    const resolve = this.pendingApproval;
    this.pendingApproval = null;
    this.state = { ...this.state, approval: undefined };
    this.mount();
    resolve?.(decision);
  }

  // Expands or collapses one entry by index (its position in the transcript).
  protected toggleEntry(kind: "reasoning" | "tool", index: number) {
    const expanded = new Set(this.state.expanded);

    if (expanded.has(index)) {
      expanded.delete(index);
    } else {
      expanded.add(index);
    }

    this.state = { ...this.state, expanded };
    this.mount();
  }

  // Ctrl+R / Ctrl+T: toggles every entry of that kind at once. If any is
  // collapsed the whole kind opens, otherwise it all closes.
  protected toggleAll(kind: "reasoning" | "tool") {
    const lines = this.state.lines;
    const indexes = lines
      .map((line, index) => ({ line, index }))
      .filter((entry) => entry.line.role === kind)
      .map((entry) => entry.index);

    if (!indexes.length) return;

    const expanded = new Set(this.state.expanded);
    const anyCollapsed = indexes.some((index) => !expanded.has(index));

    for (const index of indexes) {
      if (anyCollapsed) expanded.add(index);
      else expanded.delete(index);
    }

    this.state = { ...this.state, expanded };
    this.mount();
  }

  protected pushLine(line: TuiLine) {
    const written = trimAnchored([...this.state.lines, line], this.anchors, MAX_LINES);

    this.anchors = written.anchors;
    this.state = { ...this.state, lines: written.lines };
    this.mount();
  }

  // Appends a delta to the streamed role. The markdown stream owns block
  // boundaries, so the same role keeps growing in one entry.
  protected appendStream(role: "answer" | "reasoning", delta: string) {
    const stream = (this.streams[role] ??= new MarkdownStream());
    const doc = stream.push(delta);

    this.replaceStreamEntry(role, doc);
  }

  // Closes the stream of a role, styling its final block.
  protected finishStream(role: "answer" | "reasoning") {
    const stream = this.streams[role];
    if (!stream) return;

    const doc = stream.finish();
    this.replaceStreamEntry(role, doc);
    this.streams[role] = undefined;
  }

  // Replaces the streamed answer of the current turn with the final text.
  protected replaceStreamWith(role: "answer" | "reasoning", text: string) {
    const stream = new MarkdownStream();
    stream.push(text);
    const doc = stream.finish();

    this.streams[role] = undefined;

    const entry: TuiLine = { role, doc };
    const written = writeAnchored(this.state.lines, this.anchors, role, () => entry, MAX_LINES);

    this.anchors = written.anchors;
    this.state = { ...this.state, lines: written.lines };
    this.mount();
  }

  protected replaceStreamEntry(
    role: "answer" | "reasoning",
    doc: ReturnType<MarkdownStream["push"]>,
  ) {
    const entry: TuiLine = { role, doc };

    // The delta continues the entry this role opened, wherever it sits: another
    // role may have written in between without splitting the stream in two.
    const written = writeAnchored(this.state.lines, this.anchors, role, () => entry, MAX_LINES);

    this.anchors = written.anchors;
    this.state = { ...this.state, lines: written.lines };
    this.mount();
  }

  render(event: UiEvent) {
    switch (event.type) {
      case "status":
        this.state = { ...this.state, status: event.status };
        break;
      case "notice":
        this.pushLine({ role: "notice", text: event.message });
        return;
      case "text":
        this.appendStream("answer", event.delta);
        return;
      case "answer":
        // The final text is authoritative: replace whatever the stream produced
        // (it may have been empty or cut short).
        this.replaceStreamWith("answer", event.text);
        return;
      case "reasoning":
        this.appendStream("reasoning", event.delta);
        this.state = { ...this.state, activity: "thinking" };
        break;
      case "toolStart":
        // The input box reports what the turn is doing right now.
        this.state = { ...this.state, activity: `working · ${event.name}` };
        this.pushLine({ role: "tool", text: `→ ${event.name}` });
        // The chunks of this command land in this entry, wherever it sits.
        this.anchors = { ...this.anchors, tool: this.state.lines.length - 1 };
        return;
      case "toolOutput":
        this.appendToolOutput(event.chunk);
        return;
      case "toolEnd":
        this.state = { ...this.state, activity: "working" };
        break;
      case "turnStart":
        // A new turn opens with no entry in progress for any role.
        this.anchors = noAnchors();
        this.pushLine({ role: "user", text: event.prompt });
        // A new turn starts settled: every reasoning/tool entry collapses by
        // default, so the transcript stays readable as it grows.
        this.state = {
          ...this.state,
          activity: "working",
          running: true,
          expanded: new Set<number>(),
        };
        break;
      case "turnEnd":
        this.finishStream("answer");
        this.finishStream("reasoning");
        this.state = { ...this.state, activity: undefined, running: false };
        // A completed turn says nothing: the answer is the closing line already.
        const closing = formatTurnOutcome(event.outcome);
        if (closing) {
          this.pushLine({ role: "notice", text: closing });
          return;
        }
        break;
      case "spawn":
        this.state = {
          ...this.state,
          spawns: [...this.state.spawns, toSpawnEntry(event.handle)],
        };
        break;
      case "spawnHistory":
        // Restored children keep their final status and never tick; they live
        // in their own list so they never mix with the children of this run.
        this.state = {
          ...this.state,
          history: event.handles.map((handle) => ({
            ...toSpawnEntry(handle),
            restored: true,
          })),
        };
        break;
      case "spawnSettled":
        // The strip only shows the child is no longer running; the transcript
        // still owes the user its result or its error.
        this.pushLine({ role: "notice", text: formatSpawnOutcome(event.handle) });
        this.state = {
          ...this.state,
          spawns: this.state.spawns.map((spawn) =>
            spawn.id === event.handle.spawnId
              ? {
                  ...spawn,
                  status: event.handle.status,
                  startedAt: event.handle.startedAt,
                  finishedAt: event.handle.finishedAt,
                }
              : spawn,
          ),
        };
        break;
      case "reset":
        this.streams = {};
        this.anchors = noAnchors();
        this.state = { ...this.state, lines: [] };
        break;
    }

    this.mount();
  }

  // Live tool output: appended to the entry of the running command so a chatty
  // command does not create one line per chunk.
  protected appendToolOutput(chunk: string) {
    // Concatenated into the entry of the running command, so a notice arriving
    // mid-command cannot split its output in two.
    const written = writeAnchored<TuiLine>(
      this.state.lines,
      this.anchors,
      "tool",
      (open) => ({
        role: "tool",
        text: (open?.role === "tool" ? open.text : "") + chunk,
      }),
      MAX_LINES,
    );

    this.anchors = written.anchors;
    this.state = { ...this.state, lines: written.lines };
    this.mount();
  }

  logger(): ILogger {
    return createLogger((line) => {
      this.pushLine({ role: "notice", text: line });
    });
  }

  // Shows the request as a selectable question and waits for the keystroke.
  // Ink owns stdin, so the answer cannot come from a readline prompt.
  promptApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.pendingApproval) return Promise.resolve("deny");

    const approval: TuiApproval = {
      tool: request.tool,
      kind: request.kind,
      subject: request.subject,
    };

    this.state = { ...this.state, approval };
    this.mount();

    return new Promise<ApprovalDecision>((resolve) => {
      this.pendingApproval = resolve;
    });
  }

  async renderImage(url: string) {
    this.pushLine({ role: "notice", text: `[image] ${url.slice(0, 32)}…` });
  }

  close() {
    this.resolveApproval("deny");
    this.instance?.unmount();
  }
}

export { TuiUiAdapter };
