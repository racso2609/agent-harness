# TODO — core (@racso2609/core)

Librería base sin interacción: expone el dominio como SDK (`createHarness(deps): IHarness`, ver `CONTRACT.md`) y la consumen el CLI (`cli/TODO.md`) y el gateway (`gateway/TODO.md`), que corren sobre ella en proceso.
El MVP (§0–§8) y §9 están cerrados y su cuerpo vive en los dos fragmentos de `docs/journal/core/`: [0-8-mvp.md](../docs/journal/core/0-8-mvp.md) y [s8-s9-reporting.md](../docs/journal/core/s8-s9-reporting.md).
Formato: skill todo-format. Historial: `docs/journal/core/`.

## Abierto

- **`skills.preload` es decorativo** — §8.1 · `Done when` en §8.1 (sin criterio fijado)
- **`triggers` se parsea y se guarda, pero no se usa** — §8.1 · `Done when` en §8.1 (sin criterio fijado)
- **no hay comando para crear/editar una skill** — §8.1 · `Done when` en §8.1 (sin criterio fijado)
- **`/skill <id>` no imprime el body** — §8.1 · `Done when` en §8.1 (sin criterio fijado)
- **`use_skill` no aparece en el help por agente** — §8.1 · `Done when` en §8.1 (sin criterio fijado)
- **limitación conocida de `SkillLoader`** — §8.1 · `Done when` en §8.1 (sin criterio fijado)
- **orden de commits** — §8.1 · `Done when` en §8.1 (sin criterio fijado)
- **`~/.racso-harness/agents/*.md` divergió del repo** — §8.1 · `Done when` en §8.1 (sin criterio fijado)
- **Devolver los informes largos de un hijo como artefacto, no como mensaje** — §9 · `Done when` en §9
- **Sanitizar apikeys en el history y en los logs** — §Herramientas · `Done when` en §Herramientas
- **Ejecutar tool calls en paralelo detrás de un flag** — §Herramientas · `Done when` en §Herramientas
- **Conectar servidores MCP** — §Herramientas · `Done when` en §Herramientas
- **Abortar el `fetch` en curso al alcanzar `childTimeoutMs`** — §Herramientas · `Done when` en §Herramientas
- **Acotar el reviewer a un diff declarado, siempre** — §4 — Herramientas · `Done when` en §4 — Herramientas

## 4 — Herramientas

Lo que el MVP de tooling dejó abierto: sanitización de secretos, concurrencia, streaming de salida viva, MCP y el aborto real del timeout de un hijo. El cuerpo histórico de §4 y §4.1–§4.3 vive en [journal 0–8](../docs/journal/core/0-8-mvp.md).

- [ ] **Sanitizar apikeys en el history y en los logs**
      Parcialmente cubierto por `core/src/memory/redact.ts`, que redacta al persistir memoria pero no el history ni el log.
      Done when: un test fija que una apikey con forma `sk-…` escrita por el usuario en un prompt no aparece en claro ni en `sessions/*.json` ni en la salida del log.

- [ ] **Ejecutar tool calls en paralelo detrás de un flag**
      Hoy `runAgentLoop` (`core/src/session/SessionManager.ts:890`) hace `for … await` secuencial y `config.tools` no tiene ninguna clave `parallel`; falta el flag, la metadata de paralelizable por tool y el runner con límite.
      Done when: `config.tools.parallel.enabled` existe y un test corre dos `readFile` con el runner de concurrencia y fija que los mensajes `tool` se empujan en el orden original de los `tool_calls`.

- [x] **Streaming de salida viva de una tool (nivel 2)**
      El canal (`ToolContext.onOutput` en `core/src/tools/Tool.ts`) y su consumidor existen: `ShellTool` coalesce por ventana, `SessionManager` lo emite como `ChatEvent` `toolOutput` y el CLI lo pinta en vivo (`CliUiAdapter` y `TuiUiAdapter`).
      Done when: no se fijó uno; el hecho está en el journal.
      hecho: `core/src/tools/shell.ts` (`outputThrottleMs`, default 100) + `cli/src/ui/CliUiAdapter.ts` y `cli/src/ui/TuiUiAdapter.tsx` (pintan `toolOutput` durante el turno) — el cuerpo de §9 lo cubre en [journal §8–§9](../docs/journal/core/s8-s9-reporting.md)

- [ ] **Conectar servidores MCP**
      No hay nada: `mcp` solo aparece como valor del selector de memoria (`core/src/configuration/index.ts`, `core/src/memory/index.ts`) y no existe `mcp.json` ni cliente por stdio.
      Done when: un `mcp.json` con un servidor declarado arranca, expone sus tools en el `ToolRegistry` y un test lo fija contra un servidor fake por stdio.

