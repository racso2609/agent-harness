import { Box, Text, useInput, useStdin, useStdout, useWindowSize } from "ink";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CommandOption } from "@/commands/CommandRepository";
import { menuMove, menuRows } from "@/terminal/commandMenu";
import type { SelectionRequest, UiStatus } from "../UiAdapter";
import { formatStatusBar } from "../statusBar";
import type { Block, InlineSpan, StreamDocument, TableBlock } from "./markdown";
import { createHoverStore, parseMouseReports } from "./mouse";
import {
  colorFor,
  elapsedFor,
  iconFor,
  type SpawnEntry,
  type SpawnStripRow,
  spawnStrip,
  stoppable,
  type StripGeometry,
  stripRowAt,
} from "./progress";
import { GLYPH, resolveTheme, type Role, type Theme } from "./theme";
import { collapse } from "./collapse";
import { fitColumns, gapBefore, truncateCell, wrapText } from "./layout";
import { menuCommandLine, menuCompletion, menuQueryFor, menuView } from "./menu";
import {
  bottomView,
  clampView,
  measureEntries,
  scrollBy,
  visibleWindow,
  type ScrollView,
} from "./scroll";
import {
  BORDER_ROWS,
  chromeRows,
  MENU_VISIBLE_ROWS,
  MENU_PANEL_CHROME_Y,
  SELECT_CHROME_Y,
  MOUSE_DISABLE,
  MOUSE_ENABLE,
  MOUSE_HOVER_DISABLE,
  MOUSE_HOVER_ENABLE,
  nextView,
  PANEL_PADDING_X,
  PANEL_PADDING_Y,
  PROMPT_CHROME_Y,
  TRANSCRIPT_CHROME_Y,
  viewportRows,
  wheelScrollLines,
} from "./viewport";

// One rendered entry. `answer` and `reasoning` carry the live markdown
// document; everything else is plain text.
export type TuiLine =
  | { role: "user"; text: string }
  | { role: "notice" | "tool" | "spawn"; text: string }
  | { role: "answer" | "reasoning"; doc: StreamDocument };

export interface TuiApproval {
  tool: string;
  kind: string;
  subject: string;
}

export type TuiSpawn = SpawnEntry;

// A question of a flow waiting for the user. One shape for both kinds so the
// panel and the geometry agree on what is on screen: the adapter never shows
// two, because a flow asks one thing at a time.
export type TuiPrompt =
  | { kind: "text"; message: string; hint?: string; secret?: boolean }
  | { kind: "confirm"; message: string; hint?: string; defaultAnswer?: boolean };

export interface TuiState {
  lines: TuiLine[];
  status: UiStatus;
  activity?: string;
  spawns: TuiSpawn[];
  // Children restored from a previous run: read-only, never ticking.
  history: TuiSpawn[];
  approval?: TuiApproval;
  // Open picker, if any: a "/" flow waiting for the user to choose one option.
  selection?: SelectionRequest;
  // Open question, if any: a "/" flow waiting for text or a yes/no.
  prompt?: TuiPrompt;
  theme: Theme;
  // A turn is in flight: reasoning and tool output preview their tail.
  running?: boolean;
  // Entries the user expanded explicitly.
  expanded: Set<number>;
}

interface AppProps {
  state: TuiState;
  // The slash commands the "/" dropdown offers.
  commands?: CommandOption[];
  onSubmit: (prompt: string) => void;
  onExit: () => void;
  onDecision: (decision: "allow" | "deny" | "always") => void;
  // Answer of the picker: the id chosen, or undefined when it was cancelled.
  // Optional so a caller that never opens one (and the render tests) can leave
  // it out.
  onSelect?: (id: string | undefined) => void;
  // Answer of the open question: the text typed, the yes/no, or undefined when
  // it was cancelled. Optional for the same reason as onSelect.
  onPrompt?: (answer: string | boolean | undefined) => void;
  onToggle: (kind: "reasoning" | "tool", index: number) => void;
  onToggleAll: (kind: "reasoning" | "tool") => void;
  // Reports the text of the input box on every change, including the emptying
  // that follows a send. The owner needs it to know whether the user is
  // half-way through a thought.
  onDraftChange?: (draft: string) => void;
  // Stops a child of this run, called when the user clicks its row on the strip
  // while it is still running. Optional so a caller with nothing to stop (and
  // the render tests) can leave it out: without it a click does nothing.
  // It answers whether the abort was actually delivered (`false` for a child
  // that settled or was restored between the frame on screen and the click), so
  // the owner can say so instead of leaving the click without an answer.
  onCancelSpawn?: (spawnId: string) => boolean;
}

// Columns reserved for the pane border and its horizontal padding.
const PANEL_CHROME = BORDER_ROWS + PANEL_PADDING_X * 2;
// Below this the layout stops shrinking and lets the terminal scroll.
const MIN_WIDTH = 20;

const CHOICES = [
  { key: "allow" as const, label: "allow once" },
  { key: "always" as const, label: "always allow this" },
  { key: "deny" as const, label: "deny" },
];

