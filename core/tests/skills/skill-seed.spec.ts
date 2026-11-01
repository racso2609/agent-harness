import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundledSkillsDir, ensureSkillsDir } from "../../src/skills/seed";

const dirs: string[] = [];

const makeDir = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-skill-seed-"));
	dirs.push(dir);
	return dir;
};

const makeSource = (files: Record<string, string>) => {
	const dir = makeDir();
	for (const [name, content] of Object.entries(files)) {
		fs.writeFileSync(path.join(dir, name), content, "utf8");
	}
	return dir;
};

afterEach(() => {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
	dirs.length = 0;
});

describe("ensureSkillsDir", () => {
	it("copies every markdown file into an empty target", () => {
		const source = makeSource({ "a.md": "one", "b.md": "two" });
		const target = path.join(makeDir(), "skills");

		expect(ensureSkillsDir(target, source)).toBe(true);
		expect(fs.readdirSync(target).sort()).toEqual(["a.md", "b.md"]);
	});

	it("leaves a target that already has skills untouched", () => {
		const source = makeSource({ "a.md": "one" });
		const target = makeDir();
		fs.writeFileSync(path.join(target, "mine.md"), "keep me", "utf8");

		expect(ensureSkillsDir(target, source)).toBe(false);
		expect(fs.readdirSync(target)).toEqual(["mine.md"]);
		expect(fs.readFileSync(path.join(target, "mine.md"), "utf8")).toBe(
			"keep me",
		);
	});

	it("does nothing without a target", () => {
		expect(ensureSkillsDir("", makeSource({ "a.md": "one" }))).toBe(false);
	});

	it("does nothing when the source has no skills", () => {
		const target = path.join(makeDir(), "skills");

		expect(ensureSkillsDir(target, makeDir())).toBe(false);
		expect(fs.existsSync(target)).toBe(false);
	});

	it("ships the frontend-design example", () => {
		const files = fs.readdirSync(bundledSkillsDir());

		expect(files).toContain("frontend-design.md");
	});
});
