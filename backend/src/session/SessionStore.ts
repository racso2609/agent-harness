import fs from "node:fs";
import path from "node:path";
import { env } from "@/utils/env";
import { History } from "@/types/providers";

export interface SessionRecord {
  // Stable id, also used as the file name.
  id: string;
  // Creation timestamp (ISO string).
  createdAt: string;
  // Last activity timestamp (ISO string).
  updatedAt: string;
  // Provider name as keyed in the config.
  provider: string;
  // Active model id.
  model: string;
  // Conversation history, restored into the provider on resume.
  history: History[];
}

const DEFAULT_SESSIONS_DIR = path.join(
  env.HOME ?? process.cwd(),
  ".racso-harness",
  "sessions",
);

class SessionStore {
  sessionsLocation: string;

  constructor(location?: string) {
    this.sessionsLocation =
      location ?? env.RACSO_HARNESS_SESSIONS_LOCATION ?? DEFAULT_SESSIONS_DIR;
  }

  // Persists a session record, overwriting any previous version with same id.
  save(record: SessionRecord) {
    fs.mkdirSync(this.sessionsLocation, { recursive: true });
    fs.writeFileSync(
      this.filePath(record.id),
      JSON.stringify(record, null, 2),
      "utf8",
    );
  }

  // Loads a single session by id, or null when missing/invalid.
  load(id: string): SessionRecord | null {
    try {
      const raw = fs.readFileSync(this.filePath(id), "utf8");
      return JSON.parse(raw) as SessionRecord;
    } catch {
      return null;
    }
  }

  // Returns all stored sessions, newest activity first.
  list(): SessionRecord[] {
    if (!fs.existsSync(this.sessionsLocation)) return [];

    return fs
      .readdirSync(this.sessionsLocation)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.load(name.replace(/\.json$/, "")))
      .filter((s): s is SessionRecord => Boolean(s))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // Removes a session file.
  remove(id: string) {
    try {
      fs.rmSync(this.filePath(id), { force: true });
      return true;
    } catch {
      return false;
    }
  }

  protected filePath(id: string) {
    return path.join(this.sessionsLocation, `${id}.json`);
  }
}

export { SessionStore };
