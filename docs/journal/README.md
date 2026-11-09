# Journal — historial de lo cerrado

Índice: [`../../TODO.md`](../../TODO.md) · TODO vivo: [`../../cli/TODO.md`](../../cli/TODO.md) (y el del paquete de cada fragmento)

Este directorio es el **sumidero** de los ítems ya cerrados (`[x]`) de los TODO por
paquete. Es una mudanza: el cuerpo de cada ítem se copia **literal** del TODO original
(con sus `hecho:`, `decisión:`, `tests:`, `revert:`, `pendiente:`, `riesgo conocido:`,
`nota:` y párrafos), nunca se resume ni se recorta. Los TODO vivos
([`cli/TODO.md`](../../cli/TODO.md), [`core/TODO.md`](../../core/TODO.md),
[`gateway/TODO.md`](../../gateway/TODO.md)) se quedan solo con lo abierto.

## Fragmentos

| Fecha | Paquete | Fragmento | Qué contiene | Commits |
| --- | --- | --- | --- | --- |
| 2026-11-01 | cli | [P0](cli/p0-tui-stack.md) | Stack ink 8 + React 19, `UiAdapter`, pantalla base con approval, franja de progreso | `907fc4a` |
| 2026-11-01 | cli | [P1](cli/p1-turn-feedback.md) | Eventos de spawn en la UI, trabajo en curso, estado por subagente, hijos restaurados | `907fc4a`, `267d271`, `dc0b630` |
| 2026-11-01 | cli | [P2](cli/p2-outcome-contract.md) | Contrato de resultado de spawn, aviso del estado final del hijo, cierre del turno | `907fc4a`, `ec23080` |
| 2026-11-01 | cli | [P3](cli/p3-transcript.md) | Razonamiento en streaming, salida viva de `shell`, stream formateado, colapso, aire | `9bec14b`, `306fd80`, `eae7964` |
| 2026-11-04 | cli | [P4 empaquetado](cli/p4-packaging.md) | Scope `@racso2609`, imports, `files`, `private` y `workspace:^`, `engines.node`, deps, `.npmrc` | `6026a65`, `a785a72`, `3e08d25` |
| 2026-11-05 | cli | [P4 publicación](cli/p4-publish.md) | Tarballs y publicación, release `v1.0.0`, README, smoke test | `6026a65`, release `v1.0.0` |
| 2026-11-03 | cli | [P4.5](cli/p45-scroll-logger.md) | Transcript en líneas visuales, rueda del ratón y recorte, logger silenciado | `4585cf0`, `65ee2a6` |
| 2026-11-06 | cli | [P5 `/resume`](cli/p5-resume.md) | Reanudar una sesión repinta el transcript en los dos renderers | `0413bf2`, `4ef6dd0` |
| 2026-11-04 | cli | [P5 tests](cli/p5-renderer-tests.md) | Aserciones tautológicas cambiadas por literales exactos, con barrido de revert | `729f621` |
| 2026-11-02 | cli | [P6](cli/p6-auto-continuation.md) | `pendingSpawns()`, turno sin prompt, tope de continuaciones, aviso en el cierre | `9afaab0`, `c48b9a1` |
| 2026-11-07 | core | [0–8](core/0-8-mvp.md) | split core/cli, session manager, agentes, tooling §4.1–4.3, MVP lazy de skills | — |
| 2026-11-07 | core | [§8–§9](core/s8-s9-reporting.md) | Contrato de spawn público, listener, estado consultable, persistencia, progreso, `onOutput`, cierre | `baf5b93`, `267d271`, `c48b9a1`, `d92b818` |

## Convención

1. Un fragmento por **tema/fase**, nunca por ítem; si pasa de 120 líneas se parte por fase con sufijo (`p4-packaging.md` / `p4-publish.md`).
2. Cada ítem entra como `### <Título exacto del TODO>` seguido de su cuerpo original **literal**: esto es un sumidero, no un resumen.
3. El TODO vivo no enlaza cada fragmento desde cada ítem: este índice es el mapa; el TODO enlaza el fragmento de cada sección.