- [ ] **Abortar el `fetch` en curso al alcanzar `childTimeoutMs`**
      `SpawnManager.startTimeout` (`core/src/session/spawn.ts:243`) sí aborta el `AbortController`, pero el signal solo se chequea antes del `ask` (`SessionManager.ts:677`); el `fetch` en curso sigue vivo tras el timeout.
      Done when: un test aborta a mitad con `AbortSignal` y `ask` termina antes de `childTimeoutMs`, dejando la sesión persistida sin el turno a medias.

- [ ] **Acotar el reviewer a un diff declarado, siempre**
      Hoy la skill `core/agents/code-reviewer.md` exige alcance pero el que llama puede omitirlo, y entonces la revisión barre el repo entero: lee `docs/MEMORY.md`, `docs/INSTALL.md` y módulos que el cambio no nombra. El fallo está en el llamador, no en el reviewer.
      Done when: existe una forma de lanzar la revisión que no dependa de que el llamador se acuerde de los paths, y un caso documentado la demuestra — o bien el prompt del reviewer empieza por un lector de alcance (`git diff --name-only <rango>`) que rellena los paths automáticamente, o bien el TODO/skill obliga a citar el rango en el propio prompt con un ejemplo copiable.

## 8 — Skills

§8 está cerrado (MVP lazy) y su cuerpo vive en [journal 0–8](../docs/journal/core/0-8-mvp.md). Lo abierto es el detalle de §8.1.

1. [x] 4.1 (`tsconfig` + test de `SessionStore`) — sin esto no hay typecheck real.
2. [x] Sandbox de paths (4.2 approval, capa 1) — bug de seguridad.
3. [x] Cablear agente (prompt/tools/approval/maxIterations) — bug funcional; habilita el resto.
4. [x] `normalizeToolMarkup`.
5. [x] Approval allowlist/deny + UI (capas 2 y 3).
6. [] Streaming nivel 1.
7. [] Paralelo (último, detrás de flag).

8. memory — ✅ proveedor local/HTTP/noop, inyección, captura y tool `recall`; deudas en §12.

- define how the memory will work
- select memory provider (postgress, enmgram, etc)

6. mcp connections — ✅ hecho: §11 (stdio y tools), deudas abiertas en §11.1.

7. RAG integration??

8. skills (SKILL.md + discovery) — ✅ parcial/hecho (MVP lazy)

- [x] **tipos + config** — `skills/Skill.ts` (`Skill`, `SkillSummary`), `SkillsConfig { enabled, dirs, maxIndexChars, maxBodyChars, preload }` en `configuration/index.ts`, `skillsHome()` + `RACSO_HARNESS_SKILLS_LOCATION` en `utils/env.ts`. `readConfig()` sigue puro: no valida ni loguea dirs.
- [x] **parser + discovery** — `skills/parseSkillFile.ts` reutiliza `parseFrontmatter` de `agents/parseAgentFile.ts` (sin duplicarlo); `skills/SkillLoader.ts` soporta `<dir>/<id>/SKILL.md` y `<dir>/<id>.md`, primer dir gana, `SKILL.md` gana dentro del mismo dir, ficheros inválidos → warn + skip. Nunca rompe el boot. El aviso de dirs inexistentes vive aquí, no en Config.
- [x] **registry + índice** — `skills/SkillRegistry.ts` (`get/list/summaries/indexText`). `composeSystemPrompt(agent, skillIndex?)` añade el bloque `## Skills` al final **solo si hay índice**: sin skills el prompt es byte-idéntico al anterior (test de regresión).
- [x] **tool `use_skill`** — `tools/useSkill.ts`. `ToolContext` gana `getSkillBody`/`listSkillIds` (getters, no el registry: la interfaz es pública). Body capado por `maxBodyChars` en `SessionManager.skillBody`.
- [x] **allowlist opción A** — `use_skill` solo se registra si el agente NO declara `tools:`. Un agente con lista recibe exactamente su lista; para darle skills se añade `use_skill` a su frontmatter. Preserva `SessionManager.spec.ts` (allowlist `["readFile"]` → exactamente `["readFile"]`).
- [x] **superficie pública** — `IHarness.listSkills()` y `reloadSkills()`; documentado en `CONTRACT.md`.
- [x] **CLI** — `/skills`, `/skill <id>` (sin llamada al modelo ni entrada en el historial), `/skill reload`.
- [x] **tests** — 26 en `tests/skills/` (parser, loader: ambos layouts/dedupe/inválidos/dir ausente, registry: índice vacío y truncado, prompt byte-idéntico, opción A, `use_skill` ok/desconocido, reload sin duplicar el system message) + 6 en `CommandRepository.spec.ts`. Suite 186 (core) + 49 (cli).
- [ ] pendiente: `skills/preload` se parsea pero no se usa (reservado); `triggers` tampoco influyen en nada todavía.

