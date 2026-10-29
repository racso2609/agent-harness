import { input, printImage, printLogo } from "@/utils/stdin";
import { logger } from "@/utils/logger";
import { Config } from "@/configuration";
import { SessionManager } from "./SessionManager";
import { SessionStore } from "./SessionStore";

interface MainLoopOptions {
  // Persistence layer shared with the session manager.
  store?: SessionStore;
  // Id of a previously persisted session to resume on boot.
  sessionId?: string;
  // Configuration source; defaults to a new Config.
  config?: Config;
}

class MainLoop {
  session: SessionManager;
  store: SessionStore;
  config: Config;
  // Guard so the shutdown handler runs only once.
  private closing = false;

  constructor(options: MainLoopOptions = {}) {
    this.config = options.config ?? new Config();
    this.store = options.store ?? new SessionStore();
    this.session = new SessionManager(this.config, this.store);
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
      store: this.store,
    });

    this.installKeyHandlers();
    await this.loop();
  }

  // Ctrl-C triggers cleanup and exit; Ctrl-L redraws the screen.
  protected installKeyHandlers() {
    process.stdin.setRawMode(true);
    process.stdin.resume();

    process.stdin.on("data", (buf) => {
      const char = buf.toString().charCodeAt(0);
      if (char === 0x03) this.shutdown(0);
      if (char === 0x0c) this.cleanup();
    });

    process.on("SIGINT", () => this.shutdown(130));
  }

  // Main prompt loop: reads, dispatches to the session and renders output.
  protected async loop() {
    while (true) {
      const prompt = (await input("Type your prompt: ")).trim();
      if (!prompt) continue;
      if (prompt === "/exit" || prompt === "/quit") this.shutdown(0);

      try {
        const { text, images } = await this.session.ask(prompt);
        if (text) logger.info(text);
        for (const image of images ?? []) {
          const base64 = image.url.split(",").pop() ?? image.url;
          await printImage(base64);
        }
      } catch (err) {
        logger.error({ err }, "failed to handle prompt");
      }
    }
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
