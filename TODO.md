# TODO — racso-harness (índice global)

## Contexto
Monorepo pnpm con dos paquetes: `core/` (`@racso/core`, SDK sin interacción, ver
`core/CONTRACT.md`) y `cli/` (`@racso/cli`, cliente de terminal con renderer de
líneas y TUI ink detrás de `--tui`). Este archivo es solo el índice: cada tarea
vive en el TODO del paquete que la posee, con su `Done when` y sus
dependencias. Formato de cada lista: skill `core/skills/todo-format.md`.

## Tablero

| Tema | Dónde vive | Estado |
| --- | --- | --- |
| Split core/cli, tooling, agents, skills, session reporting | `core/TODO.md` §0–9 | histórico + pendientes |
| Gateway persistente (cronjobs + webhooks) | `core/TODO.md` §10 | nuevo, c3 |
| TUI de pantalla completa y feedback del turno | `cli/TODO.md` §P0–P3 | P0/P1/P3 casi cerrados, P2 abierto |
| Instalación y distribución | `cli/TODO.md` §P4 | nuevo, c3 |

## Origen de las tareas nuevas

Los tres puntos que había en este archivo se trocearon así:

- **easy install** → `cli/TODO.md` §P4 (4 tareas).
- **core gateway persistente (cronjobs + webhooks)** → `core/TODO.md` §10 (9 tareas).
- **analizar si vale la pena usar el gateway en el CLI** → no es tarea mientras el
  gateway no exista: queda como pregunta abierta en `cli/TODO.md`.

## Descartados

- **Duplicar las tareas en este archivo** — dos copias de la misma lista se
  desincronizan (ya pasó con `~/.racso-harness/agents/*.md` vs `core/agents/`) →
  un solo índice con punteros.
