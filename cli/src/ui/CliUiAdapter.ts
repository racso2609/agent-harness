import type { ApprovalDecision, ApprovalRequest, ILogger, LoggerSink } from "@racso/core";
import { createLogger } from "@racso/core";
import { clearPrompt, input, printImage, printLogo, restorePrompt } from "@/terminal/stdin";
import { formatSpawnOutcome, formatTurnOutcome } from "./outcome";
import type { UiAdapter, UiEvent, UiStatus } from "./UiAdapter";

// Formats the status bar line shared by both renderers.
export const formatStatusBar = (status: UiStatus): string => {
  const parts: string[] = [];

  if (status.provider) parts.push(`provider: ${status.provider}`);
  if (status.model) parts.push(`model: ${status.model}`);
  if (status.agent) parts.push(`agent: ${status.agent}`);
  if (status.tokens != null) parts.push(`tokens: ${status.tokens}`);
  if (status.costUsd != null) parts.push(`cost: $${status.costUsd.toFixed(4)}`);

  return parts.join(" · ");
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
        const closing = formatTurnOutcome(event.outcome);
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

  // The line renderer leaves the terminal as the prompt owns it.
  close() {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  }
}

export { CliUiAdapter };
