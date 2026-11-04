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

// Parses a restored message into a finished document, the same way
// replaceStreamWith closes a streamed answer.
const restoredDocument = (text: string) => {
  const stream = new MarkdownStream();
  stream.push(text);

  return stream.finish();
};

// How many secondary entries (tool output, reasoning, notices) the transcript
// keeps. The conversation itself — every user message and every answer — is
// never trimmed, so the user can always scroll back through the whole chat.
const MAX_SECONDARY_ENTRIES = 400;

// Ink-backed renderer: full-screen panes, live activity and a spawn strip.
// It owns one Ink instance and re-renders on every state change; the loop
// keeps calling render(event) exactly as it does with the line renderer.
class TuiUiAdapter implements UiAdapter {
  protected state: TuiState;
  protected instance?: ReturnType<typeof render>;
  protected onSubmit: (prompt: string) => void = () => {};
  protected onExit: () => void = () => {};
  // Text typed in the input box and not sent yet. Ink owns stdin, so the app
  // is the only one that knows it; it reports every change here.
  protected draft = "";
  // Receives that text, when the owner asked to be told about it.
  protected onDraftChange: ((draft: string) => void) | null = null;
  // Resolver for the approval currently on screen, if any.
  protected pendingApproval: ((decision: ApprovalDecision) => void) | null = null;
  // Markdown accumulators for the two streamed roles. Kept out of the state so
  // keystrokes never re-parse what already arrived.
  protected streams: Partial<Record<"answer" | "reasoning", MarkdownStream>> = {};
  // Index of the entry each streamed role is writing. Anchoring by role
  // instead of by position keeps a delta going into its own entry when
  // something else (a child settling, a tool line) lands in between.
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

  // Registers the callbacks the app needs and mounts Ink. onDraftChange is
  // optional: without it the adapter simply reports an empty draft.
  start(options: {
    onSubmit: (prompt: string) => void;
    onExit: () => void;
    onDraftChange?: (draft: string) => void;
  }) {
    this.onSubmit = options.onSubmit;
    this.onExit = options.onExit;
    this.onDraftChange = options.onDraftChange ?? null;
    this.mount();
  }