### 8.1 pendientes del MVP lazy (detalle)

- [ ] **`skills.preload` es decorativo.** `SkillsConfig.preload` viaja por `applyDefaults` hasta `SkillLoader` sin que nadie lo lea: hoy toda skill es lazy. Qué falta para que signifique algo: validar que los ids listados existan (warn si no), y decidir qué hace "precargar" sin romper el invariante del prompt byte-idéntico — la opción coherente es **no** inyectar bodies en el system prompt y en su lugar dejar que un preload sea solo un `indexText` garantizado (fallar si una skill listada no carga), o forzar su carga en el primer turno. Riesgo: si se inyectan bodies, el prompt crece con N skills y se pierde el motivo de existir del diseño.
- [ ] **`triggers` se parsea y se guarda, pero no se usa.** `Skill.triggers` y `SkillSummary`/`indexText` lo ignoran hoy: el índice solo muestra `id — descripción`. No hace falta tocarlo mientras el modelo tenga descripciones claras; si se quiere, la vía barata es añadirlo a la línea del índice (`- id — desc ("trig", "trig")`) respetando `maxIndexChars`, y la cara es un clasificador/embeddings, que está explícitamente fuera de alcance.
- [ ] **no hay comando para crear/editar una skill.** Todo es manual (`mkdir ~/.racso-harness/skills/<id>/SKILL.md`). Un `/skill new <id>` que escriba el frontmatter mínimo ahorraría el paso más propenso a errores (olvidar `description` → warn + skip silencioso).
- [ ] **`/skill <id>` no imprime el body.** Hoy `IHarness.listSkills()` devuelve solo `SkillSummary` (sin body), así que el comando imprime nombre, descripción, source y tags. Para volcar el body en terminal —que era la intención original del plan— hace falta exponer `getSkill(id)` en `IHarness` o añadir `skillBody()`; decisión pendiente porque agranda la superficie pública.
- [ ] **`use_skill` no aparece en el help por agente.** Si un agente declara `tools:` sin `use_skill`, no recibe la tool y no hay pista de por qué. Un warn en `createToolRegistry` cuando el agente declara lista, hay skills cargadas y `use_skill` no está en la lista (mensaje tipo "skills loaded but this agent opted out") ahorraría el rato de confusión.
- [ ] **limitación conocida de `SkillLoader`.** Solo lee `.md`; ignora ficheros ocultos; no sigue symlinks de directorio (`withFileTypes` los reporta como symlink, no como dir, así que se saltan). Si alguien organiza skills con symlinks no se cargan y no hay warn.
- [ ] **orden de commits:** `ea4bcb3` (agentes declaran `use_skill`) va antes que `da747e9` (la tool existe). Durante ese hueco, un binario ya instalado loguea `Agent requested unknown tool: use_skill` al arrancar. Inofensivo, pero si se quiere historia limpia hay que reordenar con un rebase interactivo.
- [ ] **`~/.racso-harness/agents/*.md` divergió del repo** (`coder` y `default` con `approval: auto` allí y `ask` en `core/agents/`, más diferencias de texto). `seed.ts` no pisa ficheros existentes, así que ambas copias hay que editarlas a mano — ya pasó con `use_skill`. Decidir si se sincroniza o se documenta el ritual.

Nota: las dos primeras tareas de §8.1 (`skills.preload` y `triggers`) son lo que queda abierto para cerrar el MVP lazy; no hay una tarea de sección aparte que las resuma.

## 9 — Session reporting

§9 está cerrada (8/8): la superficie que consume el histórico desde el CLI vive en
`childHistory()` y `pendingSpawns()`, pintadas al reanudar en `cli/TODO.md` §P1 y
consumidas por la continuación automática en §P6. Sigue abierta «Devolver los informes
largos de un hijo como artefacto, no como mensaje».
El cuerpo narrativo de los nueve ítems cerrados vive en
[journal §8–§9](../docs/journal/core/s8-s9-reporting.md); sus contratos y tests siguen
vigentes y se conservan en la línea `tests:` de cada uno.

- [x] **Exponer `SpawnEvent` y `SpawnStatus` en el contrato público**
      Faltaban `SpawnEvent` y `SpawnStatus` fuera del módulo interno, que es lo que la UI necesita para no acoplarse a `SessionManagerImpl`.
      Done when: no se fijó uno; el hecho está en el journal.
      hecho: `core/src/contract.ts` (reexporta `SpawnEvent`/`SpawnHandle`/`SpawnStatus`) — ver [journal §8–§9](../docs/journal/core/s8-s9-reporting.md)
      tests: `core/tests/session/spawnContract.spec.ts` fija el shape de `started`/`settled`.