// Plain text of one entry: what `Line` collapses and what the measurement wraps
// with. Both must agree, otherwise the pane reserves a different number of rows
// than it paints and the transcript jitters while scrolling.
const entryText = (line: TuiLine): string => {
  if (line.role === "answer" || line.role === "reasoning") {
    return [...line.doc.blocks.map((block) => plainBlock(block)), line.doc.open]
      .filter(Boolean)
      .join("\n");
  }

  return (line as Extract<TuiLine, { text: string }>).text;
};

export const App = ({
  state,
  commands,
  onSubmit,
  onExit,
  onDecision,
  onSelect,
  onPrompt,
  onToggle,
  onToggleAll,
  onDraftChange,
  onCancelSpawn,
}: AppProps) => {
  const [draft, setDraft] = useState("");
  // Text typed into the open question. It lives here and not in the owner for
  // the same reason as the draft: every keystroke must repaint the panel.
  const [answer, setAnswer] = useState("");
  const [choice, setChoice] = useState(0);
  // Index picked in the slash dropdown. The query is the draft itself, so only
  // the position has to survive between keystrokes.
  const [menuSelected, setMenuSelected] = useState(0);
  // Query the user closed the dropdown for. It keeps the list shut until they
  // type something else, so Esc does not reopen it on the next keypress.
  const [menuDismissed, setMenuDismissed] = useState<string | null>(null);
  // Option highlighted in the picker. It is a separate index from the
  // dropdown's because the two lists hold different things.
  const [pickSelected, setPickSelected] = useState(0);
  // Every question opens empty: the answer of the previous one says nothing
  // about the one this flow is asking.
  useEffect(() => {
    setAnswer("");
  }, [state.prompt]);
  const [now, setNow] = useState(() => Date.now());
  // Where the transcript is looking. `bottomView()` starts pinned to the bottom,
  // like a shell: the newest line is the first thing the user sees.
  const [view, setView] = useState<ScrollView>(() => bottomView());
  // Every picker opens on its first option: the index of the previous one says
  // nothing about a list the flow just built.
  useEffect(() => {
    setPickSelected(0);
  }, [state.selection]);

  // Latest scroll applier, kept in a ref so the mouse tap installed once can
  // use the current viewport without being re-attached on every render.
  const scrollRef = useRef<(lines: number) => void>(() => {});
  // Latest cancel callback, for the same reason: the tap is installed once and
  // would otherwise reach the prop of the render that installed it forever.
  // It carries the owner's answer back, because a click that stops nothing must
  // not look like one that did.
  const cancelRef = useRef<(spawnId: string) => boolean>(() => false);
  // Which spawn row the pointer is over. The value is written by the mouse tap,
  // outside the React cycle, so it is read through `useSyncExternalStore` and
  // not through component state: a `setState` from the tap would tie every
  // mouse report to a render, and the store only notifies when the row really
  // changes.
  const hover = useRef(createHoverStore());
  const hovered = useSyncExternalStore(hover.current.subscribe, hover.current.get);
  // Fresh copies of what the tap needs to answer "which child is under the
  // pointer": the strip geometry, the ids that can actually be stopped and the
  // rows themselves, so the tap can tell an actionable child from a settled
  // one. Refs for the same reason as `scrollRef`: the tap is installed once and
  // must never read a stale render.
  const geometryRef = useRef<StripGeometry | null>(null);
  const stoppableRef = useRef<Set<string>>(new Set());
  const rowsRef = useRef<SpawnStripRow[]>([]);
  const approval = state.approval;
  const selection = state.selection;
  const prompt = state.prompt;
  // Rows of the picker: the same model as the dropdown, over the options the
  // flow sent, so both lists move and clip the same way.
  const pickMenu = selection
    ? { items: selection.options, query: "", selected: pickSelected }
    : null;
  // The index is clamped where it is read, not only where it is painted: a
  // list can shrink under the arrows, and an index left over from a longer
  // one would select an option the user never walked to.
  const pickIndex = pickMenu ? Math.min(pickSelected, Math.max(0, pickMenu.items.length - 1)) : 0;
  const pickRows = pickMenu ? menuRows(pickMenu, MENU_VISIBLE_ROWS) : null;
  const theme = state.theme;
  const { stdout } = useStdout();
  const { stdin } = useStdin();
  // The transcript is a viewport, not "the last N entries": its height comes
  // from the terminal and is rebuilt on resize, which is also when the scroll
  // position has to be re-clamped.
  const { rows } = useWindowSize();

  // Only a child of this run needs the clock: a running one counts up and a
  // settled one lingers. Restored rows keep their frozen time, so they never
  // force a repaint.
  const lingering = state.spawns.length > 0;
  useEffect(() => {
    if (!lingering) return;

    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [lingering]);

  // The owner is told what the box holds on every change, including the
  // emptying that follows a send.
  useEffect(() => {
    onDraftChange?.(draft);
  }, [draft, onDraftChange]);

  // What the slash dropdown shows, derived from the draft: it opens on a lone
  // "/command" and closes as soon as the box stops looking like one, so there
  // is no second copy of the query to keep in sync.
  const menuQuery = menuQueryFor(draft);
  // A picker owns the box, so its list is the only one on screen.
  const menu =
    selection || prompt || menuQuery === null || menuQuery === menuDismissed || !commands?.length
      ? null
      : menuView(commands, menuQuery, menuSelected);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onExit();
      return;
    }

    // Collapse controls work while typing so an expanding turn can be quieted
    // without losing the draft.
    if (key.ctrl && input === "r") {
      onToggleAll("reasoning");
      return;
    }

    if (key.ctrl && input === "t") {
      onToggleAll("tool");
      return;
    }

    // The dropdown owns the arrows, Tab and Esc while it is open: they pick a
    // command there instead of scrolling or leaving the box. Enter is handled
    // with the other return paths below, after paging had its chance.
    if (menu) {
      if (key.upArrow || key.downArrow) {
        const delta = key.upArrow ? -1 : 1;
        setMenuSelected(menuMove(menu.state, delta).selected);
        return;
      }

      if (key.tab) {
        const command = menu.state.items[menu.state.selected];
        if (command) setDraft(menuCompletion(command));
        setMenuSelected(0);
        return;
      }

      if (key.escape) {
        setMenuDismissed(menu.state.query);
        return;
      }
    }

    // Scroll keys come before text input so a PageUp or an arrow no longer
    // disappears into the draft. In the approval box and in the picker the
    // arrows choose an option, which `nextView` knows because it is told that
    // something else owns them; paging still scrolls there, so an older part of
    // the transcript can be read while a question waits.
    const scrolled = nextView(
      key,
      input,
      effectiveView,
      measured.total,
      viewportLines,
      approval != null || selection != null || prompt != null,
    );

    if (scrolled) {
      setView(scrolled);
      return;
    }

    // A picker takes the arrows, enter and Esc. Approvals come first and the
    // mouse wheel is already gone by now, so the two never fight for a key.
    if (!approval && selection) {
      if (key.upArrow || key.downArrow) {
        setPickSelected(
          menuMove({ ...pickMenu!, selected: pickIndex }, key.upArrow ? -1 : 1).selected,
        );
        return;
      }

      if (key.return) {
        const option = selection.options[pickIndex];
        if (option) onSelect?.(option.id);
        return;
      }

      if (key.escape) {
        onSelect?.(undefined);
        return;
      }

      return;
    }

    // A question takes the whole keyboard. Confirmations answer on the key
    // itself, like the approval box, so a destructive dialog costs one keystroke.
    if (prompt) {
      // Esc wipes a text question before it cancels it: a typo in an optional
      // answer must not cost the values already typed into the flow, and pressing
      // it again on an empty field is the cancel. A confirmation has no text to
      // lose, so Esc cancels straight away. Ctrl-C is untouched: it still leaves
      // the app, wherever the user is.
      if (key.escape) {
        if (prompt.kind === "text" && answer) {
          setAnswer("");
          return;
        }

        onPrompt?.(undefined);
        return;
      }

      if (prompt.kind === "confirm") {
        if (key.return) {
          onPrompt?.(prompt.defaultAnswer ?? false);
          return;
        }

        const pressed = input.toLowerCase();

        if (pressed === "y") {
          onPrompt?.(true);
          return;
        }

        if (pressed === "n") {
          onPrompt?.(false);
          return;
        }

        return;
      }

      if (key.return) {
        onPrompt?.(answer);
        return;
      }

      if (key.backspace || key.delete) {
        setAnswer((current) => current.slice(0, -1));
        return;
      }

      if (!key.ctrl && !key.meta && input) {
        setAnswer((current) => current + input);
      }

      return;
    }

    if (approval) {
      if (key.leftArrow || key.upArrow) {
        setChoice((current) => (current + CHOICES.length - 1) % CHOICES.length);
        return;
      }

      if (key.rightArrow || key.downArrow || key.tab) {
        setChoice((current) => (current + 1) % CHOICES.length);
        return;
      }

      if (key.return) {
        onDecision(CHOICES[choice]!.key);
        setChoice(0);
        return;
      }

      if (input === "y") {
        onDecision("allow");
        setChoice(0);
        return;
      }

      if (input === "a") {
        onDecision("always");
        setChoice(0);
        return;
      }

      if (input === "n" || key.escape) {
        onDecision("deny");
        setChoice(0);
        return;
      }

      return;
    }

    if (key.return) {
      // A picker on screen owns the key; the dropdown stays visible but inert.
      if (selection) return;

      if (menu) {
        const command = menu.state.items[menu.state.selected];
        if (!command) {
          // Nothing matches, so the dropdown has no answer: it closes and the
          // text goes through instead of leaving the user stuck on enter.
          setMenuDismissed(menu.state.query);
        } else {
          setView(bottomView());
          setDraft("");
          setMenuSelected(0);
          // A sent command is history: the next "/" starts a fresh query, which must
          // reopen the dropdown even if it reads exactly like the dismissed one.
          setMenuDismissed(null);
          onSubmit(menuCommandLine(command));
          return;
        }
      }

      const value = draft.trim();

      // Empty input + enter opens the last collapsible entry the user can see.
      if (!value) {
        const lastIndex = state.lines.length - 1;
        const last = state.lines[lastIndex];

        if (last && (last.role === "reasoning" || last.role === "tool")) {
          onToggle(last.role, lastIndex);
          return;
        }

        return;
      }

      // Sending is the one moment the user asked to see what comes next. Any
      // other content change (a streamed delta, a child settling, an automatic
      // turn) must leave the scroll where the user put it.
      setView(bottomView());
      setDraft("");
      // Same after a plain prompt: an empty box opens the dropdown again on "/".
      setMenuDismissed(null);
      onSubmit(value);
      return;
    }

    if (key.backspace || key.delete) {
      setDraft((current) => {
        const next = current.slice(0, -1);
        // The dismissed query only guards a list the user closed on purpose; once
        // the box is empty the next "/" is a new question, and it has to open.
        if (!next) setMenuDismissed(null);

        return next;
      });
      return;
    }

    if (!key.ctrl && !key.meta && input) {
      setDraft((current) => current + input);
    }
  });
  const strip = spawnStrip(state.spawns, state.history ?? [], now);

  // The panel frame and its padding eat a few columns; keep a floor so the
  // layout never collapses on a tiny terminal.
  const width = Math.max(
    MIN_WIDTH,
    ((stdout as { columns?: number } | undefined)?.columns ?? 80) - PANEL_CHROME,
  );

  // Rows the dropdown paints right now. It is the panel's real height and not
  // MENU_CHROME_Y: charging a full list when three rows are drawn would leave
  // the transcript short by one line and make it jump on every keystroke.
  // A filter with no match still paints one line, the "no matching commands"
  // notice, so the panel never shrinks to nothing.
  // The picker is charged first: it decides whether the input box (and the
  // dropdown hanging from it) is painted at all.
  const pickPanelRows = pickRows ? (pickRows.rows.length || 1) + SELECT_CHROME_Y : 0;
  // The dropdown belongs to the input box, so it is only charged when the box
  // is the panel on screen.
  const menuPanelRows =
    menu && !approval && !pickPanelRows && !prompt
      ? (menu.rows.rows.length || 1) + MENU_PANEL_CHROME_Y
      : 0;

  const stripRows = strip.rows.length + (strip.hidden > 0 ? 1 : 0);
  // What the transcript can paint: the terminal, minus the panels stacked under
  // it. Derived on every render, so a resize moves the viewport and the scroll
  // position is re-clamped right below.
  const viewportLines = viewportRows(
    rows,
    chromeRows({
      stripRows,
      approval: approval != null,
      menuRows: menuPanelRows,
      selectionRows: pickPanelRows,
      promptRows: prompt ? PROMPT_CHROME_Y : 0,
    }),
  );
  const running = state.running ?? false;
  // Measuring is the expensive part (it wraps every entry), so it only runs when
  // the transcript or the width it is wrapped to changes, never per keystroke.
  const measured = useMemo(
    () =>
      measureEntries(state.lines, {
        width,
        running,
        expanded: state.expanded,
        textOf: entryText,
      }),
    [state.lines, state.expanded, running, width],
  );
  // The state holds what the user asked for; the effective view is that ask
  // squeezed into a transcript that may have grown or shrunk since.
  const effectiveView = clampView(view, measured.total, viewportLines);
  // Resolved once so the window, the padding and the panel agree on how many
  // rows are painted. Ink clips a box that grows past its height, and it clips
  // the bottom, which is exactly where the newest lines live.
  const visible = visibleWindow({ heights: measured.heights, viewportLines, view: effectiveView });

  // What the mouse tap calls. Re-clamps against the current content, so a wheel
  // event that lands between renders can never use a stale size.
  scrollRef.current = (lines) => {
    setView((current) => {
      const effective = clampView(current, measured.total, viewportLines);
      return clampView(scrollBy(effective, lines), measured.total, viewportLines);
    });
  };

  // Where the strip sits in the ink viewport, derived from the same chain that
  // computes its height: the transcript chrome, the rows it reserves and the
  // strip itself. The reserved height (`viewportLines`) is used and not
  // `padTop + painted`, because only the reserved one cannot diverge from what
  // `chromeRows` charged. No strip, no geometry: nothing is painted and every
  // report falls outside it.
  //
  // Rewritten on every render, the way `scrollRef` is, so the tap always reads
  // the geometry of the frame the user is looking at.
  if (strip.rows.length > 0) {
    geometryRef.current = {
      // The strip hangs directly under the transcript box, so its top border
      // sits on the first row that box does not paint. Its own height and the
      // panels below it are charged by `chromeRows`, not here: adding them put
      // the geometry rows below the strip, so no report ever landed on a child.
      top: TRANSCRIPT_CHROME_Y + viewportLines,
      children: stripRows,
      // The counter row is charged by children but it is not a child: the tap
      // knows one sits under them.
      hasCounter: strip.hidden > 0,
    };
  } else {
    geometryRef.current = null;
  }

  rowsRef.current = strip.rows;
  stoppableRef.current = new Set(strip.rows.filter(stoppable).map((row) => row.id));
  // Pointed at the prop of the frame on screen on every render, never at the
  // one of the render that installed the tap.
  cancelRef.current = (spawnId) => onCancelSpawn?.(spawnId) ?? false;

  // Mouse wheel, trackpad and hover. Ink consumes every chunk it reads from
  // stdin, so the mouse sequences have to be taken on the way out. The wrapping
  // is around `read` and not a `data` listener: a data listener flips stdin to
  // flowing mode and starves Ink's paused reads.
  //
  // Ink keeps its own parser in front of `read` and only calls it while an
  // escape is pending there, so in practice it is this tap that pulls the chunk.
  // Nothing is carried between reads, so a report the kernel splits across two
  // chunks is dropped instead of completed. With `?1003h` the terminal sends
  // tens of them and the next movement puts the pointer where it belongs;
  // stitching the halves would mean holding parser state in the tap for the
  // rare report that is cut.
  useEffect(() => {
    const stream = stdin as NodeJS.ReadStream & { isTTY?: boolean };

    if (!stream?.isTTY || typeof stream.setRawMode !== "function") return;

    const out = stdout as NodeJS.WriteStream | undefined;
    const originalRead = stream.read.bind(stream) as (...args: unknown[]) => unknown;
    const tap = (...args: unknown[]) => {
      const chunk = originalRead(...args);

      if (chunk) {
        const text =
          typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
        const deltas = wheelScrollLines(text);
        if (deltas.length) scrollRef.current(deltas.reduce((sum, delta) => sum + delta, 0));
        const geometry = geometryRef.current;

        for (const report of parseMouseReports(text)) {
          const row = geometry ? stripRowAt(report, geometry) : null;

          // A left press on the row of a running child stops it, and that is the
          // only report that acts. A release, a drag and every other button are
          // ignored, and a click anywhere else — the transcript, a border, the
          // "+N older" counter — does nothing at all.
          //
          // Only a child of this process with work left to abort is stopped, so
          // a click on a settled or a restored row is swallowed on purpose: it
          // is silent because there is nothing to stop, not because it failed.
          if (report.phase === "press" && report.button === "left") {
            const spawn = row === null ? undefined : rowsRef.current[row];

            if (spawn && stoppableRef.current.has(spawn.id)) {
              cancelRef.current(spawn.id);
              // A row left lit over a child that is being stopped is a lie, and
              // the next motion report would light it again.
              hover.current.set(null);
            }

            continue;
          }

          if (report.phase !== "move") continue;

          const spawn = row === null ? undefined : rowsRef.current[row];
          // A settled or restored child has nothing to stop, so it must not look
          // actionable: the pointer over one clears the highlight.
          hover.current.set(spawn && stoppableRef.current.has(spawn.id) ? row : null);
        }
      }

      return chunk;
    };

    (stream as unknown as { read: unknown }).read = tap;
    // Motion reporting is stacked on top of the press and wheel modes, so a
    // terminal that ignores `?1003` keeps its wheel and simply never hovers.
    out?.write(MOUSE_ENABLE + MOUSE_HOVER_ENABLE);

    return () => {
      (stream as unknown as { read: unknown }).read = originalRead;
      // Undone in the reverse order of the setup, and the highlight goes with it so
      // no row is left lit on a screen nobody is tracking any more.
      hover.current.set(null);
      out?.write(MOUSE_HOVER_DISABLE + MOUSE_DISABLE);
    };
  }, [stdin, stdout]);

  return (
    <Box flexDirection="column" height="100%">
      <Box
        flexDirection="column"
        // The outer box owns the border and the padding, so the content never hugs
        // them. Its height is the content area plus both borders and both padding
        // rows; the scroll model only counts the content area.
        height={viewportLines + TRANSCRIPT_CHROME_Y}
        borderStyle="round"
        paddingX={PANEL_PADDING_X}
        paddingY={PANEL_PADDING_Y}
      >
        {/* The real scroll viewport. Clipping lives here, inside the padding, so a
    row cut by the scroll cannot paint over the border or the breathing room.
    flexShrink 0 stops Yoga from shrinking the rows once the content
    overflows; a shrunk row paints over its neighbour. */}
        <Box flexDirection="column" height={viewportLines} overflowY="hidden" flexShrink={0}>
          <Box flexDirection="column" flexShrink={0}>
            {Array.from({ length: visible.padTop }, (_, blank) => (
              <Text key={`pad-${blank}`}> </Text>
            ))}
            {visible.rows.map(({ absolute, cutTop }) => (
              <Line
                // Keyed by the position in the transcript, never by the position in
                // the window: a shifting key makes React reuse the wrong entry while
                // scrolling, which is half of the "it jumps" bug.
                key={absolute}
                line={state.lines[absolute]!}
                // A negative gap lifts the first row of the window by `cutTop` lines,
                // so the pane clips its top instead of painting the entry from its
                // first line and pushing the newest one out of the viewport.
                gap={gapBefore(absolute) - cutTop}
                theme={theme}
                running={running}
                // `expanded` holds absolute transcript indexes (see toggleEntry in
                // TuiUiAdapter), so it is queried with `absolute`, never with a
                // window index.
                expanded={state.expanded.has(absolute)}
                width={width}
              />
            ))}
          </Box>
        </Box>
      </Box>

      {strip.rows.length > 0 && (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="cyan"
          paddingX={PANEL_PADDING_X}
        >
          {strip.rows.map((spawn, index) => {
            // The highlight also repaints the text, because ink compares the text of
            // the frame to decide whether to write: a row that differs only in style
            // produces an identical frame and is never repainted, so an `inverse` on
            // its own never reached the screen. The separators of the row under the
            // pointer become the same `›` the open menus mark a choice with, which
            // reads as "this is what a click would act on".
            const lit = index === hovered;
            const separator = lit ? " › " : " · ";

            return (
              <Text
                key={spawn.id}
                color={colorFor(spawn.status)}
                dimColor={spawn.restored}
                // Inverse on top of the changed text, not instead of it: it flips fg
                // and bg over whatever `colorFor` already chose, so the highlight never
                // competes with the yellow of a cancelled child or the dim of a restored
                // one. In ink 8 `inverse` does not force `fg`, so on its own it would
                // not win over `dimColor` either.
                inverse={lit}
              >
                {iconFor(spawn.status)} {spawn.agent}
                {separator}
                {spawn.id}
                {separator}
                {elapsedFor(spawn, now)}
              </Text>
            );
          })}
          {strip.hidden > 0 && <Text dimColor>+{strip.hidden} older from previous runs</Text>}
        </Box>
      )}

      {approval ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="yellow"
          paddingX={PANEL_PADDING_X}
          paddingY={PANEL_PADDING_Y}
        >
          <Text color="yellow">
            Allow {approval.tool} [{approval.kind}]
          </Text>
          <Text>{approval.subject}</Text>
          <Box marginTop={1}>
            {CHOICES.map((option, index) => (
              <Text
                key={option.key}
                color={index === choice ? "green" : undefined}
                inverse={index === choice}
              >
                {index === choice ? "› " : " "}
                {option.label}
              </Text>
            ))}
          </Box>
          <Text dimColor>[y] allow · [a] always · [n] deny · ←/→ + enter</Text>
        </Box>
      ) : null}

      {/* One panel takes typing at a time, and chromeRows charges exactly that:
the picker and the input box are alternatives, and an approval hides the
box. A picker under an approval stays on screen but inert, which is why
both are painted there. */}
      {prompt ? (
        <PromptPanel prompt={prompt} answer={answer} width={width} />
      ) : selection && pickRows ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="magenta"
          paddingX={PANEL_PADDING_X}
          paddingY={PANEL_PADDING_Y}
        >
          <Text color="magenta">{selection.message}</Text>
          {pickRows.rows.length ? (
            pickRows.rows.map((option, index) => {
              const selected = pickRows.start + index === pickIndex;

              return (
                <Text key={option.id} inverse={selected} color={selected ? "magenta" : undefined}>
                  {selected ? "› " : " "}
                  {truncateCell(
                    option.hint ? `${option.label} — ${option.hint}` : option.label,
                    Math.max(10, width - 2),
                  )}
                </Text>
              );
            })
          ) : (
            <Text dimColor>no options</Text>
          )}
          <Text dimColor>
            {/* The range only means something when part of the list is out of sight. */}
            {pickRows.hiddenAbove || pickRows.hiddenBelow
              ? `${pickIndex + 1}/${selection.options.length} · `
              : ""}
            ↑/↓ choose · enter accept · esc cancel
          </Text>
        </Box>
      ) : approval ? null : (
        <InputBox width={width} draft={draft} activity={state.activity} menu={menu} />
      )}

      <Box paddingX={PANEL_PADDING_X}>
        {/* Ink wraps instead of clipping, and a wrapped bar would steal a row from
the transcript while STATUS_ROWS still charges one. Cutting to the content
width keeps the line on its own row. */}
        <Text dimColor>{truncateCell(statusLine(state.status), width)}</Text>
      </Box>
    </Box>
  );
};

