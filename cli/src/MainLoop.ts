import {
  Config,
  createHarness,
  type ApprovalRequest,
  type IHarness,
} from "@racso/core";
import { CommandContext, CommandRepository } from "@/commands/CommandRepository";
import { createFlows, type Flows } from "@/flows";
import { startSetup } from "@/flows/startSetup";
import { formatSessionStatus } from "@/render/status";
import { input } from "@/terminal/stdin";
import { CliUiAdapter } from "@/ui/CliUiAdapter";

interface MainLoopOptions {
  // Id of a previously persisted session to resume on boot.
  sessionId?: string;
  // Agent to use when starting a new session.
  agent?: string;
  // Configuration source; defaults to a new Config.
  config?: Config;
}

class MainLoop {
  harness: IHarness;
  config: Config;
  flows: Flows;
  commands: CommandRepository;
  ui: CliUiAdapter;
  // Guard so the shutdown handler runs only once.
  private closing = false;

  constructor(options: MainLoopOptions = {}) {
    this.config = options.config ?? new Config();
    this.flows = createFlows();
    this.commands = new CommandRepository();
    this.ui = new CliUiAdapter();
    this.harness = createHarness({
      config: this.config,
      logger: this.ui.logger(),
      approval: (request: ApprovalRequest) => this.ui.promptApproval(request),
    });
  }

  // Boots the session, wiring key handling and running the prompt loop.
  // Runs the interactive config setup first when no provider is configured.
  async start(options: MainLoopOptions = {}) {
    if (this.config.needsSetup()) {
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
          this.ui.notify(`Unknown command: ${prompt}. Type /help for a list.`);
        }
        continue;
      }

      try {
        const { text, images } = await this.harness.ask(prompt);
        if (text) this.ui.notify(text);
        for (const image of images ?? []) {
          await this.ui.renderImage(image.url);
        }
        this.printStatus();
      } catch (err) {
        this.ui.notify(`failed to handle prompt: ${String(err)}`);
      }
    }
  }

  protected printStatus() {
    this.ui.notify(formatSessionStatus(this.harness.status()));
  }

  // Dependencies exposed to slash command handlers.
  protected commandContext(): CommandContext {
    return {
      harness: this.harness,
      flows: this.flows,
      exit: () => this.shutdown(0),
      clear: () => this.ui.reset(),
      notify: (message) => this.ui.notify(message),
      help: () => this.commands.helpText(),
    };
  }

  // Persists the session, restores the terminal and exits.
  protected shutdown(code: number) {
    if (this.closing) return;
    this.closing = true;

    try {
      this.harness.shutdown();
    } catch (err) {
      this.ui.notify(`failed to persist session on shutdown: ${String(err)}`);
    }

    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(code);
  }
}

export { MainLoop };
export type { MainLoopOptions };
