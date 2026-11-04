import type { CommandOption } from "@/commands/CommandRepository";
import {
COMMAND_KEYS,
clampSelection,
menuItems,
menuQueryFor,
moveSelection,
type MenuRows,
type MenuState,
} from "./commandMenu";

// Everything the "/" menu of the prompt needs to be understood without a
// terminal attached: what still has not been read of the input, the draft, and
// whether the dropdown is open with which row highlighted. Keeping the keys
// here, as a pure reducer, is what makes them testable at all: inside `onData`
// they only ever existed behind `process.stdin` in raw mode.
export interface PromptMenuState {
// Read but not acted on yet: the start of an escape sequence whose arrow key
// has not arrived whole.
pending: string;
// What the user has typed and not sent yet.
draft: string;
// How many chars of the input this state has already consumed.
read: number;
// The highlighted row, or null when the dropdown is shut.
selected: number | null;
commands: CommandOption[];
// False when there is no terminal to paint the dropdown on: typing "/" must
// then stay plain text, as it always did for piped input.
enabled: boolean;
}

// What the caller must do with the new state. `exit` is kept apart from the
// rest because it leaves the prompt without a value, like Ctrl-C always did.
export type PromptMenuAction =
| { kind: "render" }
| { kind: "submit"; value: string }
| { kind: "exit" }
| { kind: "none" };

export interface PromptMenuResult {
state: PromptMenuState;
action: PromptMenuAction;
}

// The filtered list in the shared shape. The query comes from `menuQueryFor`,
// so the prompt closes the dropdown exactly when the TUI does: after the first
// space the text is arguments, not a command name.
export const promptMenuState = (
draft: string,
selected: number | null,
commands: CommandOption[],
): MenuState<CommandOption> => {
const query = menuQueryFor(draft) ?? "";

return { items: menuItems(query, commands, COMMAND_KEYS), query, selected: selected ?? 0 };
};

// The command the dropdown would act on: the highlighted row, clamped because
// the list shrinks under the cursor as the query grows.
export const promptMenuSelection = (
draft: string,
selected: number | null,
commands: CommandOption[],
): CommandOption | undefined => {
if (selected === null) return undefined;

const state = promptMenuState(draft, selected, commands);

return state.items[clampSelection(state.selected, state.items.length)];
};

// The "3/15" indicator the dropdown paints on its last row, or "" when the
// whole list fits. It lives here, next to the window maths it reads, so the
// line renderer and any test see the same decision instead of each deriving it
// again from the selected index.
export const menuRangeLabel = (
model: MenuState<CommandOption>,
rows: MenuRows<CommandOption>,
): string => {
// An empty list has no row to number, and the renderer shows its own notice.
if (!model.items.length) return "";
// Nothing is out of sight: the usual short list stays free of the counter.
if (!rows.hiddenAbove && !rows.hiddenBelow) return "";

return `${clampSelection(model.selected, model.items.length) + 1}/${model.items.length}`;
};

// One logical key, built from consecutive raw chars so that a split escape
// sequence keeps its meaning instead of leaking "[A" into the draft.
export interface PromptMenuChar {
char: string;
length: number;
}

// The logical key a chunk starts with, or null when the chunk ends in the
// middle of an escape sequence and the rest still has to arrive.
export const promptMenuChar = (text: string): PromptMenuChar | null => {
if (text[0] !== "\u001b") return { char: text[0]!, length: 1 };

// A lone ESC is the Esc key: nothing else came in this chunk.
if (text.length < 2) return { char: "escape", length: 1 };

if (text[1] === "[") {
// The final byte of a CSI sequence is "@".."~"; before it the sequence is
// either still arriving or something this prompt does not understand.
for (let length = 3; length <= text.length; length++) {
const final = text[length - 1]!;
if (final < "@" || final > "~") continue;

const candidate = text.slice(0, length);
if (candidate === "\u001b[A" || candidate === "\u001b[B") {
return { char: final, length };
}
// Horizontal arrows move the cursor inside the line, which this prompt has
// never supported: they are swallowed instead of being typed out.
if (candidate === "\u001b[C" || candidate === "\u001b[D") {
return { char: "left/right", length };
}

// Any other sequence is not a key this prompt knows: it is swallowed rather
// than typed out, and it does not touch the draft.
return { char: "escape", length };
}

return null;
}

// ESC followed by anything else is the Esc key and that char is a key of its
// own, exactly as the handler read it before: only the ESC is consumed here.
return { char: "escape", length: 1 };
};

