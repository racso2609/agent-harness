# Plan de acción — Skill registry lazy (sin clasificador)

## Decisiones por defecto

| Decisión | Valor |
| -------- | ----- |
| Formato | `SKILL.md` con frontmatter compatible opencode (`name`, `description`, opcional `tags`/`triggers`) |
| Ubicación | `~/.racso-harness/skills` + override `RACSO_HARNESS_SKILLS_LOCATION` + `config.skills.dirs[]` |
| Layout | `<dir>/<id>/SKILL.md` y `<dir>/<id>.md` |
| Contexto | solo índice `id — description` (cap 160 chars) |
| Body | on-demand vía tool `use_skill(id)` |
| Clasificador | no, fuera de alcance |
| Allowlist | **opción A**: `use_skill` solo se registra cuando el agente NO declara `tools:` (ver abajo) |

## Allowlist de tools — opción A

`createToolRegistry` filtra las tools a la lista `tools:` del agente. Un agente
como `senior-architect` declara `[readFile, listDir, shell]` a propósito: es de
solo lectura.

Regla: **`use_skill` nunca se añade a un agente que declare `tools:`.** Para
darle skills a un agente con allowlist, se añade `use_skill` a su propio
frontmatter — la decisión queda escrita donde se lee, no escondida en el código.

Consecuencias:

- Agentes sin `tools:` (`default`, `shell-operator`) reciben `use_skill` si
  `skills.enabled` y hay skills cargadas.
- El invariante testeado en `core/tests/session/SessionManager.spec.ts:312`
  (`toEqual(["readFile"])`) se mantiene intacto.
- Es reversible: añadir `use_skill` al `.md` del agente basta para habilitarlo.

Agentes actualizados en este plan: `senior-architect`, `code-reviewer`, `coder`
(lectura de receta, no poder de acción: `use_skill` solo lee markdown).

Nota operativa: los agentes viven en dos sitios y divergen. `core/agents/*.md`
es el set empaquetado que `seed.ts` copia en instalaciones nuevas; el runtime
lee `~/.racso-harness/agents/*.md` y `seed()` no pisa ficheros existentes, así
que **ambos** hay que editar para que el cambio tenga efecto.

## Fase 0 — Tipos y contrato

- `core/src/skills/Skill.ts`: `Skill { id, name, description, tags?, triggers?, body, source }`, `SkillSummary`.
- `core/src/configuration/index.ts`: nuevo `SkillsConfig { enabled, dirs, maxIndexChars, maxBodyChars, preload }`.
- `core/src/utils/env.ts`: `skillsHome()` + `RACSO_HARNESS_SKILLS_LOCATION`, siguiendo el patrón de `agentsHome()`.
- Defaults en `applyDefaults` (mismo idioma que tools/agents/sessions): `enabled: true`, `dirs: [skillsHome()]`, `maxIndexChars: 160`, `maxBodyChars: 16000`, `preload: []`.

## Fase 1 — Parser + discovery

- `parseFrontmatter` ya se exporta desde `agents/parseAgentFile.ts:172` y no depende de agentes. **No se mueve** (refactor cosmético sin valor). Si en el futuro se mueve, debe quedar un re-export para no romper `core/tests/agents/parseAgentFile.spec.ts:2`.
- `skills/parseSkillFile.ts`: valida `name`/`description`/body no vacío; id desde directorio o nombre de archivo; errores → warn + skip.
- `skills/SkillLoader.ts` (patrón de `agents/AgentLoader.ts`): escanea dirs, soporta ambos layouts, dedupe por id (primer dir gana), nunca rompe el boot.
- Aviso de dirs inexistentes: **en `SkillLoader.load()`**, no en `Config` (`readConfig()` es puro y no debe hacer I/O ni loguear; `configuration/index.ts:233-247`).
- `skills/seed.ts` opcional: no en MVP.

## Fase 2 — Registry + índice en system prompt

- `skills/SkillRegistry.ts`: `get(id)`, `list()`, `summaries()`, `indexText(maxChars)`.
- `agents/defaults.ts#composeSystemPrompt(agent, skillIndex?)`: añade bloque al final (sin skills → string byte-idéntico al actual):

  ```
  ## Skills

  Load with use_skill(id) when the task matches:

  - id — description
  ```