- [x] **Añadir un listener de spawn al `IHarness`**
      Expuso `onSpawnEvent()` en el contrato con semántica solo-en-vivo (sin replay), para que la UI reciba eventos sin acoplarse al `SessionManagerImpl`.
      Done when: no se fijó uno; el hecho está en el journal.
      Depends on: exponer `SpawnEvent` y `SpawnStatus` en el contrato público. [x]
      hecho: `core/src/harness.ts#onSpawnEvent` — ver [journal §8–§9](../docs/journal/core/s8-s9-reporting.md)
      tests: 4 en `core/tests/session/SessionManager.spec.ts` (started→settled, unsubscribe, coexistencia con la inyección, listener que lanza). La suscripción interna del mensaje `system` sigue intacta.

- [x] **Devolver estado consultable de los hijos**
      `listSpawns()` solo veía el proceso actual, así que faltaba el histórico persistido para que el CLI pinte tras reanudar sin acoplarse a `SessionManagerImpl`.
      Done when: no se fijó uno; el hecho está en el journal.
      Depends on: añadir un listener de spawn al `IHarness`.
      hecho: `core/src/harness.ts#childHistory` — ver [journal §8–§9](../docs/journal/core/s8-s9-reporting.md)
      tests: 3 en `SessionManager.spec.ts` — shape exacto de un hijo recién lanzado, campos que se añaden al asentar, y `childHistory()` tras reanudar — más uno que verifica que devuelve una copia.
      nota: `listSpawns()` ordena por `startedAt` descendente y `childHistory()` en orden de lanzamiento; la franja normaliza ambas en `spawnStrip`.

- [x] **Persistir eventos de spawn en la sesión**
      Los handles vivían solo en `SpawnManager`, así que tras `/resume` no había rastro de qué hijos corrieron ni cómo terminaron.
      Done when: no se fijó uno; el hecho está en el journal.
      hecho: `core/src/session/SessionStore.ts` (`SessionRecord.spawns`, `SESSION_VERSION` 4) — ver [journal §8–§9](../docs/journal/core/s8-s9-reporting.md)
      tests: 3 en `SessionStore.spec.ts` (round-trip con un hijo `done` y otro `error`, migración v3 → v4, campo omitido si no hay hijos) + 3 en `SessionManager.spec.ts` (persiste el hijo al terminar, persiste el error, no escribe el campo sin hijos).
      contrato: se guarda el **handle final** (`SpawnHandle[]`), no los eventos — el handle ya trae `startedAt`/`finishedAt` y crece O(hijos), no O(reintentos) —, y `spawnHistory` se acumula en memoria y se persiste dentro del `save()` existente; la excepción es el `settled`, que sí llama a `save()`. El campo se **omite** del JSON cuando no hay hijos y al restaurar es histórico de **solo lectura**: los hijos no se reanudan y conservan su `status` persistido.

- [x] **Emitir progreso del turno desde `ask()`**
      `ask()` solo devolvía el `AgentResponse` final y el `_onChunk` del constructor era global del provider, así que no había forma de atribuir eventos a un turno ni de ver tool calls o razonamiento.
      Done when: no se fijó uno; el hecho está en el journal.
      hecho: `core/src/types/providers.ts` (`ChatEvent`/`ChatEventListener`) — ver [journal §8–§9](../docs/journal/core/s8-s9-reporting.md)
      tests: 6 en `core/tests/providers/openai.spec.ts` (texto, `reasoning_content`, fallback `reasoning`, sin razonamiento, `toolCallEnd`, y que omitir `onEvent` no cambia nada).
      contrato: `ChatEvent` = `text` | `reasoning` | `toolCallStart` | `toolCallEnd`; `AssistantTurn.reasoning` guarda el razonamiento y **nunca vuelve al history**; `ask(prompt, { onEvent })` vía `AskOptions`; el `_onChunk` del constructor se deja intacto (dos caminos en paralelo, documentado).

- [x] **Emitir salida viva de `shell` vía `ToolContext.onOutput`**
      Un `shell` largo no mostraba nada hasta terminar, así que se añadió un canal de salida viva independiente del resultado final.
      Done when: no se fijó uno; el hecho está en el journal.
      hecho: `core/src/tools/Tool.ts` (`ToolContext.onOutput`) y `core/src/tools/shell.ts` — ver [journal §8–§9](../docs/journal/core/s8-s9-reporting.md)
      tests: 4 en `core/tests/tools/shell.spec.ts` (stream, sin `onOutput`, stream sin truncar, coalescing) + 2 en `SessionManager.spec.ts` (etiquetado con la call, turno idéntico sin listener).
      contrato: `ShellTool` coalesce los chunks por ventana (`outputThrottleMs`, default 100, `0` lo desactiva) y hace flush al terminar; `SessionManager` lo etiqueta con `id`/`name` de la call y lo emite como `ChatEvent` `toolOutput`. El truncado (`maxOutputBytes`) aplica **solo** al resultado final, no al stream.