const reduceKey = (
state: PromptMenuState,
key: PromptMenuChar,
): PromptMenuResult => {
const { char } = key;
const paint = (next: PromptMenuState): PromptMenuResult => ({ state: next, action: { kind: "render" } });

if (char === "\t") {
// Tab completes the highlighted command and closes the menu, so the next
// keystroke writes arguments instead of filtering again.
const command = promptMenuSelection(state.draft, state.selected, state.commands);

return paint({
...state,
draft: command ? `/${command.name} ` : state.draft,
selected: null,
});
}

if (char === "A" || char === "B") {
if (state.selected === null) return { state, action: { kind: "none" } };

const { items } = promptMenuState(state.draft, state.selected, state.commands);

return {
state: {
...state,
selected: moveSelection(state.selected, char === "A" ? -1 : 1, items.length),
},
action: { kind: "render" },
};
}

if (char === "left/right") return { state, action: { kind: "none" } };

// Esc, or a sequence this prompt does not know: the menu closes and the draft
// is left as it is, because the text on screen is the user's.
if (char === "escape") return paint({ ...state, selected: null });

if (char === "\r" || char === "\n") {
const command = promptMenuSelection(state.draft, state.selected, state.commands);

// Nothing matches, so the menu has no answer. Sending the draft beats the
// old dead end, where enter did nothing at all on a query the filter
// rejected.
return {
state: { ...state, selected: null },
action: { kind: "submit", value: command ? `/${command.name}` : state.draft },
};
}

if (char === "\u0003") return { state, action: { kind: "exit" } };

if (char === "\u007f" || char === "\b") {
if (!state.draft.length) return { state, action: { kind: "none" } };

const draft = state.draft.slice(0, -1);
// The deleted char may be the space that opened the menu, so the dropdown
// only survives while the draft is a bare command again.
const open = state.selected !== null && menuQueryFor(draft) !== null;

return paint({ ...state, draft, selected: open ? 0 : null });
}

if (
state.enabled &&
state.selected === null &&
char === "/" &&
state.draft === "" &&
state.commands.length
) {
return paint({ ...state, draft: "/", selected: 0 });
}

if (char >= " ") {
// The space closes the dropdown too: from then on the text is arguments,
// and an open list that filters them covers the transcript for nothing.
const draft = state.draft + char;
const open = state.selected !== null && menuQueryFor(draft) !== null;

return paint({ ...state, draft, selected: open ? 0 : null });
}

return { state, action: { kind: "none" } };
};

// The whole reducer. Consumes every complete logical key from the input plus
// what was pending, and stops at the key that ends the prompt: that one is the
// only consequence that is not "paint the line again".
export const interpretMenuInput = (state: PromptMenuState, text: string): PromptMenuResult => {
const buffer = state.pending + text;
let read = 0;
let current = { ...state, pending: "" };
let action: PromptMenuAction = { kind: "none" };

while (read < buffer.length) {
const key = promptMenuChar(buffer.slice(read));
// A half read escape sequence waits for the next chunk instead of being
// typed out as rubbish.
if (key === null) break;

read += key.length;

const step = reduceKey(current, key);
current = step.state;
action = step.action;

if (action.kind === "submit" || action.kind === "exit") {
return { state: { ...current, pending: "", read: state.read + read }, action };
}
}

return { state: { ...current, pending: buffer.slice(read), read: state.read + read }, action };
};
