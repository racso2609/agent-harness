import type { Tool, ToolContext, ToolResult } from "./Tool";

// Hands the full body of a skill to the model. Only the index lives in the
// system prompt; the body is loaded on demand so long recipes cost nothing
// until the task actually matches.
class UseSkillTool implements Tool {
	name = "use_skill";
	description =
		"Load the full content of a skill by id. Call it when the current task matches one of the skills listed in the system prompt.";
	parameters = {
		type: "object" as const,
		properties: {
			id: {
				type: "string" as const,
				description: "Skill id to load, as listed in the system prompt.",
			},
		},
		required: ["id"],
		additionalProperties: false,
	};

	async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
		const input = args as { id?: unknown } | null | undefined;
		if (typeof input?.id !== "string" || !input.id.trim()) {
			return {
				output: "use_skill expects a non-empty 'id' string",
				isError: true,
			};
		}

		if (!ctx.getSkillBody) {
			return {
				output: "Skills are not available in this session",
				isError: true,
			};
		}

		const id = input.id.trim().toLowerCase();
		const body = ctx.getSkillBody(id);
		if (body === undefined) {
			const available = ctx.listSkillIds?.() ?? [];
			const list = available.length ? available.join(", ") : "none";

			return {
				output: `Unknown skill: ${id}\nAvailable: ${list}`,
				isError: true,
			};
		}

		return { output: body };
	}
}

export { UseSkillTool };
