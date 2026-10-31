import fs from "node:fs";
import path from "node:path";
import { agentsHome } from "@/utils/env";
import { logger } from "@/utils/logger";
import { AgentRegistry } from "./AgentRegistry";
import { builtInDefaultAgent } from "./defaults";
import { parseAgentFile } from "./parseAgentFile";

class AgentLoader {
  directory: string;

  constructor(directory = agentsHome()) {
    this.directory = directory;
  }

  // Loads every .md definition in the agents directory over the built-in
  // default. Invalid files are logged and skipped so boot never fails.
  load(): AgentRegistry {
    const registry = new AgentRegistry([builtInDefaultAgent()]);
    if (!fs.existsSync(this.directory)) return registry;

    const files = fs
      .readdirSync(this.directory)
      .filter((name) => name.toLowerCase().endsWith(".md"))
      .sort();

    for (const file of files) {
      const source = path.join(this.directory, file);
      const id = path.basename(file, path.extname(file)).toLowerCase();

      try {
        const raw = fs.readFileSync(source, "utf8");
        const { definition, errors } = parseAgentFile(raw, id);

        if (!definition) {
          logger.warn(
            `Skipping agent ${file}: ${errors.join("; ") || "invalid definition"}`,
          );
          continue;
        }

        registry.register({ ...definition, source });
      } catch (err) {
        logger.warn({ err }, `Failed to load agent ${file}`);
      }
    }

    return registry;
  }
}

export { AgentLoader };