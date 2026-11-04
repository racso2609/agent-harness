import type {
  ConversationEntry,
  ApprovalDecision,
  ApprovalRequest,
  ILogger,
  LoggerSink,
} from "@racso/core";
import { createLogger } from "@racso/core";
import {
clearPrompt,
input,
printImage,
printLogo,
restorePrompt,
select,
} from "@/terminal/stdin";
import { formatSpawnOutcome, formatTurnOutcome } from "./outcome";
import { formatStatusBar } from "./statusBar";
import type { SelectionRequest, UiAdapter, UiEvent } from "./UiAdapter";

// Re-exported so the line renderer keeps its `formatStatusBar` import surface
// while both renderers share the single formatter in statusBar.ts.
export { formatStatusBar } from "./statusBar";

// Longest excerpt of a single message the summary shows. A scrollback cannot
// take a whole conversation back, so long messages are cut here.
const EXCERPT = 200;

// Cuts a message down to one readable line.
const excerpt = (text: string): string => {
  const one = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(one);

  return chars.length > EXCERPT ? `${chars.slice(0, EXCERPT).join("")}…` : one;
};

// Newest entry of a role, if the conversation has one.
const lastOf = (entries: ConversationEntry[], role: ConversationEntry["role"]) => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.role === role) return entry;
  }

  return undefined;
};

// Short summary of a resumed conversation: the scrollback cannot receive a
// whole transcript (it would bury the session the user just opened under
// hundreds of lines they already read), so the renderer says how many messages
// came back and repeats only the last exchange. The TUI, which owns the screen,
// shows the conversation whole through the same event.
export const formatConversationSummary = (entries: ConversationEntry[]): string[] => {
  if (!entries.length) return [];

  const lines = [`conversation restored: ${entries.length} messages`];
  const lastUser = lastOf(entries, "user");
  const lastAnswer = lastOf(entries, "assistant");

  if (lastUser) lines.push(`you: ${excerpt(lastUser.content)}`);
  if (lastAnswer) lines.push(`assistant: ${excerpt(lastAnswer.content)}`);

  return lines;
};

// Line-oriented renderer: the behaviour the CLI shipped with. It stays the
// default so existing sessions and tests keep working while the ink TUI is
// built behind a flag.
class CliUiAdapter implements UiAdapter {
  // True once this turn printed something. The answer is set apart with blank
  // lines only when something came before it, so a bare answer stays flush.
  protected turnPrinted = false;

  // Writes a line above the prompt without clobbering what the user typed.
  notify(message: string) {
    clearPrompt();
    process.stdout.write(`${message}\n`);
    restorePrompt();
    this.turnPrinted = true;
  }

  // Streams a partial piece of output on the same line.
  protected writeChunk(text: string) {
    clearPrompt();
    process.stdout.write(text);
    restorePrompt();
    this.turnPrinted = true;
  }

  // Builds a core logger whose lines are routed through the prompt-safe sink.
  // The sink is unchanged: core already filters by level (default "error"), so
  // warn/info only reach it with LOG_LEVEL or --debug.
  logger(): ILogger {
    const sink: LoggerSink = (line) => {
      clearPrompt();
      process.stderr.write(`${line}\n`);
      restorePrompt();
    };
    return createLogger(sink);
  }

  render(event: UiEvent) {
    switch (event.type) {
      case "status":
        if (formatStatusBar(event.status)) this.notify(formatStatusBar(event.status));
        break;
      case "notice":
        this.notify(event.message);
        break;
      case "text":
        this.writeChunk(event.delta);
        break;
      case "reasoning":
        // Reasoning is noise on a scrollback terminal; the TUI renders it.
        break;
      case "toolStart":
        this.notify(`→ ${event.name}`);
        break;
      case "toolOutput":
        this.writeChunk(event.chunk);
        break;
      case "toolEnd":
        break;
      case "answer":
        // The answer is set apart from what the turn already printed. A bare
        // answer stays flush: a leading blank line would open the screen.
        if (this.turnPrinted) this.notify(`\n${event.text}\n`);
        else this.notify(event.text);
        break;
      case "turnStart":
        this.turnPrinted = false;
        break;
      case "turnEnd": {
        const closing = formatTurnOutcome(event.outcome, event.continuation);
        if (closing) this.notify(closing);
        break;
      }
      case "spawn":
        this.notify(`spawn ${event.handle.spawnId} started (${event.handle.agentId})`);
        break;
      case "spawnHistory":
        // A resumed session can carry a long tail; only the newest are worth a
        // line, and /children still has them all.
        if (event.handles.length) {
          const newest = event.handles
            .slice(-3)
            .map((handle) => `${handle.spawnId} ${handle.status}`)
            .join(", ");
          this.notify(`children from this session: ${event.handles.length} (${newest})`);
        }
        break;
      case "spawnSettled":
        this.notify(formatSpawnOutcome(event.handle));
        break;
      case "conversation": {
        // The previous transcript belongs to another session: it goes away. An
        // empty conversation leaves the screen alone, so a new session starts
        // where it already is.
        if (!event.entries.length) break;
        this.reset();
        for (const line of formatConversationSummary(event.entries)) this.notify(line);
        break;
      }
      case "reset":
        this.reset();
        break;
    }
  }

  // Renders a base64/data-url image inline in the terminal.
  async renderImage(url: string) {
    const base64 = url.split(",").pop() ?? url;
    await printImage(base64);
  }

  // Redraws the screen with the logo, preserving session state.
  reset() {
    process.stdout.write("\x1Bc");
    printLogo();
  }

  // Asks the user to approve a side-effect request.
  async promptApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    const answer = (
      await input(
        `Allow ${request.tool} [${request.kind}] ${request.subject}? ` + `[y/N/a=always] `,
      )
    ).trim();

    if (/^a(lways)?$/i.test(answer)) return "always";
    return /^y(es)?$/i.test(answer) ? "allow" : "deny";
  }

  // Shows the numeric list the CLI always had. The picker of stdin answers with
// the label it printed, so the id is recovered by position: two options that
// share a label are otherwise indistinguishable to the user too.
async select(request: SelectionRequest): Promise<string | undefined> {
if (!request.options.length) return undefined;

const chosen = await select(
request.message,
request.options.map((option) => option.label),
);
const index = request.options.findIndex((option) => option.label === chosen);

return index >= 0 ? request.options[index]!.id : undefined;
}

// The line renderer leaves the terminal as the prompt owns it.
  close() {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  }
}

export { CliUiAdapter };
