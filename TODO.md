# TODO — racso-harness (índice global)

## Contexto

Monorepo pnpm con dos paquetes publicados: `core/` (`@racso2609/core`, librería base
sin interacción, ver `core/CONTRACT.md`) y `cli/` (`@racso2609/cli`, cliente de terminal
con renderer de líneas y TUI ink detrás de `--tui`); el gateway (`@racso2609/gateway`)
es un paquete nuevo y proceso aparte, aún sin crear. Diseño en `docs/ARCHITECTURE.md`
y publicación en `docs/INSTALL.md`. Este archivo es solo el índice: cada tarea
vive en el TODO del paquete que la posee, con su `Done when` y sus
dependencias. Formato de cada lista: skill `core/skills/todo-format.md`.

## Tablero

| Tema                                                       | Dónde vive                                           | Estado                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------ |
| Documentación de arquitectura e instalación                | `docs/ARCHITECTURE.md`, `docs/INSTALL.md`            | escritos, pendiente de revisión                              |
| Split core/cli, tooling, agents, skills, session reporting | `core/TODO.md` §0–9 | histórico + pendientes: §9 cerrado (8/8); abiertas las tareas de skills (§8.1) y «Devolver los informes largos de un hijo como artefacto, no como mensaje» |
| Gateway como paquete nuevo y proceso aparte (F1–F5) | `core/TODO.md` §10, diseño en `docs/ARCHITECTURE.md` | nuevo, c3; bloqueado por la publicación de `cli/TODO.md` §P4 y `gateway/` aún no existe |
| TUI de pantalla completa y feedback del turno | `cli/TODO.md` §P0–P3, §P5 | `P0`, `P1`, `P3` y `P4.5` cerrados; queda un ítem abierto de `P2` («El aviso de cierre no muestra el informe del hijo») y la deuda del TUI en `P5` |
| Empaquetado y publicación (F0): GitHub Packages + Releases | `cli/TODO.md` §P4, plan en `docs/INSTALL.md` | empaquetado hecho (scope `@racso2609`, `files`, `engines`, sin `private`, `workspace:^`, `.npmrc` por scope, `scripts/smoke-install.mjs`); pendiente publicar los dos paquetes, crear el release con los `.tgz` y documentar la instalación en el README — ver «Bloqueo actual» de `cli/TODO.md` §P4 |
| Continuación automática tras un hijo delegado | `cli/TODO.md` §P6 + espejo en `core/TODO.md` §9 | §P6 implementado entero: contrato en el core (`pendingSpawns()`); arranque del turno sin prompt (`MainLoop.maybeContinue()`, solo en TUI, sin pisar el borrador del usuario); tope configurable (`config.sessions.maxAutoContinuations`, default 5); aviso de cierre (`CONTINUING_ALONE_NOTICE` en `cli/src/ui/outcome.ts`). Lo único pendiente es una prueba de humo end-to-end en una sesión real |

## Origen de las tareas nuevas

Los puntos y las notas sueltas que había en este archivo se cerraron así:

- **easy install** → `cli/TODO.md` §P4 (fase F0: empaquetado y publicación en GitHub
  Packages con scope `@racso2609` más los `.tgz` en GitHub Releases; el plan vive en
  `docs/INSTALL.md` y no se duplica aquí).
- **core gateway persistente (cronjobs + webhooks)** → `core/TODO.md` §10, reasignado a
  las fases F1–F5 de `docs/ARCHITECTURE.md`: el gateway deja de ser un modo del core y
  pasa a ser el paquete nuevo `@racso2609/gateway`, proceso aparte que consume la lib
  publicada.
- **analizar si vale la pena usar el gateway en el CLI** → no es tarea mientras el
  gateway no exista: queda como pregunta abierta en `cli/TODO.md`.

Las cuatro notas sueltas que había en este archivo se cerraron así:

- **logs de los hijos como summary en el card del proceso delegado** → el progreso
  en vivo quedó cubierto por `core/TODO.md` §9 (`SpawnEvent`, `onSpawnEvent`,
  `listSpawns`) y el aviso de cierre por `cli/TODO.md` §P1 y §P2. Lo que sigue
  faltando del card —resumen del hijo y duración en el contrato— se registra en
  `core/TODO.md` §9. La sección §11 citada antes nunca existió, así que se retira
  la referencia.
- **scroll inestable mientras el modelo va generando** → `cli/TODO.md` §P3.
- **animación del cursor para saber dónde está el foco** → `cli/TODO.md` §P3.
- **limitar el número de caracteres de las secciones colapsadas (`ctrl+t`/`ctrl+r`)**
  → `cli/TODO.md` §P3.

Una nota suelta más, añadida después, se cerró así:

- **cuando un delegate termine si aun hay trabajo que hacer la session debe seguir el
  trabajo que queda no esperar por mi** → c3: se troceó en las 4 tareas de `cli/TODO.md`
  §P6 (exponer si un hijo asentado dejó trabajo sin entregar, arrancar el turno sin
  prompt, acotar las continuaciones y contarlas en el cierre del turno) más la tarea de
  contrato de `core/TODO.md` §9, porque hoy el CLI cierra el turno y vuelve a
  `nextPrompt()` y no existe API para saber si un hijo dejó trabajo sin entregar.

## Descartados

- **Duplicar las tareas en este archivo** — dos copias de la misma lista se
  desincronizan (ya pasó con `~/.racso-harness/agents/*.md` vs `core/agents/`) →
  un solo índice con punteros.
- **Conservar la nota de scroll tal cual** — la nota acababa en «…cuando vaa
  generando los», es decir, sin objeto completo → se registró el problema observable
  (la vista salta durante el streaming) y el criterio de cierre queda en la tarea de
  `cli/TODO.md` §P3, no en la nota.

  ## nuevo issue

- Nota original: «cuando un delegate termine si aun hay trabajo que hacer la session debe
seguir el trabajo que queda no esperar por mi».
- Vive en `cli/TODO.md` §P6, con su tarea de contrato espejo en `core/TODO.md` §9. §P6
está implementado entero: contrato `pendingSpawns()` en el core, que dice qué hijo
asentado dejó trabajo sin entregar; arranque del turno sin prompt con
`MainLoop.maybeContinue()`, solo en TUI y sin pisar el borrador del usuario; tope
`config.sessions.maxAutoContinuations` con default 5; y aviso de cierre
`CONTINUING_ALONE_NOTICE` para que el usuario sepa que la sesión sigue sola. Lo único
pendiente de §P6 es la prueba de humo end-to-end en una sesión real.