// Renders one command of the dropdown: name, aliases and what it does, cut to
// the columns available. The label is what the filter matched, so it comes
// first and the description is what gets ellipsised.
const menuLine = (command: CommandOption, width: number): string => {
  const aliases = command.aliases?.length
    ? ` (${command.aliases.map((alias) => `/${alias}`).join(", ")})`
    : "";

  return truncateCell(`/${command.name}${aliases} ${command.description}`, width);
};

// The question of a flow. It paints exactly the three rows PROMPT_CHROME_Y
// charges, and cuts both free texts to the panel width: Ink wraps instead of
// clipping, so an overlong line would push a fourth row into a box the
// transcript is not expecting.
const PromptPanel = ({
  prompt,
  answer,
  width,
}: {
  prompt: TuiPrompt;
  answer: string;
  width: number;
}) => {
  const room = Math.max(10, width - 2);
  // The help line spells out the two-step Esc of a text question: the first
  // one only clears the field, so the panel has to say why it stays open.
  const keys =
    prompt.kind === "confirm"
      ? `[y] yes · [n] no · enter ${prompt.defaultAnswer ? "yes" : "no"} · esc cancel`
      : "[enter] accept · esc clear · esc again cancel";
  const typed = prompt.kind === "text" ? answer : "";
  // A secret is masked at the character count, never shown: the screen a
  // terminal leaves behind is a scrollback the user can copy.
  const shown =
    prompt.kind === "text" && prompt.secret ? "•".repeat(Array.from(typed).length) : typed;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="blue"
      paddingX={PANEL_PADDING_X}
      paddingY={PANEL_PADDING_Y}
    >
      <Text color="blue">{truncateCell(prompt.message, room)}</Text>
      <Text>{shown || " "}</Text>
      <Text dimColor>{truncateCell(prompt.hint ? `${prompt.hint} · ${keys}` : keys, room)}</Text>
    </Box>
  );
};