- [x] **Incluir un resumen de cierre en `AgentResponse`**
      El usuario tenía que inferir qué pasó en el turno, así que el resultado del turno pasa a ser estructurado.
      Done when: no se fijó uno; el hecho está en el journal.
      hecho: `core/src/session/SessionManager.ts` (`TurnOutcome`, `AgentResponse.outcome`) — ver [journal §8–§9](../docs/journal/core/s8-s9-reporting.md)
      tests: 3 (completed, toolError con la tool nombrada, incomplete por tope de iteraciones).
      contrato: `TurnOutcome { status: "completed" | "toolError" | "incomplete", pending: string[], next? }`; `runAgentLoop` acumula las tools que fallaron (`pending`) y distingue el corte por `tools.maxIterations`. El campo es opcional, así ningún `toEqual` existente cambió. Hoy lo rellena `runAgentLoop`; el camino de `generateImage` no lo emite.

- [x] **Añadir resumen del hijo y duración a `SpawnHandle`**
      La franja del CLI medía el tiempo por su cuenta y, al reanudar, el resumen se perdía porque `childHistory()` solo conservaba `result`/`error`.
      Done when: `SpawnHandle` gana `summary?: string` y `durationMs?: number` (fijados
      al asentar, `durationMs` derivado de `startedAt`/`finishedAt`) y `childHistory()`
      los devuelve al reanudar, con un test en `tests/session/SessionManager.spec.ts`
      que lo comprueba; el CLI pinta la duración desde `durationMs` sin recalcular.
      Depends on: devolver estado consultable de los hijos.
      hecho: `core/src/session/spawn.ts#settle` — ver [journal §8–§9](../docs/journal/core/s8-s9-reporting.md)
      tests: 4 en `core/tests/session/SessionManager.spec.ts` (duración + resumen en éxito, duración en error, supervivencia al guardado/recarga, y record antiguo sin los campos).
      contrato: ambos campos los fija `SpawnManager.settle()`, el punto único al que desemboca el `finally` de `run()` (éxito, error, timeout y cancel); `durationMs` = `Date.parse(finishedAt) - Date.parse(startedAt)` con clamp a 0, y `summary` se deriva del propio hijo (su `result` o su `error`, aplanado a una línea y capado a 120 chars). Sin subir `SESSION_VERSION` (sigue en 4): son opcionales y un record viejo los trae `undefined`.

- [x] **Exponer los hijos asentados con resultado sin entregar**
      Nadie podía saber desde fuera si la entrega del resultado al padre ya ocurrió, que es lo que el CLI necesita para continuar solo tras un `delegate`.
      Done when: una prueba en `core/tests/session/SessionManager.spec.ts` fija que un hijo asentado con el padre sin turno posterior sigue en la lista y solo desaparece cuando el padre ejecuta un turno que inyecta su resultado como mensaje system (el punto de inyección en SessionManager.ts), y que la lista vuelve vacía cuando ya no queda ningún hijo sin entregar.
      Depends on: nada.
      hecho: `core/src/session/SessionManager.ts#pendingSpawns` — ver [journal §8–§9](../docs/journal/core/s8-s9-reporting.md)
      tests: 8 casos en `core/tests/session/SessionManager.spec.ts` — «reports a settled child until the parent runs the turn that delivers it», «persists the delivered child result even when the turn then fails», «delivers two settled children in settlement order», «does not report a running child as pending», «hands out a copy of the pending children, not its own array», «queues a settled child that was never delivered when the session is resumed», «does not queue a child already delivered before the resume» y «does not queue a child that was still running when the process died».
      nota: `deliveredSpawns` no sube `SESSION_VERSION` (sigue en 4); un record anterior se lee como «nada entregado» y el peor caso es volver a entregar un resultado una vez.
      Consumidor: `cli/TODO.md` §P6, tarea «Arrancar un turno sin prompt cuando un hijo deja trabajo».

