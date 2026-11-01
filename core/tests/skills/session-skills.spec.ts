import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/configuration";
import { OpenAiProvider } from "../../src/providers/openai";
import { SessionManager } from "../../src/session/SessionManager";
import type { SessionStore } from "../../src/session/SessionStore";

const SKILL = `---
name: Deploy
description: How to ship a release.
---

Run the smoke tests, then tag.`;

const makeConfig = (overrides: Record<string, unknown> = {}) => {
	const config = { providers: {}, ...overrides };

	return {
		config,
		listProviders: () => Object.keys(config.providers),
		listProviderDetails: () => [],
		configureProvider: vi.fn(),
		removeProvider: vi.fn(),
		writeConfig: vi.fn(),
	} as unknown as Config;
};

const makeStore = () =>
	({
		save: vi.fn(),
		load: vi.fn(() => null),
		list: vi.fn(() => []),
	}) as unknown as SessionStore;



let skillsDir: string;

beforeEach(() => {
	skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "racso-session-skills-"));
});

afterEach(() => {
	fs.rmSync(skillsDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

const writeSkill = (id: string, content = SKILL) => {
	const dir = path.join(skillsDir, id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf8");
};

// Builds an initialized session. Tools and prompt are applied by initialize;
// the provider is stubbed so no network call happens.
const makeSession = async (
	overrides: Record<string, unknown> = {},
	agentTools?: string[],
) => {
	vi.spyOn(OpenAiProvider.prototype, "initialize").mockResolvedValue();
	vi.spyOn(OpenAiProvider.prototype, "getModel").mockReturnValue("model");

	const config = makeConfig({
		defaultProvider: "openai",
		model: "model",
		providers: { openai: { url: "http://localhost", apikey: "k" } },
		skills: { dirs: [skillsDir] },
		...overrides,
	});

	const session = new SessionManager(config, makeStore());
	await session.initialize();
	if (agentTools) {
		// setAgent rebuilds the tools with the agent allowlist.
		session.agentRegistry.register({
			id: "limited",
			name: "Limited",
			personality: "Read only.",
			tools: agentTools,
		});
		expect(await session.setAgent("limited")).toBe(true);
	}
	return session;
};

const toolNames = (session: SessionManager) =>
	session.tools.list().map((tool) => tool.name);

describe("SessionManager skills", () => {
	it("injects the skill index into the system prompt", async () => {
		writeSkill("deploy");
		const session = await makeSession();

		const prompt = session.history[0].content as string;
		expect(prompt).toContain("## Skills");
		expect(prompt).toContain("- deploy — How to ship a release.");
		expect(prompt).not.toContain("Run the smoke tests");
	});

	it("keeps the prompt free of skills when there are none", async () => {
		const session = await makeSession();

		const prompt = session.history[0].content as string;
		expect(prompt).not.toContain("## Skills");
	});

	it("keeps the prompt free of skills when disabled", async () => {
		writeSkill("deploy");
		const session = await makeSession({ skills: { enabled: false, dirs: [skillsDir] } });

		expect(session.history[0].content as string).not.toContain("## Skills");
		expect(toolNames(session)).not.toContain("use_skill");
	});

	it("offers use_skill when the agent declares no allowlist", async () => {
		writeSkill("deploy");
		const session = await makeSession();

		expect(toolNames(session)).toContain("use_skill");
	});

	it("does not offer use_skill when the agent declares an allowlist", async () => {
		writeSkill("deploy");
		const session = await makeSession({}, ["readFile"]);

		expect(toolNames(session)).toEqual(["readFile"]);
	});

	it("returns the body through use_skill", async () => {
		writeSkill("deploy");
		const session = await makeSession();

		const result = await session.tools.execute(session["toolContext"](), {
			id: "call-1",
			name: "use_skill",
			args: { id: "deploy" },
		});

		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("Run the smoke tests, then tag.");
	});

	it("lists the available ids for an unknown skill", async () => {
		writeSkill("deploy");
		const session = await makeSession();

		const result = await session.tools.execute(session["toolContext"](), {
			id: "call-1",
			name: "use_skill",
			args: { id: "nope" },
		});

		expect(result.isError).toBe(true);
		expect(result.output).toContain("Unknown skill: nope");
		expect(result.output).toContain("deploy");
	});

	it("lists skills without bodies", async () => {
		writeSkill("deploy");
		const session = await makeSession();

		expect(session.listSkills()).toEqual([
			{
				id: "deploy",
				name: "Deploy",
				description: "How to ship a release.",
				source: path.join(skillsDir, "deploy", "SKILL.md"),
			},
		]);
	});

	it("reload picks up a new skill and refreshes the prompt once", async () => {
		const session = await makeSession();
		expect(session.history[0].content as string).not.toContain("## Skills");

		writeSkill("deploy");
		const summaries = session.reloadSkills();

		expect(summaries.map((skill) => skill.id)).toEqual(["deploy"]);

		const systems = session.history.filter((m) => m.role === "system");
		expect(systems).toHaveLength(1);
		expect(systems[0].content as string).toContain("## Skills");
	});
});
