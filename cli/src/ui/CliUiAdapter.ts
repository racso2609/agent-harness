import type {
  ApprovalDecision,
  ApprovalRequest,
  ILogger,
  LoggerSink,
} from "@racso/core";
import { createLogger } from "@racso/core";
import { clearPrompt, input, printImage, printLogo, restorePrompt } from "@/terminal/stdin";

// Single rendering surface for the CLI. It owns the prompt-safe sink used by
// the core logger, the approval prompt and image rendering, so no other
// module has to know about cursor state.
class CliUiAdapter {
  // Writes a line above the prompt without clobbering what the user typed.
  notify(message: string) {
    clearPrompt();
    process.stdout.write(`${message}\n`);
    restorePrompt();
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
        `Allow ${request.tool} [${request.kind}] ${request.subject}? ` +
          `[y/N/a=always] `,
      )
    ).trim();

    if (/^a(lways)?$/i.test(answer)) return "always";
    return /^y(es)?$/i.test(answer) ? "allow" : "deny";
  }
}

export { CliUiAdapter };
