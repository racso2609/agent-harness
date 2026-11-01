import type { Skill, SkillSummary } from "./Skill";

const ELLIPSIS = "…";

const truncate = (text: string, maxChars: number): string => {
	const value = text.trim();
	if (maxChars <= 0) return "";
	if (value.length <= maxChars) return value;
	if (maxChars === 1) return ELLIPSIS;

	return `${value.slice(0, maxChars - 1).trimEnd()}${ELLIPSIS}`;
};

class SkillRegistry {
	protected skills = new Map<string, Skill>();

	constructor(skills: Skill[] = []) {
		for (const skill of skills) this.register(skill);
	}

	// Registers (or replaces) a skill, normalizing its id.
	register(skill: Skill) {
		const id = skill.id.trim().toLowerCase();
		if (!id) throw new Error("Skill id is required");

		this.skills.set(id, { ...skill, id });
	}

	get(id?: string) {
		if (!id) return undefined;
		return this.skills.get(id.trim().toLowerCase());
	}

	has(id: string) {
		return Boolean(this.get(id));
	}

	list(): Skill[] {
		return [...this.skills.values()].sort((left, right) =>
			left.id.localeCompare(right.id),
		);
	}

	summaries(): SkillSummary[] {
		return this.list().map(({ id, name, description, tags, source }) => {
			const summary: SkillSummary = { id, name, description };
			if (tags) summary.tags = tags;
			if (source) summary.source = source;
			return summary;
		});
	}

	// One-line index for the system prompt. Empty when there are no skills,
	// so callers can skip the whole block.
	indexText(maxChars = 160): string {
		return this.list()
			.map(
				(skill) => `- ${skill.id} — ${truncate(skill.description, maxChars)}`,
			)
			.join("\n");
	}
}

export { SkillRegistry };
