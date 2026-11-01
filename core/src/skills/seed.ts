import fs from "node:fs";
import path from "node:path";

// Directory shipped with the package holding the example skill definitions.
// Both the source layout (src/skills/seed.ts) and the build output
// (dist/skills/seed.js) sit two levels below the package root, so the same
// relative hop resolves in both.
export const bundledSkillsDir = () =>
	path.join(import.meta.dirname, "..", "..", "skills");

const listMarkdown = (dir: string) => {
	try {
		return fs
			.readdirSync(dir)
			.filter((name) => name.toLowerCase().endsWith(".md"))
			.sort();
	} catch {
		return [];
	}
};

// Seeds the runtime skills directory with the bundled examples. Like the
// agent seed, it only runs on a clean install: a target that already holds at
// least one definition is left untouched so user skills are never overwritten.
export const ensureSkillsDir = (
	target = "",
	source = bundledSkillsDir(),
): boolean => {
	if (!target) return false;
	// Skip only when the target already holds a markdown *definition*. An
	// existing but still empty directory is a clean install too, and copying
	// into it would otherwise never happen on a first run.
	if (listMarkdown(target).length) return false;
	if (fs.existsSync(target) && fs.readdirSync(target).length) return false;

	const files = listMarkdown(source);
	if (!files.length) return false;

	fs.mkdirSync(target, { recursive: true });

	for (const file of files) {
		fs.copyFileSync(path.join(source, file), path.join(target, file));
	}

	return true;
};
