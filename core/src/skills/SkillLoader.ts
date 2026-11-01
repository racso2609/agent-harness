import fs from "node:fs";
import path from "node:path";
import { skillsHome } from "@/utils/env";
import { logger } from "@/utils/logger";
import { parseSkillFile } from "./parseSkillFile";
import { SkillRegistry } from "./SkillRegistry";

const SKILL_FILE = "SKILL.md";

// Loads skill definitions from one or more directories. Two layouts are
// supported: `<dir>/<id>/SKILL.md` and `<dir>/<id>.md`. Earlier directories
// win on id clashes; within a directory SKILL.md wins over <id>.md.
// Invalid or unreadable entries are logged and skipped so boot never fails.
class SkillLoader {
	dirs: string[];

	constructor(dirs: string[] = [skillsHome()]) {
		this.dirs = dirs;
	}

	load(): SkillRegistry {
		const registry = new SkillRegistry();

		for (const dir of this.dirs) {
			for (const candidate of this.candidates(dir)) {
				const id = candidate.id.trim().toLowerCase();
				if (!id || registry.has(id)) continue;

				try {
					const raw = fs.readFileSync(candidate.source, "utf8");
					const { skill, errors } = parseSkillFile(raw, id);

					if (!skill) {
						logger.warn(
							`Skipping skill ${candidate.source}: ${
								errors.join("; ") || "invalid definition"
							}`,
						);
						continue;
					}

					registry.register({ ...skill, source: candidate.source });
				} catch (err) {
					logger.warn({ err }, `Failed to load skill ${candidate.source}`);
				}
			}
		}

		return registry;
	}

	// Lists the skill files of one directory, ordered so SKILL.md is seen
	// before same-named flat files.
	protected candidates(dir: string): { id: string; source: string }[] {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				logger.warn({ err }, `Failed to read skills directory ${dir}`);
			}
			return [];
		}

		const found: { id: string; source: string }[] = [];

		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;

			if (entry.isDirectory()) {
				const source = path.join(dir, entry.name, SKILL_FILE);
				if (!fs.existsSync(source)) continue;
				found.push({ id: entry.name, source });
				continue;
			}

			if (!entry.isFile()) continue;
			if (!entry.name.toLowerCase().endsWith(".md")) continue;

			const source = path.join(dir, entry.name);
			if (entry.name === SKILL_FILE) continue;
			found.push({ id: path.basename(entry.name, path.extname(entry.name)), source });
		}

		return found.sort((left, right) => {
			const leftNested = path.basename(left.source) === SKILL_FILE;
			const rightNested = path.basename(right.source) === SKILL_FILE;
			if (leftNested !== rightNested) return leftNested ? -1 : 1;
			return left.id.localeCompare(right.id);
		});
	}
}

export { SkillLoader };