- `SessionManager`: cargar el registry en `initialize()` y `load()`; reconstruir tools en los cuatro puntos reales (`constructor:201`, `initialize:217`, `load:268`, `setAgent:482`) y recomponer el prompt en `applySystemPrompt()` (`:878`, invocado desde `:241`, `:273`, `:483`).
- Invariante: **sin skills el system prompt es byte-idéntico al actual** (test de regresión).

## Fase 3 — Tool use_skill + superficie pública

- `core/src/tools/useSkill.ts`: schema `{ id: string }`; devuelve body; id desconocido → `isError` + lista de ids disponibles.
- `ToolContext` es público: **no** se añade `skills?: SkillRegistry`. Se añade `getSkillBody?: (id: string) => string | undefined`, inyectado desde `SessionManager.toolContext()` (`:691`).
- `createToolRegistry`: registra `use_skill` solo si `skills.enabled`, hay skills cargadas **y el agente no declara `tools:`** (opción A).
- Cap de body con `maxBodyChars`; el truncado duro del `ToolRegistry` (`maxOutputBytes`, 32_768) sigue aplicando por encima.
- `IHarness` (`core/src/contract.ts`) gana `listSkills()` y `reloadSkills()`; `harness.ts` delega en `SessionManager`. Es requisito de la Fase 5, se documenta en `core/CONTRACT.md` aquí, no al final.

## Fase 4 — Config + env

- `applyDefaults` normaliza `skills` y rellena defaults.
- Tests de defaults y de config antigua sin bloque `skills`.
- Sin I/O ni logger en `readConfig()`.

## Fase 5 — CLI

- `/skills` — lista id, name, desc, origen.
- `/skill <id>` — imprime el body en terminal (no llama al modelo). Útil para debug.
- `/skill reload` — recarga el registry y refresca el system prompt.
- Registrar en `CommandRepository` y actualizar help.

## Fase 6 — Tests

- `parseSkillFile.spec.ts`: válido, sin descripción, body vacío, listas, inválido.
- `SkillLoader.spec.ts`: ambos layouts, dedupe, dir inválido, multi-dir.
- `SkillRegistry.spec.ts`: truncado de descripción, índice vacío.
- `SessionManager.spec.ts`: índice inyectado, sin skills no cambia, `use_skill` OK / id inválido, **allowlist opción A** (agente con `tools:` no recibe `use_skill`; revisar la aserción de L312).
- `config.spec.ts`: defaults.
- `CommandRepository.spec.ts`: `/skills`, `/skill`, `/skill reload`.
- Verificación final: `pnpm -r build && pnpm -r lint && pnpm -r test`.

## Criterios de aceptación

1. Crear `~/.racso-harness/skills/foo/SKILL.md` → al reiniciar aparece una línea en el system prompt; el body no está en el system prompt.
2. `use_skill("foo")` devuelve el body en el **tool result** de ese turno (el tool result sí queda persistido en el history; lo que nunca ocurre es inyectar el body en el system prompt o en el índice).
3. Skill inválida → warning, boot sigue.
4. Sin skills → system prompt byte-idéntico al actual.
5. Agente con `tools:` declarados no recibe `use_skill` salvo que lo declare.
6. Suite completa verde.

## Fuera de alcance

Clasificador, embeddings, auto-activación, permisos por skill, MCP, registry remoto.

## Archivos

Nuevos: `core/src/skills/{Skill,parseSkillFile,SkillLoader,SkillRegistry}.ts`, `core/src/tools/useSkill.ts`, tests.

Modificados: `core/src/configuration/index.ts`, `core/src/utils/env.ts`, `core/src/agents/defaults.ts`, `core/src/session/SessionManager.ts`, `core/src/tools/{index,Tool}.ts`, `core/src/contract.ts`, `core/src/harness.ts`, `core/src/index.ts`, `core/agents/{senior-architect,code-reviewer,coder}.md`, `~/.racso-harness/agents/{senior-architect,code-reviewer,coder}.md`, `cli/src/commands/CommandRepository.ts`, `README.md`, `core/TODO.md`, `core/CONTRACT.md`.

## Riesgos

- El modelo puede no llamar `use_skill` → descriptions con triggers explícitos.
- Sesiones resumidas: el system prompt se recompone con el índice actual (no se duplica).
- Índice crece con N skills → cap por descripción y warning si `indexText` supera ~2k chars.
- `use_skill` añadido a un `.md` antes de que la tool exista → `createToolRegistry` loguea `unknown tool`; se hace al final del plan.
- Divergencia repo (`core/agents/`) vs runtime (`~/.racso-harness/agents/`): editar ambos.
