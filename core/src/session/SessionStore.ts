import fs from "node:fs";
import path from "node:path";
import { env, harnessHome } from "@/utils/env";
import { History } from "@/types/providers";
import type { SpawnHandle } from "@/session/spawn";
import type { SessionUsage } from "@/types/session";

const SESSION_VERSION = 4;

export interface SessionRecord {
  version?: number;
  id: string;
  // Creation timestamp (ISO string).
  createdAt: string;
  // Last activity timestamp (ISO string).
  updatedAt: string;
  // Provider name as keyed in the config.
  provider: string;
  // Active model id.
  model: string;
  // Agent definition used by the session.
  agentId?: string;
  // Parent session id when this record is a background-spawned child.
  parentId?: string;
  // Conversation history, restored into the provider on resume.
  history: History[];
  // Accumulated token usage for the session.
  usage?: SessionUsage;
  // Accumulated cost in USD for the session.
  costUsd?: number;
  // Background children this session launched, in launch order. Restored as
  // read-only history: a resumed session cannot reattach to them.
  spawns?: SpawnHandle[];
  // Ids of the children above whose result already entered a parent turn.
  // A settled child missing from this list is still owed to the parent and
  // is queued again on resume; one listed here is never delivered twice.
  deliveredSpawns?: string[];
}

const DEFAULT_SESSIONS_DIR = path.join(harnessHome(), "sessions");

class SessionStore {
  sessionsLocation: string;

  constructor(location?: string) {
    this.sessionsLocation = location ?? env.RACSO_HARNESS_SESSIONS_LOCATION ?? DEFAULT_SESSIONS_DIR;
  }

  // Persists a session record, overwriting any previous version with same id.
  save(record: SessionRecord) {
    fs.mkdirSync(this.sessionsLocation, { recursive: true });
    fs.writeFileSync(
      this.filePath(record.id),
      JSON.stringify({ ...record, version: SESSION_VERSION }, null, 2),
      "utf8",
    );
  }

  // Loads a single session by id, or null when missing/invalid.
  load(id: string): SessionRecord | null {
    try {
      const raw = fs.readFileSync(this.filePath(id), "utf8");
      const record = JSON.parse(raw) as SessionRecord;

      // v1 used the system role for assistant replies; later versions keep
      // system messages (agent persona, compacted memory) intact.
      if ((record.version ?? 1) < 2) {
        record.history = (record.history ?? []).map((message) =>
          message.role === "system" ? { ...message, role: "assistant" as const } : message,
        );
      }

      // v4 added the spawn history. Older records simply have none; normalising
      // here keeps callers from branching on the version.
      // The spawn summary and durationMs are optional additions over v4: a record
      // written before them simply lacks the keys, which is the same shape as a
      // child that has not settled, so no version bump or migration is needed.
      // deliveredSpawns is additive in the same way: an older record only
      // carries the child result inside history, so it reads as "nothing
      // delivered" and a settled child without a matching system message is
      // queued again.
      // resultChars is additive too: it is set only when the child report exceeded
      // the delivery budget, so its absence reads as "the report fitted". The report
      // artifact is an idempotent derivative of the persisted result, written under a
      // path derived from the session id and the spawn id, so a record without its
      // artifact heals itself on the next delivery and nothing needs migrating.
      record.spawns ??= [];
      record.deliveredSpawns ??= [];

      return record;
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
  // Deletes the session record only. The report artifacts of its children live
  // in the workspace (<workspace>/.racso-harness/artifacts/<id>/) and are NOT
  // removed here: known debt, since a path already published to the parent in a
  // delivered message would otherwise dangle.
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