  // True while the input box holds text the user has not sent. A mounted app
  // keeps this in sync on every keystroke; with no app (or no callback passed)
  // the box is empty by definition.
  hasDraft(): boolean {
    return this.draft.length > 0;
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
        onDraftChange={(draft) => this.reportDraft(draft)}
      />
    );
  }

  // Keeps the last reported draft and forwards it to the owner, if any.
  protected reportDraft(draft: string) {
    if (draft === this.draft) return;

    this.draft = draft;
    this.onDraftChange?.(draft);
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
    const { lines, anchors } = trimAnchored(
      [...this.state.lines, line],
      this.anchors,
      MAX_SECONDARY_ENTRIES,
    );

    this.anchors = anchors;
    this.state = { ...this.state, lines };
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

    // The final text replaces the entry the role was writing, found by its
    // anchor: a notice that landed mid-stream must not leave a second copy.
    const written = writeAnchored(
      this.state.lines,
      this.anchors,
      role,
      () => ({ role, doc }) as TuiLine,
      MAX_SECONDARY_ENTRIES,
    );

    this.anchors = written.anchors;
    this.state = { ...this.state, lines: written.lines };
    this.mount();
  }

  protected replaceStreamEntry(
    role: "answer" | "reasoning",
    doc: ReturnType<MarkdownStream["push"]>,
  ) {
    // The role keeps writing into the entry its anchor points at, so a notice
    // landing in the middle of the stream does not open a second entry. The
    // anchor is stored again, because pushLine leaves it where it was.
    const written = writeAnchored(
      this.state.lines,
      this.anchors,
      role,
      () => ({ role, doc }) as TuiLine,
      MAX_SECONDARY_ENTRIES,
    );

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
        // pushLine leaves the anchors alone, so the header has to become the
        // open tool entry itself: otherwise its chunks would land in the
        // previous command's entry.
        this.anchors = { ...this.anchors, tool: this.state.lines.length - 1 };
        return;
      case "toolOutput":
        this.appendToolOutput(event.chunk);
        return;
      case "toolEnd":
        this.state = { ...this.state, activity: "working" };
        break;
      case "turnStart":
        this.pushLine({ role: "user", text: event.prompt });
        // A new turn owns its entries: without dropping the anchors, this
        // turn's answer would be written into the previous turn's answer entry
        // (found by its still-valid anchor) instead of opening a fresh one
        // below the new message, and the user would read the last answer only.
        this.anchors = noAnchors();
        // A new turn starts settled: every reasoning/tool entry collapses by
        // default, so the transcript stays readable as it grows.
        this.state = {
          ...this.state,
          activity: "working",
          running: true,
          expanded: new Set<number>(),
        };
        break;
      case "turnEnd": {
        this.finishStream("answer");
        this.finishStream("reasoning");
        this.state = { ...this.state, activity: undefined, running: false };
        // The closing line is only printed when the turn did not complete, or
        // when the session goes on by itself (the screen would look stopped).
        const closing = formatTurnOutcome(event.outcome, event.continuation);
        if (closing) {
          this.pushLine({ role: "notice", text: closing });
          return;
        }
        break;
      }
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
      case "conversation": {
        // A session with nothing to show must not clear the transcript a new
        // session already has on screen.
        if (!event.entries.length) return;
        // The conversation belongs to the session we left, so it replaces the
        // transcript whole: two events (a reset plus the messages) would show the
        // old one under the new session in between. Answers go through the
        // markdown stream, the same path a live answer takes, so restored text is
        // styled instead of printed raw.
        this.streams = {};
        this.anchors = noAnchors();
        const lines = event.entries.map((entry): TuiLine =>
          entry.role === "user"
            ? { role: "user", text: entry.content }
            : { role: "answer", doc: restoredDocument(entry.content) },
        );
        // `history` stays: the children of the session are the next event
        // (spawnHistory). The live strip belongs to the previous session, and
        // every entry of the old transcript was collapsed or expanded for it.
//
// The renderer is left at rest: the turn that was running belonged to the
// session we just left and nothing is in flight here, so `running` and
// `activity` would keep the clock ticking and every tool/reasoning entry
// previewing a tail for a turn that will never end.
this.state = {
...this.state,
lines,
spawns: [],
expanded: new Set<number>(),
running: false,
activity: undefined,
};
// An approval on screen was asked by the turn of the session we left, and
// that turn waits for the answer: leaving the dialog open would keep it
// blocked on a question nobody is answering anymore. Denying it ends the old
// turn, the same way closing the app does.
if (this.pendingApproval) this.resolveApproval("deny");
        break;
      }
      case "spawnSettled":
        // The strip only shows the state; the transcript gets the outcome, so a
        // child that finishes while the user looks elsewhere is not lost.
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

  // Live tool output: appended to the open tool entry so a chatty command does
  // not create one line per chunk, and so chunks land under their own header
  // even when a notice arrives in between.
  protected appendToolOutput(chunk: string) {
    const written = writeAnchored(
      this.state.lines,
      this.anchors,
      "tool",
      (open) =>
        ({
          role: "tool",
          text: `${open?.role === "tool" ? open.text : ""}${chunk}`,
        }) as TuiLine,
      MAX_SECONDARY_ENTRIES,
    );

    this.anchors = written.anchors;
    this.state = { ...this.state, lines: written.lines };
    this.mount();
  }

  // Core diagnostics never enter the transcript: mixing them with the
  // conversation is exactly the bug this guards against. Ink owns the screen,
  // so the sink discards instead of writing to stderr either, which would
  // corrupt the live render. Debugging the TUI relies on the line renderer or
  // on LOG_LEVEL there; the level filter in core is what decides what exists.
  logger(): ILogger {
    return createLogger(() => {});
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