- [ ] **Devolver los informes largos de un hijo como artefacto, no como mensaje**
      `formatSpawnResult` (`SessionManager.ts:690`) trunca el resultado del hijo antes de inyectarlo en el history del padre con `truncateText` (`SessionManager.ts:75`), que corta a `sessions.childResultMaxChars` (default 2000) y añade `…`; medido en una sesión real, un hijo devolvió **4360 caracteres** y el padre recibió **2000**, así que los informes de agentes revisores (hallazgos con severidad y `fichero:línea`) no caben y el padre decide sobre un texto cortado a mitad de frase.
      El texto íntegro **no se pierde**: se persiste en `~/.racso-harness/sessions/<id>.json` → `spawns[].result`, pero el padre no lo ve.
      Done when: un hijo cuyo resultado supere `childResultMaxChars` deja el texto íntegro en un fichero (bajo el directorio de la sesión o en la ruta que el propio hijo declare; el padre la conoce), el mensaje `system` inyectado en el padre contiene esa ruta más un resumen de como máximo N caracteres, y un test en `core/tests/session/SessionManager.spec.ts` fija ambos hechos (texto completo recuperable desde la ruta + mensaje del padre acotado a N).
      Alternativa descartada: subir `childResultMaxChars` sólo mueve el problema (más contexto consumido por cada hijo, y con `maxChildren: 4` el coste se multiplica), no lo resuelve.
      Depends on: nada.

### 9.1 orden sugerido

1. [x] Contrato: `SpawnEvent`/`SpawnStatus` reexportados + `listSpawns()` ya expuesto en `IHarness`.
2. [x] Listener de spawn en `IHarness`.
3. [x] `onEvent` en `ask()` + `reasoning` en el provider.
4. [x] Persistencia de handles + migración de `SessionStore`.
5. [x] `ToolContext.onOutput` (shell vivo).
6. [x] Resumen de cierre estructurado.
7. [x] Hijos asentados con resultado sin entregar (desbloquea `cli/TODO.md` §P6) — `pendingSpawns()` (`SessionManager.ts:640`, `contract.ts:128`), cubierto por los 8 casos del ítem correspondiente.

Nota: los puntos 1–2 desbloquean `cli/TODO.md` §P1; el 3 desbloquea §P3; el 7 desbloquea §P6.

## 10 — Gateway

Las 16 tareas de F0–F5 viven en [gateway/TODO.md](../gateway/TODO.md). Bloqueadas por la verificación de F0 (`cli/TODO.md` §P4).

## Ritual de agentes

Regla viva, no registro de lo hecho: rige cada vez que se toca un agente.

ritual (firmado 2026-11-02): **el repo es la fuente**; `~/.racso-harness/agents/` es una copia que solo se siembra en instalaciones nuevas. Un cambio en `core/agents/*.md` **no llega** a una copia existente, así que al tocar un agente hay que decidir explícitamente: (a) copiar a mano el fichero a `~/.racso-harness/agents/`, o (b) dejarlo solo en el repo y anotar que el usuario sigue con la versión vieja. Nunca las dos cosas a medias.

por qué no se sincroniza automáticamente: pisar el directorio del usuario borraría agentes editados a mano y el error no se vería en un `git diff`. Una sincronización con backup (`*.md.bak`) es una tarea aparte, no parte del ritual.

nota (2026-11-02): `default` diverge además en algo funcional, no de texto: la copia de runtime dice `approval: auto` y el repo `ask`. Con `ask`, `git`/`pnpm`/`tsc`/`vitest` no piden permiso (`READ_ONLY_COMMANDS` en `tools/shellPolicy.ts`), pero cada `writeFile` sí — y en un hijo headless sin handler la respuesta es **deny**, no una pregunta (`SessionManager.ts:855`). Por eso `approval` no se toca en el ritual de agentes: se decide en una tarea propia.

## Decisiones vigentes

- **`ChatEvent` es el único canal de progreso del turno** (`text`/`reasoning`/`toolCallStart`/`toolCallEnd`/`toolOutput`) — el razonamiento nunca vuelve al history y el truncado no aplica al stream · §9
- **Los eventos de spawn se persisten como handle final, no como eventos** (`SessionRecord.spawns`, `SESSION_VERSION` 4) — el coste crece O(hijos), no O(reintentos) · §9
- **El histórico restaurado es solo lectura** — un hijo reanudado no se puede `poll`/`wait`/`cancel` ni debe parecer que sí · §9
- **`onSpawnEvent()` es solo en vivo, sin replay** — el estado inicial se reconstruye con `listSpawns()` y `childHistory()` · §9
- **`TurnOutcome` y los campos nuevos de `SpawnHandle` son opcionales** — no suben `SESSION_VERSION` ni rompen un record antiguo · §9
- **`deliveredSpawns` marca la entrega del resultado al padre** — sin subir `SESSION_VERSION`; el peor caso es reentregar una vez · §9

## 11 — MCP (servidores de tools por stdio)

§11 está cerrado como MVP (fase 5 de 5, solo documentación). MCP está
funcionalmente completo: config, conexión stdio, tools con aprobaciones, API
pública (`listMcpServers`, `reloadMcp`, `mcpTools`, `closeMcp` en `IHarness`),
`/mcp` y `/mcp reload` en el CLI y cierre limpio al salir. Lo que queda abierto
son límites de alcance y deudas medidas, no trabajo a medias.

