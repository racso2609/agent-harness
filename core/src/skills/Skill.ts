export interface Skill {
  // Canonical id, derived from the directory name or the file name.
  id: string;
  // Human-readable name shown in listings.
  name: string;
  // One-line summary injected in the system prompt index.
  description: string;
  // Free-form tags for future filtering.
  tags?: string[];
  // Phrases that hint the model should load this skill.
  triggers?: string[];
  // Markdown body, handed to the model only through the use_skill tool.
  body: string;
  // Origin file, useful for diagnostics.
  source?: string;
}

// What the system prompt and the CLI listings need: everything but the body.
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  source?: string;
}
