import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeSystemPrompt, HARNESS_SYSTEM_PROMPT } from "../../src/agents/defaults";
import { parseSkillFile } from "../../src/skills/parseSkillFile";
import { SkillLoader } from "../../src/skills/SkillLoader";
import { SkillRegistry } from "../../src/skills/SkillRegistry";

const SKILL = `---
name: Deploy Checklist
description: How to ship a release safely.
tags: [ops, release]
---

Run the smoke tests, then tag.`;

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "racso-skills-"));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const writeSkill = (relative: string, content = SKILL) => {
	const target = path.join(root, relative);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content, "utf8");
	return target;
};

describe("parseSkillFile", () => {
	it("parses frontmatter, body and id from the fallback", () => {
		const { skill, errors } = parseSkillFile(SKILL, "Deploy");

		expect(errors).toEqual([]);
		expect(skill).toMatchObject({
			id: "deploy",
			name: "Deploy Checklist",
			description: "How to ship a release safely.",
			tags: ["ops", "release"],
			body: "Run the smoke tests, then tag.",
		});
	});

	it("falls back to the id when the name is missing", () => {
		const raw = `---\ndescription: Something useful.\n---\nBody`;
		const { skill } = parseSkillFile(raw, "fallback");

		expect(skill?.name).toBe("fallback");
	});

	it("rejects a missing description", () => {
		const raw = `---\nname: No description\n---\nBody`;
		const { skill, errors } = parseSkillFile(raw, "broken");

		expect(skill).toBeUndefined();
		expect(errors.join(" ")).toContain("description");
	});

	it("rejects an empty body", () => {
		const raw = `---\ndescription: Nothing behind it.\n---\n\n`;
		const { skill, errors } = parseSkillFile(raw, "empty");

		expect(skill).toBeUndefined();
		expect(errors.join(" ")).toContain("body");
	});

	it("wraps a single tag into a list", () => {
		const raw = `---\ndescription: One tag.\ntags: ops\n---\nBody`;
		const { skill } = parseSkillFile(raw, "single");

		expect(skill?.tags).toEqual(["ops"]);
	});
});

describe("SkillLoader", () => {
	it("loads both layouts", () => {
		writeSkill("nested/SKILL.md");
		writeSkill("flat.md");

		const registry = new SkillLoader([root]).load();

		expect(registry.list().map((skill) => skill.id)).toEqual([
			"flat",
			"nested",
		]);
	});

	it("keeps the first directory on id clashes", () => {
		const first = fs.mkdtempSync(path.join(os.tmpdir(), "racso-first-"));
		try {
			fs.mkdirSync(path.join(first, "clash"));
			fs.writeFileSync(
				path.join(first, "clash", "SKILL.md"),
				`---\ndescription: from first\n---\nBody`,
				"utf8",
			);
			writeSkill("clash/SKILL.md", `---\ndescription: from second\n---\nBody`);

			const registry = new SkillLoader([first, root]).load();

			expect(registry.get("clash")?.description).toBe("from first");
		} finally {
			fs.rmSync(first, { recursive: true, force: true });
		}
	});

	it("prefers SKILL.md over the flat file inside one directory", () => {
		writeSkill("dup/SKILL.md", `---\ndescription: nested wins\n---\nBody`);
		writeSkill("dup.md", `---\ndescription: flat loses\n---\nBody`);

		const registry = new SkillLoader([root]).load();

		expect(registry.get("dup")?.description).toBe("nested wins");
	});

	it("survives a missing directory", () => {
		const registry = new SkillLoader([path.join(root, "nope")]).load();

		expect(registry.list()).toEqual([]);
	});

	it("skips invalid files without failing", () => {
		writeSkill("bad/SKILL.md", `---\nname: no description\n---\nBody`);
		writeSkill("good/SKILL.md");

		const registry = new SkillLoader([root]).load();

		expect(registry.list().map((skill) => skill.id)).toEqual(["good"]);
	});

	it("records the origin file", () => {
		const source = writeSkill("origin/SKILL.md");

		const registry = new SkillLoader([root]).load();

		expect(registry.get("origin")?.source).toBe(source);
	});
});

describe("SkillRegistry", () => {
	it("returns an empty index without skills", () => {
		expect(new SkillRegistry().indexText()).toBe("");
	});

	it("renders one line per skill", () => {
		const registry = new SkillRegistry([
			{ id: "b", name: "B", description: "Second", body: "x" },
			{ id: "a", name: "A", description: "First", body: "x" },
		]);

		expect(registry.indexText()).toBe("- a — First\n- b — Second");
	});

	it("truncates long descriptions to the cap", () => {
		const registry = new SkillRegistry([
			{ id: "long", name: "L", description: "x".repeat(200), body: "x" },
		]);

		const line = registry.indexText(20);
		expect(line.length).toBeLessThanOrEqual(20 + "- long — ".length);
		expect(line.endsWith("…")).toBe(true);
	});

	it("hides the body in summaries", () => {
		const registry = new SkillRegistry([
			{ id: "a", name: "A", description: "First", body: "secret" },
		]);

		expect(registry.summaries()[0]).not.toHaveProperty("body");
	});
});

describe("composeSystemPrompt with skills", () => {
	const agent = { id: "a", name: "A", personality: "Be helpful." };

	it("stays byte-identical without an index", () => {
		const expected = `${HARNESS_SYSTEM_PROMPT}\n\nBe helpful.`;

		expect(composeSystemPrompt(agent, undefined)).toBe(expected);
		expect(composeSystemPrompt(agent, "")).toBe(expected);
		expect(composeSystemPrompt(agent, "   ")).toBe(expected);
	});

	it("appends the skills block at the end", () => {
		const prompt = composeSystemPrompt(agent, "- a — First");

		expect(prompt).toContain("## Skills");
		expect(prompt).toContain("Load with use_skill(id) when the task matches:");
		expect(prompt.trimEnd().endsWith("- a — First")).toBe(true);
		expect(prompt.startsWith(`${HARNESS_SYSTEM_PROMPT}\n\nBe helpful.`)).toBe(
			true,
		);
	});
});