- [x] **tipos + config** — `mcp/McpConfig.ts` (`McpConfig`, `McpServerConfig`, `ResolvedMcpServer`) y los siete campos con sus defaults (`enabled`, `servers`, `maxDescriptionChars`, `maxToolsIndexChars`, `startupTimeoutMs`, `callTimeoutMs`, `maxConcurrentCalls`). `resolveMcpServers` nunca lanza: un servidor inválido se avisa y se ignora, y solo un `enabled: true` literal arranca algo.
- [x] **nombres compuestos** — `mcp/mcpNaming.ts` (`mcp__<server>__<tool>`, saneado a `[a-z0-9_]` y colapso de `_` en el nombre remoto para que el parseo sea reversible). Tests en `tests/mcp/mcpNaming.spec.ts`.
- [x] **conexión stdio** — `mcp/McpConnection.ts` sobre `@modelcontextprotocol/sdk`: handshake con `startupTimeoutMs`, `tools/list` paginado y deduplicado, `tools/call` con `callTimeoutMs`, `AbortSignal`, progreso y cierre del transporte en el camino de fallo.
- [x] **kill del árbol de procesos** — `mcp/killTree.ts`: SIGTERM a cada pid del árbol (recorrido con `ps`, porque el transport no usa `detached`) y SIGKILL a los que sigan vivos tras `KILL_GRACE_MS`.
- [x] **manager y tools** — `mcp/McpManager.ts`: una conexión perezosa por servidor, descubrimiento asíncrono con dedupe por `generation`, `invalidate()` para recargar, `CallLimiter` por servidor y `close()` terminal e idempotente. Cada tool remota se ofrece como `Tool` del harness con el gate de aprobación dentro de `execute`.
- [x] **proveedor en el registry** — `ToolRegistry.addProvider()` y `createToolRegistry` instalan un solo proveedor MCP, con el filtro de allowlist y los nombres nativos para que una tool remota no pueda pisar una de casa.
- [x] **superficie pública** — `IHarness.listMcpServers()`, `reloadMcp()`, `mcpTools()` y `closeMcp()`, más el cierre en `shutdown()` y en el guardado fallido del CLI.
- [x] **CLI** — `/mcp` (servidores y tools, sin arrancar nada) y `/mcp reload`; el apagado del proceso espera al cierre con tope de tiempo.
- [x] **kill-switch por entorno** — `RACSO_HARNESS_MCP_DISABLED` (`1`/`true`/`yes`) apaga MCP aunque la config lo encienda.
- [x] **tests** — `tests/mcp/` (config, naming, schema, env, killTree, connection contra un fixture stdio escrito a mano, manager, registry y sesión), con el barrido de huérfanos al final de la suite.

### 11.1 límites y deudas abiertas

- [ ] **Soportar transports remotos (HTTP / SSE / streamable HTTP)**
- Solo existe stdio: el tipo `McpTransportName` y el campo `transport` se escribieron con un único miembro justamente para que los `config.json` de hoy sigan valiendo cuando se añada el resto.
- Done when: un `config.json` con `transport: "http"` y una `url` arranca una conexión contra un servidor HTTP de prueba y `resolveMcpServers` deja de descartarlo con `unsupported transport`, con test en `tests/mcp/McpConfig.spec.ts` y otro en `tests/mcp/mcpConnection.spec.ts`.

- [ ] **Añadir resources, prompts y el resto de primitivas MCP**
- Hoy solo se habla `tools/*`: resources, prompts, sampling, elicitation, roots, logging y completions quedaron fuera por decisión de diseño.
- Done when: `McpConnection` expone `resources/list` y `prompts/list`, el CLI los muestra y un test lo fija contra el fixture; antes hay que decidir si resources y prompts se ofrecen como tools o como contexto inyectado.

- [ ] **Releer `config.json` en `reloadMcp`**
- `reloadMcp` invalida conexiones y redescubre, pero los servidores son los que la config tenía al construir la sesión: un servidor añadido al fichero obliga a reiniciar el CLI.
- Done when: añadir un servidor a `config.json` con la sesión abierta y ejecutar `/mcp reload` lo lista y lo arranca, con test en `tests/mcp/sessionMcp.spec.ts` que fije que el manager se reconstruye desde el fichero.

