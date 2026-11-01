---
name: todo-format
description: Standard format for TODO files — one actionable, verifiable task per line with a short description, an explicit "done when" criterion, dependencies and priority; plus sections for discarded items and open questions. Use it whenever creating, rewriting or reviewing a TODO/roadmap file.
tags: [docs, planning, todo]
---

# TODO format

A TODO file is a decision log, not a scratchpad. Every line must be something
someone could pick up without asking what it means, and could close without
arguing whether it is finished.

Write it in the language the project uses. Keep it short: one line per fact.

## File skeleton

```markdown
# TODO — <project or area>

## Contexto
<2–4 lines: what the project is today, so the list can be read cold.>

## P1 — <theme>
- [ ] **<Actionable title>**
  <One sentence: what it is and why it matters.>
  Done when: <observable, checkable condition>.
  Depends on: <other task> _(optional)_

## P2 — <theme>
...

## Descartados
- **<Item>** — <why it is not worth doing> → <what replaces it / where it moved>

## Preguntas abiertas
- **<Question>** — <why it is not a task yet>. To close it: <what must be decided or measured>.
```

## Rules per task

1. **One task per checkbox.** "Create and validate X" is two tasks.
2. **Title starts with a verb** in infinitive/imperative: show, add, persist,
   extract. A title that cannot start with a verb ("more info on the UI") is
   not a task yet — it belongs in *Preguntas abiertas*.
3. **Description max one sentence.** What it is + why it matters. Not how to
   build it; the implementation belongs in a plan or an issue.
4. **"Done when" is mandatory for anything non-trivial.** It must be observable
   from outside: a test name, a command output, a visible behaviour. "Works
   well" is not a criterion.
5. **Dependencies only when real.** If the order is not forced, leave it out.
6. **No questions disguised as tasks.** A bullet ending in "?" is a question.
7. **No empty bullets, no duplicates.** If two bullets describe the same thing,
   merge them into the stronger one.
8. **State the current state when it exists.** If the repo already has part of
   the feature (a type, a manager, an event), say so in the description — it
   prevents someone rebuilding what is done.

## Discarded vs open question

| | Use it when | Effect |
| --- | --- | --- |
| `Descartados` | The item is useless, redundant, already done, or below the value bar | Closed. Record the motive so it is not re-proposed. |
| `Preguntas abiertas` | The item might be valid but needs a decision, a measurement or a comparison first | Open. Record what closing it requires. |

Nothing is deleted. Removing a bullet loses the reason it was removed, and the
same idea comes back six months later.

## Priority

- `P1` — blocks the product or hurts the user today.
- `P2` — clearly valuable, no urgency.
- `P3` — polish / nice to have.

Group by theme inside a priority only if the file exceeds ~15 lines.

## Anti-patterns

- A theme section with a single vague bullet under it.
- Descriptions that restate the title in other words.
- A "next steps" list that is really a plan; a plan belongs in `skillsPlan.md`
  style documents, the TODO only links to it.
- Keeping a bullet because it is old instead of because it is true.
