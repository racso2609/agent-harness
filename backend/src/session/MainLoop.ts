import { input, printImage, printLogo } from "@/utils/stdin";
import { logger } from "@/utils/logger";
import { formatSessionStatus } from "@/utils/status";
import { Config } from "@/configuration";
import { CommandContext, CommandRepository } from "@/commands/CommandRepository";
import { SessionManager } from "./SessionManager";
import { SessionStore } from "./SessionStore";

interface MainLoopOptions {
  // Persistence layer shared with the session manager.
  store?: SessionStore;
  // Id of a previously persisted session to resume on boot.
  sessionId?: string;
  // Agent to use when starting a new session.
  agent?: string;
  // Configuration source; defaults to a new Config.
  config?: Config;
}

class MainLoop {
  session: SessionManager;
  store: SessionStore;
  config: Config;
  commands: CommandRepository;
  // Guard so the shutdown handler runs only once.
  private closing = false;

  constructor(options: MainLoopOptions = {}) {
    this.config = options.config ?? new Config();
    this.store = options.store ?? new SessionStore();
    this.session = new SessionManager(this.config, this.store);
    this.commands = new CommandRepository();
  }

  // Boots the session, wiring key handling and running the prompt loop.
  // Runs the interactive config setup first when no provider is configured.
  async start(options: MainLoopOptions = {}) {
    if (!this.config.setupComplete()) {
      logger.info("No provider configured, starting setup");
      await this.config.startSetup();
    }

    await this.session.initialize({
      sessionId: options.sessionId,
      agent: options.agent,
      store: this.store,
    });

    this.printStatus();
    this.installKeyHandlers();
    await this.loop();
  }

  // Ctrl-C triggers cleanup and exit; Ctrl-L redraws the screen.
  protected installKeyHandlers() {
    process.on("SIGINT", () => this.shutdown(130));
  }

  // Main prompt loop: reads, dispatches to the session and renders output.
  protected async loop() {
    while (true) {
      const prompt = (
        await input("Type your prompt: ", { commands: this.commands.list() })
      ).trim();
      if (!prompt) continue;

      if (prompt.startsWith("/")) {
        const handled = await this.commands.run(
          prompt,
          this.commandContext(),
        );
        if (!handled) {
          logger.warn(`Unknown command: ${prompt}. Type /help for a list.`);
        }
        continue;
      }

      try {
        const { text, images } = await this.session.ask(prompt);
        if (text) logger.info(text);
        for (const image of images ?? []) {
          const base64 = image.url.split(",").pop() ?? image.url;
          await printImage(base64);
        }
        this.printStatus();
      } catch (err) {
        logger.error({ err }, "failed to handle prompt");
      }
    }
  }

  protected printStatus() {
    logger.info(formatSessionStatus(this.session.status()));
  }

  // Dependencies exposed to slash command handlers.
  protected commandContext(): CommandContext {
    return {
      session: this.session,
      exit: () => this.shutdown(0),
      clear: () => this.cleanup(),
      notify: (message) => logger.info(message),
      help: () => this.commands.helpText(),
    };
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
      this.session.save();
    } catch (err) {
      logger.debug({ err }, "failed to persist session on shutdown");
    }

    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(code);
  }
}

export { MainLoop };
export type { MainLoopOptions };
