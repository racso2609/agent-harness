import {
  Config,
  createHarness,
  createLogger,
  type ApprovalRequest,
  type IHarness,
} from "@racso/core";
import { CommandContext, CommandRepository } from "@/commands/CommandRepository";
import { createFlows, type Flows } from "@/flows";
import { startSetup } from "@/flows/startSetup";
import { formatSessionStatus } from "@/render/status";
import { clearPrompt, input, printImage, printLogo, restorePrompt } from "@/terminal/stdin";

interface MainLoopOptions {
  // Id of a previously persisted session to resume on boot.
  sessionId?: string;
  // Agent to use when starting a new session.
  agent?: string;
  // Configuration source; defaults to a new Config.
  config?: Config;
}

// Renders one log line without clobbering the prompt the user is typing.
const annotateLogger = () => {
  const sink = (line: string) => {
    clearPrompt();
    process.stderr.write(`${line}\n`);
    restorePrompt();
  };
  return createLogger(sink);
};

class MainLoop {
  harness: IHarness;
  config: Config;
  flows: Flows;
  commands: CommandRepository;
  // Guard so the shutdown handler runs only once.
  private closing = false;

  constructor(options: MainLoopOptions = {}) {
    this.config = options.config ?? new Config();
    this.flows = createFlows();
    this.commands = new CommandRepository();
    this.harness = createHarness({
      config: this.config,
      logger: annotateLogger(),
      approval: (request: ApprovalRequest) =>
        this.flows.promptApproval(request),
    });
  }

  // Boots the session, wiring key handling and running the prompt loop.
  // Runs the interactive config setup first when no provider is configured.
  async start(options: MainLoopOptions = {}) {
    if (this.config.needsSetup()) {
      this.harness.status();
      await startSetup(this.config);
    }

    await this.harness.initialize({
      sessionId: options.sessionId,
      agent: options.agent,
    });

    this.printStatus();
    this.installKeyHandlers();
    await this.loop();
  }

  // Ctrl-C triggers cleanup and exit.
  protected installKeyHandlers() {
    process.on("SIGINT", () => this.shutdown(130));
  }

  // Main prompt loop: reads, dispatches to the harness and renders output.
  protected async loop() {
    while (true) {
      const prompt = (
        await input("Type your prompt: ", { commands: this.commands.list() })
      ).trim();
      if (!prompt) continue;

      if (prompt.startsWith("/")) {
        const handled = await this.commands.run(prompt, this.commandContext());
        if (!handled) {
          process.stderr.write(
            `Unknown command: ${prompt}. Type /help for a list.\n`,
          );
        }
        continue;
      }

      try {
        const { text, images } = await this.harness.ask(prompt);
        if (text) this.notify(text);
        for (const image of images ?? []) {
          const base64 = image.url.split(",").pop() ?? image.url;
          await printImage(base64);
        }
        this.printStatus();
      } catch (err) {
        process.stderr.write(`failed to handle prompt: ${String(err)}\n`);
      }
    }
  }

  protected printStatus() {
    this.notify(formatSessionStatus(this.harness.status()));
  }

  // Dependencies exposed to slash command handlers.
  protected commandContext(): CommandContext {
    return {
      harness: this.harness,
      flows: this.flows,
      exit: () => this.shutdown(0),
      clear: () => this.cleanup(),
      notify: (message) => this.notify(message),
      help: () => this.commands.helpText(),
    };
  }

  // Writes a line above the prompt without corrupting it.
  protected notify(message: string) {
    clearPrompt();
    process.stdout.write(`${message}\n`);
    restorePrompt();
  }

  // Clears the screen and redraws the logo without losing session state.
  protected cleanup() {
    process.stdout.write("\x1Bc");
    printLogo();
  }

  // Persists the session, restores the terminal and exits.
  protected shutdown(code: number) {
    if (this.closing) return;
    this.closing = true;

    try {
      this.harness.shutdown();
    } catch (err) {
      process.stderr.write(`failed to persist session on shutdown: ${String(err)}\n`);
    }

    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(code);
  }
}

export { MainLoop };
export type { MainLoopOptions };
