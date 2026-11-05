import type { UiRoleStyle, UiTheme } from "@racso2609/core";

// Visual roles the TUI can style. One role per kind of content, so the user
// can tell at a glance who said what.
export type Role = "user" | "reasoning" | "tool" | "answer" | "notice";

export type Theme = Record<Role, UiRoleStyle>;

// Defaults mirror core/ui.theme so the CLI still looks right when the config
// predates the ui block. Reasoning is the dimmest and the answer the
// brightest: that hierarchy is what makes the stream readable.
export const DEFAULT_THEME: Theme = {
  user: { color: "cyan" },
  reasoning: { color: "gray", dim: true },
  tool: { color: "yellow" },
  answer: { bold: true },
  notice: { color: "gray", dim: true },
};

// Merges a configured theme over the defaults, role by role.
export const resolveTheme = (theme?: UiTheme): Theme => {
  const merged = { ...DEFAULT_THEME };

  if (!theme) return merged;

  for (const role of Object.keys(DEFAULT_THEME) as Role[]) {
    const style = theme[role];
    if (style) merged[role] = { ...DEFAULT_THEME[role], ...style };
  }

  return merged;
};

// Prefix that identifies the speaker without relying on colour alone, so the
// transcript still reads correctly with no colour support.
export const GLYPH: Record<Role, string> = {
  user: "› ",
  reasoning: "~ ",
  tool: "⏵ ",
  answer: "",
  notice: "· ",
};
