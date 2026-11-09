# TODO — racso-harness (índice global)

## Contexto

Monorepo pnpm con dos paquetes publicados: `core/` (`@racso2609/core`, librería base
sin interacción, ver `core/CONTRACT.md`) y `cli/` (`@racso2609/cli`, cliente de terminal
con renderer de líneas y TUI ink detrás de `--tui`); el gateway (`@racso2609/gateway`)
es un paquete nuevo y proceso aparte, aún sin crear. Diseño en `docs/ARCHITECTURE.md`
y publicación en `docs/INSTALL.md`. Este archivo es solo el índice: cada tarea
vive en el TODO del paquete que la posee, con su `Done when` y sus
dependencias. Formato de cada lista: skill `todo-format` (`skills/todo-format.md`).

Destinos: el TODO vivo de cada paquete ([`cli/TODO.md`](cli/TODO.md),
[`core/TODO.md`](core/TODO.md), [`gateway/TODO.md`](gateway/TODO.md)) y el
[`docs/journal/`](docs/journal/README.md), que guarda el cuerpo íntegro de todo lo ya
cerrado (`[x]`). Los TODO vivos se quedan solo con lo abierto y una línea de puntero al
journal por sección cerrada. Las notas sueltas que antes vivían en este archivo están en
`## Origen de las tareas nuevas`, más abajo.

## Tablero

| Tema                                                       | Dónde vive                                                             | Estado                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Documentación de arquitectura e instalación                | `docs/ARCHITECTURE.md`, `docs/INSTALL.md`                              | escritos, pendiente de revisión                                                                                                                                                                                                                                                                                                                                                     |
| Split core/cli, tooling, agents, skills, session reporting | `core/TODO.md` §0–9                                                    | histórico + pendientes: §9 cerrado (8/8); abiertas las tareas de skills (§8.1) y «Devolver los informes largos de un hijo como artefacto, no como mensaje»                                                                                                                                                                                                                          |
| Gateway como paquete nuevo y proceso aparte (F0–F5)        | [`gateway/TODO.md`](gateway/TODO.md), diseño en `docs/ARCHITECTURE.md` | 16 tareas, ninguna empezada; bloqueadas por la verificación de F0 (`cli/TODO.md` §P4) y porque `gateway/` aún no existe                                                                                                                                                                                                                                                             |
| TUI de pantalla completa y feedback del turno              | `cli/TODO.md` §P0–P3, §P5                                              | `P0`, `P1`, `P3`, `P4.5` y `/resume` cerrados; queda un ítem abierto de `P2` («El aviso de cierre no muestra el informe del hijo») y la deuda del TUI en `P5`                                                                                                                                                                                                                       |
| Empaquetado y publicación (F0)                             | `cli/TODO.md` §P4, plan en `docs/INSTALL.md`                           | empaquetado **y publicación HECHOS** (release `v1.0.0` con `racso2609-core-1.0.0.tgz` y `racso2609-cli-1.0.0.tgz`, 2026-11-05; `README.md` con `## Instalación`); queda verificar la instalación publicada y decidir el canal GitHub Packages                                                                                                                                       |
| Continuación automática tras un hijo delegado              | `cli/TODO.md` §P6 + espejo en `core/TODO.md` §9                        | §P6 implementado entero: contrato en el core (`pendingSpawns()`); arranque del turno sin prompt (`MainLoop.maybeContinue()`, solo en TUI, sin pisar el borrador del usuario); tope configurable (`config.sessions.maxAutoContinuations`, default 5); aviso de cierre (`CONTINUING_ALONE_NOTICE`). Lo único pendiente es la prueba de humo end-to-end, que es la verificación de §P4 |
| Historial de lo cerrado                                    | [`docs/journal/`](docs/journal/README.md)                              | 11 fragmentos con el cuerpo íntegro de los 48 ítems cerrados                                                                                                                                                                                                                                                                                                                        |
| MCP: servidores de tools por stdio                         | `core/TODO.md` §11, límites y deudas en §11.1                          | MVP cerrado, deudas abiertas                                                                                                                                                                                                                                                                                                                                                        |

## Origen de las tareas nuevas

Los puntos y las notas sueltas que había en este archivo se cerraron así. El detalle de
cada uno vive ya en el TODO del paquete que lo posee (y, si está cerrado, en el journal);
aquí solo queda el puntero de qué pasó con la nota.

- **easy install** → `cli/TODO.md` §P4 (fase F0: empaquetado y publicación en GitHub
  Packages con scope `@racso2609` más los `.tgz` en GitHub Releases; el plan vive en
  `docs/INSTALL.md` y no se duplica aquí). **Hecho y publicado**; queda la verificación.
- **core gateway persistente (cronjobs + webhooks)** → [`gateway/TODO.md`](gateway/TODO.md),
  reasignado a las fases F0–F5 de `docs/ARCHITECTURE.md`: el gateway deja de ser un modo del
  core y pasa a ser el paquete nuevo `@racso2609/gateway`, proceso aparte que consume la lib
  publicada.
- **analizar si vale la pena usar el gateway en el CLI** → no es tarea mientras el
  gateway no exista: queda como pregunta abierta en `cli/TODO.md` §Preguntas abiertas.
- **logs de los hijos como summary en el card del proceso delegado** → el progreso en vivo
  quedó cubierto por `core/TODO.md` §9 (`SpawnEvent`, `onSpawnEvent`, `listSpawns`) y el aviso
  de cierre por `cli/TODO.md` §P1 y §P2; el resumen del hijo y la duración en el contrato se
  cerraron en §9 («Añadir resumen del hijo y duración a `SpawnHandle`»). La sección §11 citada
  antes nunca existió, así que la referencia se retiró.
- **scroll inestable mientras el modelo va generando** → cerrado en `cli/TODO.md` §P4.5
  (medir en líneas visuales, rueda del ratón y recorte del transcript).
- **animación del cursor para saber dónde está el foco** → `cli/TODO.md` §P3.
- **limitar el número de caracteres de las secciones colapsadas (`ctrl+t`/`ctrl+r`)** →
  `cli/TODO.md` §P3 («Colapsar razonamiento y tool calls»).
- **cuando un delegate termine si aun hay trabajo que hacer la session debe seguir el
  trabajo que queda no esperar por mi** → `cli/TODO.md` §P6, que conserva la nota original;
  se troceó en sus 4 tareas más la de contrato de `core/TODO.md` §9 («Exponer los hijos
  asentados con resultado sin entregar»).

## Descartados

- **Duplicar las tareas en este archivo** — dos copias de la misma lista se
  desincronizan (ya pasó con `~/.racso-harness/agents/*.md` vs `core/agents/`) →
  un solo índice con punteros.
- **Conservar la nota de scroll tal cual** — la nota acababa en «…cuando vaa
  generando los», es decir, sin objeto completo → se registró el problema observable
  (la vista salta durante el streaming) y el criterio de cierre quedó en la tarea de
  `cli/TODO.md` §P3, cerrada en §P4.5.
