import { parseFrontmatter } from "@/agents/parseAgentFile";
import type { Skill } from "./Skill";

export interface ParsedSkillFile {
	skill?: Skill;
	errors: string[];
}

const asString = (value: unknown): string | undefined => {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
};

const asStringList = (value: unknown): string[] | undefined => {
	if (value === undefined) return undefined;
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? [trimmed] : [];
	}
	if (Array.isArray(value)) {
		return value
			.map((item) => (typeof item === "string" ? item.trim() : ""))
			.filter(Boolean);
	}
	return undefined;
};

// Parses a SKILL.md-style markdown file: frontmatter plus a markdown body.
// The id falls back to the directory or file name the skill was found in.
export const parseSkillFile = (
	raw: string,
	fallbackId: string,
): ParsedSkillFile => {
	const { data, body, errors } = parseFrontmatter(raw);
	const id = fallbackId.trim().toLowerCase() || "skill";
	const found = [...errors];

	const name = asString(data.name) ?? id;
	const description = asString(data.description);
	if (!description) found.push("Missing description");

	const trimmedBody = body.trim();
	if (!trimmedBody) found.push("Missing body");

	const tags = asStringList(data.tags);
	if (data.tags !== undefined && tags === undefined) {
		found.push("'tags' must be a string or a list of strings");
	}

	const triggers = asStringList(data.triggers);
	if (data.triggers !== undefined && triggers === undefined) {
		found.push("'triggers' must be a string or a list of strings");
	}

	if (found.length || !description) return { errors: found };

	const skill: Skill = { id, name, description, body: trimmedBody };
	if (tags?.length) skill.tags = tags;
	if (triggers?.length) skill.triggers = triggers;

	return { skill, errors: [] };
};