- [ ] **Fijar la gracia de `KILL_GRACE_MS` en el camino real de `doClose()`**
- El fixture sale al cerrarse su stdin, así que `doClose() → killProcess() → killProcessTree` nunca llega a gastar la gracia y la única evidencia es el test que llama a `killProcessTree` con el mismo `KILL_GRACE_MS`, documentado como tal en `tests/mcp/mcpConnection.spec.ts`.
- Done when: un servidor de prueba que ignora el final de stdin y no muere con SIGTERM deja medir el hueco entre el SIGTERM y el SIGKILL a través de `close()`, y un test lo fija sin llamar a `killProcessTree` directamente.

- [ ] **Hacer que el guard `isClosed()` de `reloadMcp` discrimine**
- Hoy es decorativo: `doClose()` vacía `state`, así que un manager cerrado ya devuelve `[]`, ningún test distingue quitarlo y el código lo dice tal cual.
- Done when: un test falla al borrar el guard o, si no hay forma de que discrimine, se borra el guard y su comentario.

- [ ] **Resolver la allowlist MCP en el primer `specs()`**
- Un agente con `tools:` recibe exactamente los `mcp__<server>__<tool>` que nombra, pero solo desde el segundo lookup: el descubrimiento es asíncrono y un nombre que no resuelve a tiempo falla con `Unknown tool`, igual que una errata.
- Done when: un agente con allowlist recibe su tool MCP en el primer turno, con test que fije que el primer `specs()` ya la contiene; la vía natural es esperar al descubrimiento en el arranque de la sesión cuando la allowlist nombra tools `mcp__*`.

- [ ] **Detectar nietos huérfanos de un servidor muerto por SIGKILL externo**
- Si alguien mata el servidor por fuera, sus hijos quedan re-parentados a init y el harness no puede matar lo que el padre dejó atrás.
- Done when: un barrido encuentra los procesos marcados con el `id` del servidor y avisa por log y en `listMcpServers()`, con test que mate el servidor con SIGKILL y compruebe el aviso. Lo que ya se garantiza es que la fuga nunca es silenciosa: el barrido de los tests la detecta y falla.

- [ ] **Recortar el peso de `@modelcontextprotocol/sdk`**
- La dependencia cuesta +80 paquetes en el store (329 → 409) porque arrastra express, hono, cors, jose y eventsource para los transports remotos y el lado servidor que no se usan; en runtime solo se cargan `cross-spawn`, `zod` y ajv.
- Done when: el store baja de 409 sin perder la conexión stdio, o queda escrito por qué no se puede; la vía a medir es importar solo los subpaths de cliente y stdio y comprobar que el paquete no carga express ni hono.

- [ ] **Usar o retirar `mcp.maxToolsIndexChars`**
- Los defaults le dan 2000 y ningún lector lo consume: el índice de tools remotas no se recorta con él, así que el campo promete un comportamiento que no existe.
- Done when: el índice de tools MCP entregado al modelo respeta `maxToolsIndexChars`, con test que fije el recorte, o el campo desaparece de `McpConfig` y de la documentación.

- [ ] **Documentar MCP en `CONTRACT.md`**
- `CONTRACT.md` describe el SDK publicado y hoy no contiene una sola referencia a MCP, así que los cuatro métodos nuevos de `IHarness` solo existen para quien lea el fuente.
- Done when: `CONTRACT.md` describe el bloque `mcp` de la config, `listMcpServers`/`reloadMcp`/`mcpTools` y el contrato de `closeMcp` (idempotente, terminal, llamado desde `shutdown()`).

### 11.2 descartados de la sección 11

- **Reintentar solo un servidor que falló** — un reintento automático arrancaría un proceso en cada `tools()`; el manager no reintenta por diseño y lo que hay es `invalidate()`, expuesto por `reloadMcp()` y `/mcp reload`.
- **Usar `sync.Once` para el init de MCP** — es la trampa de picoclaw listada en el README: recargar config lo mataría para siempre. El manager no tiene estado de módulo y su único guard es la promesa de descubrimiento en vuelo.
- **Aceptar un `command` con espacios y partirlo en programa + args** — no siempre es un copy-paste de otro cliente: una ruta como `/Applications/My App/bin/server` es un ejecutable legítimo y adivinar mal cambia qué se ejecuta. Se rechaza con un mensaje explícito que dice qué mover a `args`.

## Historial

- §0–§8 (el MVP: split core/cli, session manager, agentes, tooling y skills) — cerrado; el cuerpo literal vive en [journal 0–8](../docs/journal/core/0-8-mvp.md)
- §9 — session reporting: cerrada salvo «Devolver los informes largos de un hijo como artefacto», [journal](../docs/journal/core/s8-s9-reporting.md)
- §10 — gateway persistente: mudada a [gateway/TODO.md](../gateway/TODO.md)
- Las dudas que no son tareas (vault local vs apikeys hasheadas, RAG) viven en [`TO_INVESTIGATE.md`](../TO_INVESTIGATE.md)