// The input box and the slash dropdown under it. They are one component
// because the dropdown only exists as long as the box looks like a command:
// keeping them together is what stops the list from outliving its query.
const InputBox = ({
  draft,
  width,
  activity,
  menu,
}: {
  draft: string;
  width: number;
  activity?: string;
  menu: ReturnType<typeof menuView> | null;
}) => (
  <>
    <Box borderStyle="round" paddingX={PANEL_PADDING_X} paddingY={PANEL_PADDING_Y}>
      <Text color="green">{"> "}</Text>
      <Text>{draft}</Text>
      <Text dimColor>{activity ? ` ${activity}` : ""}</Text>
    </Box>

    {menu ? (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={PANEL_PADDING_X}>
        {menu.rows.rows.length ? (
          menu.rows.rows.map((command, index) => {
            const selected = menu.rows.start + index === menu.state.selected;

            return (
              <Text key={command.name} inverse={selected} color={selected ? "cyan" : undefined}>
                {selected ? "› " : "  "}
                {menuLine(command, Math.max(10, width - 2))}
              </Text>
            );
          })
        ) : (
          <Text dimColor>no matching commands</Text>
        )}
        <Text dimColor>
          {menu.rows.hiddenAbove || menu.rows.hiddenBelow
            ? `${menu.state.selected + 1}/${menu.state.items.length} · `
            : ""}
          tab complete · enter run · esc close
        </Text>
      </Box>
    ) : null}
  </>
);

