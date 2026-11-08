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
   not a task yet — it belongs in _Preguntas abiertas_.
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
9. **Measure the revert on the file as it is right now.** When you claim a test
catches a mutation, apply the mutation, run it, and measure against `M = the
number of cases in the file at that moment`; record which **named** case
catches it. The name is what must stay true, not the count. Re-measure `M`
every time a case is added or removed.

## Where the history goes

1. **The TODO holds the task; the journal holds the history.** Closed items
leave their narrative in `docs/journal/<package>/<theme>.md` and keep only the
task shape in the TODO.
2. **Closed item shape:** title, one sentence, `Done when:`, `Depends on:`,
and one `hecho:` line pointing at the journal:

   ```markdown
   hecho: <one sentence naming the key file> — ver [journal <theme>](docs/journal/<package>/<theme>.md)
   ```

   Nothing else.
3. **The journal is a move, not a summary.** Copy the original body verbatim; a
summary loses exactly the detail someone will need later.
4. **Never invent a criterion.** A closed item that had no `Done when:` gets
`Done when: no se fijó uno; el hecho está en el journal.` — literally, not a
reconstructed guess.
5. **`Done when:` and `Depends on:` are never rewritten** while moving things.
Copy them.
6. **A section whose items are all closed collapses to one line** under
`## Historial`, linking its journal.
7. **An open item with a long body (>12 lines) sends its narrative to
`#### Notas`** at the end of its section; the item itself stays at most
12 lines.

## Discarded vs open question

|                      | Use it when                                                                       | Effect                                              |
| -------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------- |
| `Descartados`        | The item is useless, redundant, already done, or below the value bar              | Closed. Record the motive so it is not re-proposed. |
| `Preguntas abiertas` | The item might be valid but needs a decision, a measurement or a comparison first | Open. Record what closing it requires.              |

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