// Renders one entry with the style of its role. Colour alone is not enough to
// tell speakers apart, so each role also gets a glyph. `gap` is the blank line
// above the entry, already resolved from the absolute index.
const Line = ({
  line,
  gap,
  theme,
  running,
  expanded,
  width,
}: {
  line: TuiLine;
  gap: number;
  theme: Theme;
  running: boolean;
  expanded: boolean;
  width: number;
}) => {
  // A spawn entry is informational, so it borrows the notice style.
  const role: Role = line.role === "spawn" ? "notice" : line.role;
  const style = theme[role];
  const glyph = line.role === "spawn" ? "◈ " : GLYPH[role];

  if (line.role === "reasoning") {
    const text = entryText(line);
    const view = collapse({
      role: "reasoning",
      text,
      width: Infinity,
      running,
      expanded,
    });

    if (!view.shown) {
      return (
        <Box flexDirection="column" marginTop={gap}>
          <Text {...style}>
            {glyph}
            {view.summary} · ctrl+r
          </Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" marginTop={gap}>
        <Text {...style}>
          {glyph}
          {view.hidden ? `${view.summary} · ctrl+r` : view.summary}
        </Text>
        <Box paddingLeft={2}>
          <Text {...style}>{view.shown}</Text>
        </Box>
      </Box>
    );
  }

  if (line.role === "answer") {
    return (
      <Box flexDirection="column" marginTop={gap}>
        {line.doc.blocks.map((block, index) => (
          <Block key={index} block={block} role={line.role} style={style} width={width} />
        ))}
        {line.doc.open ? <Text {...style}>{line.doc.open}</Text> : null}
      </Box>
    );
  }

  const textLine = line as Extract<TuiLine, { text: string }>;

  if (line.role === "tool") {
    const view = collapse({
      role: "tool",
      text: textLine.text,
      width: Infinity,
      running,
      expanded,
    });

    if (!view.shown) {
      return (
        <Box flexDirection="column" marginTop={gap}>
          <Text {...style}>
            {glyph}
            {view.summary} · ctrl+t
          </Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" marginTop={gap}>
        <Text {...style}>
          {glyph}
          {view.hidden ? `${view.summary} · ctrl+t` : view.summary}
        </Text>
        <Box paddingLeft={2}>
          <Text {...style}>{view.shown}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={gap}>
      <Text {...style}>
        {glyph}
        {textLine.text}
      </Text>
    </Box>
  );
};

// Flattens a block to plain text for the collapse window.
const plainBlock = (block: Block): string => {
  const spans = (parts: InlineSpan[]) => parts.map((span) => span.text).join("");

  switch (block.kind) {
    case "code":
      return block.lines.join("\n");
    case "list":
      return block.items
        .map((item) => `${" ".repeat(item.depth * 2)}${item.marker} ${spans(item.spans)}`)
        .join("\n");
    case "table":
      return [block.header, ...block.rows].map((row) => row.join(" | ")).join("\n");
    case "rule":
      return "───";
    case "heading":
    case "quote":
    case "paragraph":
      return spans(block.spans);
  }
};

// Closed blocks are styled definitively; inline spans map to ink props.
const Block = ({
  block,
  role,
  style,
  width,
}: {
  block: Block;
  role: Role;
  style: ReturnType<typeof resolveTheme>[Role];
  width: number;
}) => {
  const glyph = role === "reasoning" ? GLYPH.reasoning : "";

  switch (block.kind) {
    case "code":
      return (
        <Box flexDirection="column" paddingLeft={2}>
          {block.lines.map((codeLine, index) => (
            <Text key={index} dimColor color={style.color}>
              {codeLine || " "}
            </Text>
          ))}
        </Box>
      );

    case "rule":
      return <Text {...style}>{"─".repeat(40)}</Text>;

    case "list":
      return (
        <Box flexDirection="column">
          {block.items.map((item, index) => (
            <Box key={index} paddingLeft={item.depth * 2}>
              <Text {...style}>
                {glyph}
                {item.marker === "-" ? "•" : item.marker} <Spans spans={item.spans} style={style} />
              </Text>
            </Box>
          ))}
        </Box>
      );

    case "table":
      return <Table block={block} style={style} width={width} />;

    case "heading":
      return (
        <Text {...style} bold>
          {glyph}
          <Spans spans={block.spans} style={style} />
        </Text>
      );

    default: {
      const text = block.spans.map((span) => span.text).join("");
      const lines = wrapText(text, leaveRoomFor(glyph, width));

      return (
        <Box flexDirection="column">
          {lines.map((line, index) => (
            <Text key={index} {...style}>
              {index === 0 ? glyph : " ".repeat(glyph.length)}
              {line}
            </Text>
          ))}
        </Box>
      );
    }
  }
};

// Keeps room for the role glyph so wrapped paragraphs stay aligned.
const leaveRoomFor = (glyph: string, width: number): number => Math.max(1, width - glyph.length);

// Cuts inline spans to a plain-text width, preserving each span's styling.
const truncateSpans = (spans: InlineSpan[], width: number): InlineSpan[] => {
  const result: InlineSpan[] = [];
  let remaining = width;

  for (const span of spans) {
    if (remaining <= 0) break;

    if (span.text.length <= remaining) {
      result.push(span);
      remaining -= span.text.length;
      continue;
    }

    result.push({ ...span, text: span.text.slice(0, remaining) });
    remaining = 0;
  }

  return result;
};

// Renders a markdown table as aligned columns. Columns shrink to fit the
// terminal (widest first) and any cell that no longer fits is ellipsised, so a
// wide table stays a grid instead of wrapping into noise.
const Table = ({
  block,
  style,
  width,
}: {
  block: TableBlock;
  style: ReturnType<typeof resolveTheme>[Role];
  width: number;
}) => {
  const plain = (cell: InlineSpan[]) => cell.map((span) => span.text).join("");
  const natural = block.header.map((cell, index) =>
    Math.max(plain(cell).length, ...block.rows.map((row) => plain(row[index] ?? []).length)),
  );
  const columns = fitColumns(natural, width);

  const rule = (left: string, mid: string, right: string) =>
    left + columns.map((column) => "─".repeat(column.width + 2)).join(mid) + right;

  const row = (cells: InlineSpan[][]) => {
    const parts = cells.map((cell, index) => {
      const column = columns[index]!;
      const text = truncateCell(plain(cell), column.width);
      const gap = Math.max(0, column.width - text.length);
      const align = block.align[index]!;
      const left = align === "right" ? gap : align === "center" ? Math.floor(gap / 2) : 0;
      const right = gap - left;

      // Spans are truncated as plain text, so the styled content must follow
      // the same cut or the column would overflow its rule.
      return { spans: truncateSpans(cell, column.width), left, right };
    });

    return (
      <>
        {"│ "}
        {parts.map((part, index) => (
          <Text key={index}>
            {" ".repeat(part.left)}
            <Spans spans={part.spans} style={style} />
            {" ".repeat(part.right)}
            {index === parts.length - 1 ? " │" : " │ "}
          </Text>
        ))}
      </>
    );
  };

  return (
    <Box flexDirection="column">
      <Text {...style} bold>
        {rule("┌", "┬", "┐")}
      </Text>
      <Text {...style} bold>
        {row(block.header)}
      </Text>
      <Text {...style}>{rule("├", "┼", "┤")}</Text>
      {block.rows.map((cells, index) => (
        <Text key={index} {...style}>
          {row(cells)}
        </Text>
      ))}
      <Text {...style}>{rule("└", "┴", "┘")}</Text>
    </Box>
  );
};

const Spans = ({
  spans,
  style,
}: {
  spans: InlineSpan[];
  style: ReturnType<typeof resolveTheme>[Role];
}) => (
  <>
    {spans.map((span, index) => (
      <Text
        key={index}
        {...style}
        bold={span.bold || style.bold}
        italic={span.italic}
        color={span.code ? "cyan" : style.color}
      >
        {span.text}
      </Text>
    ))}
  </>
);

// The bar falls back to "ready" when the snapshot has nothing to show, so the
// row is never blank.
const statusLine = (status: UiStatus): string => formatStatusBar(status) || "ready";
