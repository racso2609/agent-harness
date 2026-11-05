0. split core/cli

- [x] renombrar `backend/` → `core/` y publicar el paquete como `@racso/core`
- [x] exponer el dominio como SDK sin interacción: `createHarness(deps): IHarness` (ver `CONTRACT.md`)
- [x] logger inyectable (`createLogger(sink)` / `setLogger`), sin `clearPrompt`/`restorePrompt` en core
- [x] `Config` sin setup interactivo: `needsSetup()`, `validateConfig()`, `configureProvider()`, `writeConfig()`
- [x] `SessionManager` con primitivas: `setProvider`, `setModel`, `setAgent`, `resolveSession`, `listProviders`, `approveWith`
- [x] mover `MainLoop`, `CommandRepository`, `stdin`, logo, `status` y los flujos interactivos a `cli/`
- [x] workspace raíz (`pnpm-workspace.yaml`) con `core/` y `cli/`; `pnpm -r build|lint|test`

- [x] Provider capabilities detection for loaded model
- [-] Configuration class turn on configuration mode if something missing
- [] Sanitize apikeys
- definir si usar vault local (creo que seria mejor esta)
- archivos con apikeys hasheadas

3. session manager

- [x] send initial config params per session
- maxMessage, autocompact: boolean, tokens limit etc
- [x] prompt classification text generation or image generation
- [x] `/sessions` (alias `/session`) lista sesiones persistidas con título, provider/modelo y conteo de mensajes
- [x] `/resume <id|prefijo|índice>` (alias `/switch`) cambia de sesión persistiendo la actual; sin argumento abre un `select` interactivo
- [x] `conversation(): ConversationEntry[]` — la conversación como la lee la UI (solo `user`/`assistant`, sin persona, memoria de compactación, salida de tools ni turnos `unprompted` que nadie escribió, en copia y del más antiguo al más reciente), para que la UI repinte una sesión reanudada. Dueña de la tarea: `cli/TODO.md` §P5 «`/resume` dejaba en pantalla la conversación de la sesión anterior».

3.1 agents

- [x] `default` reescrito como organizador de problemas (clases basic/c1/c2/c3, lista de tareas atómica, gate de aprobación)
- [x] `senior-architect`: solo lectura (`readFile`, `listDir`, `shell`), diseña y produce plan ejecutable, nunca escribe código
- [x] `coder`: modelo barato (`deepseek-v4.1-flash-1017`), implementa un plan aprobado con cambios mínimos
- [x] copiar `core/agents/*.md` a `~/.racso-harness/agents/` (el loader en runtime solo lee `agentsHome()`, no `core/agents/`)
- [x] **seed del directorio de agentes en runtime** — `ensureAgentsDir` copia el set de ejemplo si el target no tiene `.md`
  - review: `AgentLoader` carga `agentsHome()` (`{HOME}/.racso-harness/agents`, override `RACSO_HARNESS_AGENTS_LOCATION`) y cae al agente `default` embebido si no existe. Los `.md` de `core/agents/` nunca se leen en runtime.
  - hecho: `src/agents/seed.ts#ensureAgentsDir(target, source)` copia `*.md` solo si el target no tiene ninguno (no pisa agentes del usuario); `bundledAgentsDir()` resuelve `<pkg>/agents` vía `import.meta.dirname/../..`, válido tanto en `src/` como en `dist/`. `AgentLoader.seed()` lo invoca y `SessionManager.loadAgentRegistry()` lo llama antes de `load()`. Tests en `tests/agents/seed.spec.ts` (5 casos). Verificado: desde `dist/agents/seed.js` resuelve `<pkg>/agents` y existe.
- [x] **modelo por agente al cargar** — cableado confirmado y cubierto por tests
  - review: `AgentDefinition.model`/`provider` existen; `SessionManager` los resuelve en `initialize` (L169-183) y `changeAgent` (L420-444).
  - hecho: `changeAgent` ya crea el provider con `agent.model ?? actual ?? config.model` y `agent.provider ?? ...`, y actualiza `this.providerName`/`this.model`. Tests: switch de agente sin override de modelo → misma config (no recrea provider); con `model` → provider recreado con el modelo efectivo de `status()`.
- [x] **spawn de agentes en background para paralelizar** — lanzar agentes en sesiones secundarias y delegarles contexto
  - review: hoy un turno bloquea la sesión; no hay forma de lanzar trabajo independiente ni de recolectar su resultado. `SessionManager.runAgentLoop` es síncrono por turno.
  - propuesta: `spawn(agentId, prompt, { context })` → crea una `Session` hija (persistida, marcada con `parentId`) y la corre fuera del turno principal; el padre recibe un `spawnId` y puede `wait`/`poll`/`collect`. Reutilizar `SessionStore` para persistir hijas; aislar el contexto (sin compartir history mutable). Concurrencia acotada (`config.tools.parallel` o nuevo `config.sessions.maxChildren`). Comandos CLI (`/spawn`, `/children`, `/join`) después. Riesgo medio-alto: toca `SessionManager`, `SessionStore` y el modelo de sesión; hacerlo detrás de flag.
  - hecho: `src/session/spawn.ts#SpawnManager` (registry in-memory de jobs por padre, concurrencia FIFO con `maxChildren`, `startTimeout` aborta via `AbortController`, `spawn`/`poll`/`list`/`wait`/`collect`/`cancel`). `SessionManager`: `spawn/pollSpawn/listSpawns/waitSpawn/collectSpawns` + runner que crea un `SessionManagerImpl` hijo aislado (history/usage/provider propios) e `initialize({ agent })`; `parentId` persistido en `SessionRecord` y restaurado en `load`. Config `sessions: { spawnEnabled (default true), maxChildren (4), childTimeoutMs (300_000), childResultMaxChars (2000) }`. CLI `/spawn <agent> <prompt>`, `/children`, `/join <spawnId>`. Tests: `tests/session/spawn.spec.ts` (7), `SessionManager.spec.ts` spawn (5), `CommandRepository.spec.ts` spawn (5). Suite 180/180 verde, lint y build limpios.
  - hecho (event-driven): `SpawnManager.on(listener)` emite `started`/`settled` (`SpawnEvent`); errores de listener no rompen el scheduler. `SessionManager` se suscribe y, al `settled`, inyecta SOLO la respuesta final formateada como mensaje `role: system` en el history del padre (`[spawn <id> · <agente> · <status>]` + texto truncado a `childResultMaxChars`). El history completo del hijo nunca se comparte. El padre lo ve en su próximo turno sin bloquearse. Tests: emitter (4) + inyección/error (2). Suite 186/186 verde.
  - pendiente v2: abortar el `fetch` en curso al timeout (hoy el signal solo se chequea antes del `ask`); UI de progreso de hijos.

4. Tooling

- [x] diseño definido:
- loop ReAct vive en `SessionManager`; el provider solo es transporte
- tool calls **secuenciales** en v1
- approval `auto` en v1; límites/sandbox después
- convención: tipos propios camelCase; snake_case solo en DTOs wire (`types/openai.ts`), mapeo en `OpenAiProvider`
- [x] extender `History` con `toolCalls` / `toolCallId`; `ToolCall { id, name, args, rawArgs?, parseError? }`
- [x] `OpenAiProvider.chat(messages, { tools })` + mapeo dominio <-> wire (`toolCalls`/`toolCallId` <-> `tool_calls`/`tool_call_id`, `finishReason` <-> `finish_reason`)
- [x] `_handleStream`: acumular `delta.tool_calls` por `index` y capturar `finish_reason`
- [x] `tools/Tool.ts` + `ToolRegistry` (specs, execute, nunca lanza: error vuelve como `ToolResult.isError`)
- [x] `tools/shell.ts`: spawn `bash -lc`, cwd, timeout, matar grupo de procesos, cap de output, env filtrado
- [x] `tools/readFile.ts`, `tools/writeFile.ts`, `tools/listDir.ts`
- [x] loop ReAct en `SessionManager` con límite `tools.maxIterations`
- [x] acumular usage/cost en **cada** iteración del loop
- [x] truncar tool results antes de entrar al history (registry) y en `summarize`
- [x] render de tool calls en CLI vía `logger` (limpia/redibuja el prompt)
- [x] config `tools`: `enabled`, `maxIterations`, `approval`, `workspace`, `maxOutputBytes`, `shell.timeoutMs`, `shell.maxOutputBytes`
- [x] tests: streaming con `tool_calls`, registry, loop con provider fake, shell
- pendientes / decisiones abiertas:
- [x] validación de args: manual por tool (sin `zod`); cada tool valida y lanza, el registry convierte en `isError`

### 4.1 correcciones previas (bloquean una verificación real) — review 2026-10-31

- [x] `tsconfig.json`: `rootDir` está en `src` pero `include` trae `tests/**` y `scripts/**` (TS6059 en cascada) + `baseUrl` deprecado (TS5101) + `moduleResolution: "bundler"` con `module: "NodeNext"` (TS5095/TS5109). `tsc --noEmit` hoy falla antes de tipar nada → cualquier pendiente nuevo entra sin typecheck. → `include: ["src/**/*"]`, `module: "ESNext"` + `moduleResolution: "bundler"`, `paths: { "@/*": ["./src/*"] }` (sin `baseUrl`). `pnpm build` OK.
- [x] `tests/session/SessionStore.spec.ts` — ya espera `version: 3`; suite verde (123/123).
- [x] `eslint.config.ts`: usaba `globals.browser` (`process`/`Buffer`/`__dirname` undefined) y no ignoraba `dist/`. → `globals.node` + `ignores: ["dist/**", "node_modules/**"]`. `pnpm lint` limpio.
- [x] lint `no-explicit-any` en `basic.ts` (quitar `<T = any>` del overload de stream) y `no-console` en `stdin.ts` (helper `write` para render de terminal).
- [x] cablear el agente en `SessionManager`: `agent.tools` (L151/201/432), `agent.maxIterations` (L486), `agent.approval` + `strictestApproval` (L569) y `composeSystemPrompt` (L718) ya están cableados. La nota de que "se parsean pero se ignoran" quedó obsoleta.
- [x] `OpenAiProvider`: type-only imports → aplicado `import type` en `openai.ts` (dominio) y `import type` en los tipos wire que no se usan en runtime; seguro bajo `verbatimModuleSyntax`/`isolatedModules`.
- [x] `shell`: usa `process.env.SHELL` con fallback a `bash` del `PATH` (y `/bin/bash` en POSIX); documentado que en win32 no aplica `detached`/`kill(-pid)`.
- [x] `runAgentLoop` prefija `[tool error] …` cuando `isError` es `true` y garantiza un `tool` message por cada `tool_call` en el mismo orden (incluye calls con `parseError`).

### 4.2 pendientes de tooling (propuesta revisada, con orden y estimación)

- [x] **normalizar tool calls que llegan como texto plano (DeepSeek)** — `normalizeToolMarkup`
- review: hoy solo se leen `delta.tool_calls`; los modelos que emiten `<tool_call>{json}</tool_call>`, fences `tool_call` o el markup `<|tool▁calls▁begin|>` devuelven `finishReason: "stop"` con JSON crudo en `text` y el loop corta.
- propuesta: `src/providers/normalizeToolMarkup.ts` → `normalizeToolMarkup(turn): AssistantTurn`, aplicado en `OpenAiProvider.chat()` solo si `turn.toolCalls.length === 0`. Patrones en orden (tool_call tags, fences, DeepSeek); si el JSON no parsea se deja el texto intacto + `logger.debug` (evitar falsos positivos). Al matchear: limpiar markup del `text`, ids sintéticos, `rawArgs` normalizado, `finishReason: "toolCalls"`. Flag `tools.normalizeTextToolCalls` (default `true`).
- tests: unit del normalizer (3 formatos, mixto, falso positivo, JSON inválido) + e2e en `openai.spec.ts` con stream con markup. ~120 LOC + ~80 LOC tests. Riesgo bajo.
- [-] **límites de approval: allowlist read-only, deny patterns, sandbox de `workspace`** (capas 1-3 hechas)
- review: `writeFile`/`readFile`/`listDir` **nunca** llaman `ctx.approve` y aceptan rutas absolutas y `../..` (el `cwd` es cosmético: se puede leer/escribir cualquier ruta sin prompt). `approval: "ask"` solo cubre `shell` y su firma `approve(command: string) => boolean` no alcanza para "allow once / always". En `auto` no hay deny list. `agent.approval` + `strictestApproval` ya cableados (L569).
- propuesta en 3 capas:
  - [x] capa 1: `src/tools/paths.ts#resolveInWorkspace` (`resolve` + `realpath` + `startsWith(root + sep)`, cubre symlinks) aplicado en los 3 file tools; `writeFile` rechaza `.git/` y `config.tools.writeDeny` (glob simple con `*`). Tests en `paths.spec.ts` y `writeFile.spec.ts`.
  - [x] capa 2: `src/tools/shellPolicy.ts` con `READ_ONLY_COMMANDS` + `DENY_PATTERNS` (`rm -rf /`, `curl | sh`, `dd if=`, `git push --force`, …) y nuevo `ToolContext.approve(req: ApprovalRequest) => Promise<"allow"|"deny">` con `{ tool, command, kind: read|write|exec }`; tabla por modo (`auto`: read-only/dir allow, exec con deny list; `ask`: prompt en write/exec no read-only; `deny`: solo reads; las tres respetan deny list).
  - [x] capa 3: "always allow" en memoria por sesión + UI de approval.
- estimación restante: capa 2 ~3h, capa 3 ~2h. Riesgo medio: cambia la firma de `ToolContext` → tocar los 4 tools, ambos specs y `SessionManager.toolContext()`.
- [] **tool calls en paralelo**
- review: hoy `for … await` secuencial en `runAgentLoop`. Riesgos reales: N `shell` en paralelo saturan la máquina, `writeFile` a la misma ruta es race, dependencias implícitas de orden en el modelo, y OpenAI exige que los `tool` messages vayan en el mismo orden que los `tool_calls`.
- propuesta: `config.tools.parallel: { enabled, maxConcurrency }` (default `false`/`4`), metadata `Tool.execution.parallelSafe` (`readFile`/`listDir` `true`; `writeFile`/`shell` `false`), `ToolRegistry.parallelizable(calls)`, `src/utils/concurrency.ts#runWithLimit` (~20 LOC, sin `p-limit`); recolectar resultados y recién entonces empujar los `tool` messages en el orden original. ~1.5h. Riesgo bajo detrás de flag; no activar por default sin métrica de calls múltiples.
- [] **streaming de tool calls al usuario en tiempo real** (hoy se loguea al completar cada call)
- review: `_onChunk` solo emite `content`; los `delta.tool_calls` se acumulan en silencio → un `shell` de 30s no muestra nada. El consumidor real es `logger`, así que no hace falta UI nueva. Emitir cada delta de `arguments` es ruido (JSON en pedacitos).
- propuesta nivel 1: reemplazar `onChunk` por `onEvent: (e: ChatEvent) => void` con `ChatEvent = text | toolCallStart | toolCallDelta`; `toolCallStart` se emite una sola vez por `index` (al aparecer `function.name`) y `SessionManager` lo loguea vía `logger.transient` ("→ shell …"). Nivel 2 (post-MVP): `ToolContext.onOutput?: (chunk) => void` que `ShellTool` llama con throttle ~100 ms para salida viva (el truncado sigue aplicando al resultado final, no al stream). Nivel 1 ~1h riesgo bajo; nivel 2 ~2h riesgo medio (no romper el redibujado del prompt en `stdin.ts`).

### 4.3 orden sugerido

1. [x] 4.1 (`tsconfig` + test de `SessionStore`) — sin esto no hay typecheck real.
2. [x] Sandbox de paths (4.2 approval, capa 1) — bug de seguridad.
3. [x] Cablear agente (prompt/tools/approval/maxIterations) — bug funcional; habilita el resto.
4. [x] `normalizeToolMarkup`.
5. [x] Approval allowlist/deny + UI (capas 2 y 3).
6. [] Streaming nivel 1.
7. [] Paralelo (último, detrás de flag).

8. memory

- define how the memory will work
- select memory provider (postgress, enmgram, etc)

6. mcp connections

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

8.1 pendientes del MVP lazy (detalle)

- [ ] **`skills.preload` es decorativo.** `SkillsConfig.preload` viaja por `applyDefaults` hasta `SkillLoader` sin que nadie lo lea: hoy toda skill es lazy. Qué falta para que signifique algo: validar que los ids listados existan (warn si no), y decidir qué hace "precargar" sin romper el invariante del prompt byte-idéntico — la opción coherente es **no** inyectar bodies en el system prompt y en su lugar dejar que un preload sea solo un `indexText` garantizado (fallar si una skill listada no carga), o forzar su carga en el primer turno. Riesgo: si se inyectan bodies, el prompt crece con N skills y se pierde el motivo de existir del diseño.
- [ ] **`triggers` se parsea y se guarda, pero no se usa.** `Skill.triggers` y `SkillSummary`/`indexText` lo ignoran hoy: el índice solo muestra `id — descripción`. No hace falta tocarlo mientras el modelo tenga descripciones claras; si se quiere, la vía barata es añadirlo a la línea del índice (`- id — desc ("trig", "trig")`) respetando `maxIndexChars`, y la cara es un clasificador/embeddings, que está explícitamente fuera de alcance.
- [x] **seed de skills de ejemplo** — `core/skills/frontend-design.md` + `skills/seed.ts#ensureSkillsDir` (copia solo si el dir no existe o está vacío, nunca pisa skills del usuario), invocado desde `loadSkillRegistry()`. Tests en `tests/skills/skill-seed.spec.ts`.
- [ ] **no hay comando para crear/editar una skill.** Todo es manual (`mkdir ~/.racso-harness/skills/<id>/SKILL.md`). Un `/skill new <id>` que escriba el frontmatter mínimo ahorraría el paso más propenso a errores (olvidar `description` → warn + skip silencioso).
- [ ] **`/skill <id>` no imprime el body.** Hoy `IHarness.listSkills()` devuelve solo `SkillSummary` (sin body), así que el comando imprime nombre, descripción, source y tags. Para volcar el body en terminal —que era la intención original del plan— hace falta exponer `getSkill(id)` en `IHarness` o añadir `skillBody()`; decisión pendiente porque agranda la superficie pública.
- [ ] **`use_skill` no aparece en el help por agente.** Si un agente declara `tools:` sin `use_skill`, no recibe la tool y no hay pista de por qué. Un warn en `createToolRegistry` cuando el agente declara lista, hay skills cargadas y `use_skill` no está en la lista (mensaje tipo "skills loaded but this agent opted out") ahorraría el rato de confusión.
- [ ] **limitación conocida de `SkillLoader`.** Solo lee `.md`; ignora ficheros ocultos; no sigue symlinks de directorio (`withFileTypes` los reporta como symlink, no como dir, así que se saltan). Si alguien organiza skills con symlinks no se cargan y no hay warn.
- [ ] **orden de commits:** `ea4bcb3` (agentes declaran `use_skill`) va antes que `da747e9` (la tool existe). Durante ese hueco, un binario ya instalado loguea `Agent requested unknown tool: use_skill` al arrancar. Inofensivo, pero si se quiere historia limpia hay que reordenar con un rebase interactivo.
- [ ] **`~/.racso-harness/agents/*.md` divergió del repo** (`coder` y `default` con `approval: auto` allí y `ask` en `core/agents/`, más diferencias de texto). `seed.ts` no pisa ficheros existentes, así que ambas copias hay que editarlas a mano — ya pasó con `use_skill`. Decidir si se sincroniza o se documenta el ritual.
      ritual (firmado 2026-11-02): **el repo es la fuente**; `~/.racso-harness/agents/` es una copia que solo se siembra en instalaciones nuevas. Un cambio en `core/agents/*.md` **no llega** a una copia existente, así que al tocar un agente hay que decidir explícitamente: (a) copiar a mano el fichero a `~/.racso-harness/agents/`, o (b) dejarlo solo en el repo y anotar que el usuario sigue con la versión vieja. Nunca las dos cosas a medias.
      por qué no se sincroniza automáticamente: pisar el directorio del usuario borraría agentes editados a mano y el error no se vería en un `git diff`. Una sincronización con backup (`*.md.bak`) es una tarea aparte, no parte del ritual.
      nota (2026-11-02): `default` diverge además en algo funcional, no de texto: la copia de runtime dice `approval: auto` y el repo `ask`. Con `ask`, `git`/`pnpm`/`tsc`/`vitest` no piden permiso (`READ_ONLY_COMMANDS` en `tools/shellPolicy.ts`), pero cada `writeFile` sí — y en un hijo headless sin handler la respuesta es **deny**, no una pregunta (`SessionManager.ts:855`). Por eso `approval` no se toca en el ritual de agentes: se decide en una tarea propia.

9. session reporting (lo que necesita la UI)
   ESTADO: **§9 en curso** (7/8): cerrada la superficie que consume el histórico desde el CLI (`childHistory()`, pintada al reanudar en `cli/TODO.md` §P1); abierta la entrada 7 del orden sugerido (hijos asentados con resultado sin entregar).
   Formato de esta sección: ver la skill `todo-format`. Las secciones 0–8 se dejan como están (histórico de decisiones).
   Contexto: el CLI va a una TUI de pantalla completa (ver `cli/TODO.md` §P0) que necesita saber _qué está corriendo ahora mismo_ y _qué pasó_. Hoy `SpawnManager` emite `started`/`settled` in-memory y `SessionManager` inyecta el resultado al padre en el turno siguiente, pero no hay forma pública de reconstruir el estado ni de recibir eventos sin acoplarse a `SessionManagerImpl`.

- [x] **Exponer `SpawnEvent` y `SpawnStatus` en el contrato público**
      review: `IHarness` ya exponía `spawn`/`pollSpawn`/`listSpawns`/`waitSpawn`/`collectSpawns` y `SpawnHandle` ya se importaba de `session/spawn.ts`; lo que faltaba era `SpawnEvent` y `SpawnStatus` fuera del módulo interno.
      hecho: `contract.ts` reexporta `SpawnEvent`/`SpawnHandle`/`SpawnStatus`, `index.ts` los publica desde `./contract` (ya no desde `./session/spawn`) y `tests/session/spawnContract.spec.ts` fija el shape de `started`/`settled`. Build + 195 tests (core) + 49 (cli) + lint verdes.

- [x] **Añadir un listener de spawn al `IHarness`**
      review: `SpawnManager.on()` ya devolvía el unsubscribe y `emit()` aislaba errores de listener; faltaba exponerlo sin acoplar la UI a `SessionManagerImpl`.
      hecho: `SessionManager.onSpawnEvent()` construye el manager on-demand (un listener registrado antes del primer spawn igual lo recibe) y `IHarness`/`harness.ts` lo delegan. Semántica A: solo en vivo, sin replay; el estado inicial es `listSpawns()`. La suscripción interna del mensaje `system` sigue intacta (test explícito). 4 tests en `SessionManager.spec.ts` (started→settled, unsubscribe, coexistencia con la inyección, listener que lanza). Build + 199 tests (core) + 49 (cli) + lint verdes.
      Depends on: exponer `SpawnEvent` y `SpawnStatus` en el contrato público. [x]

- [x] **Devolver estado consultable de los hijos**
      review: `listSpawns()` ya devuelve lo que la franja lee (`spawnId`, `sessionId`, `agentId`,
      `prompt`, `status`, `startedAt` y, al asentar, `finishedAt`/`result`/`error`) y está en
      `IHarness` desde §9.1.1. Lo que faltaba era el test y, sobre todo, el histórico:
      `listSpawns()` solo ve este proceso.
      hecho: 3 tests en `SessionManager.spec.ts` — shape exacto de un hijo recién lanzado,
      campos que se añaden al asentar, y `childHistory()` tras reanudar (transcript persistido
      intacto, `listSpawns()`/`pollSpawn()` vacíos para esos hijos) + uno que verifica que
      devuelve una copia. `IHarness.childHistory()` entra al contrato para que el CLI pinte lo
      persistido sin acoplarse a `SessionManagerImpl`.
      nota: `listSpawns()` ordena por `startedAt` descendente y `childHistory()` en orden de
      lanzamiento; la franja normaliza ambas en `spawnStrip`.
      Depends on: añadir un listener de spawn al `IHarness`.

- [x] **Persistir eventos de spawn en la sesión**
      review: los handles vivían solo en `SpawnManager`, así que tras `/resume` no había rastro de qué hijos corrieron ni cómo terminaron, y la franja del TUI se perdía entera.
      decisión de formato: se guarda el **handle final** (`SpawnHandle[]`), no los eventos. El handle ya trae `startedAt`/`finishedAt` (toda la duración que hace falta) y crece O(hijos), mientras el array de eventos crece O(reintentos). Para un histórico de lectura basta.
      decisión de I/O: `save()` ya hace `writeFileSync` completo y se llama ~7 veces por turno; añadir una escritura por evento habría duplicado I/O sobre un JSON que crece con el historial. En su lugar, `SessionManager` acumula `spawnHistory` en memoria y lo persiste dentro del `save()` existente. Excepción: al hacer `settled` sí se llama a `save()`, porque un hijo puede terminar sin que haya otro turno y su estado no debe perderse.
      hecho: `SessionRecord.spawns?: SpawnHandle[]`, `SESSION_VERSION` 3 → 4, migración en `load` (`record.spawns ??= []`, así los llamadores no ramifican por versión). El campo se **omite** del JSON cuando no hay hijos (test). Al restaurar es histórico de **solo lectura**: los hijos no se reanudan y conservan el `status` con el que se persistieron.
      tests: 3 en `SessionStore.spec.ts` (round-trip con un hijo `done` y otro `error`, migración v3 → v4, campo omitido si no hay hijos) + 3 en `SessionManager.spec.ts` (persiste el hijo al terminar, persiste el error, no escribe el campo sin hijos). Build + 220 tests (core) + 103 (cli) + lint verdes.
      pendiente: cerrado en `cli/TODO.md` §P1 (franja con los hijos restaurados) y en §9 «Devolver estado consultable» (`childHistory()`).

- [x] **Emitir progreso del turno desde `ask()`**
      review: `ask()` devolvía solo el `AgentResponse` final y, aunque `OpenAiProvider` ya tenía un `_onChunk` en el constructor, era global del provider (no por llamada) y solo transportaba texto: no había forma de atribuir eventos a un turno ni de ver tool calls o razonamiento.
      hecho: `ChatEvent`/`ChatEventListener` en `types/providers.ts` (`text`, `reasoning`, `toolCallStart`, `toolCallEnd`). `_handleStream(response, onEvent?)` emite texto y razonamiento por delta y `toolCallEnd` por llamada; `chat()` reenvía `options.onEvent`. `AssistantTurn.reasoning` guarda el razonamiento, nunca vuelve al history. `ask(prompt, onEvent?)` y `runAgentLoop` lo propagan; `IHarness.ask(prompt, { onEvent })` vía `AskOptions`. El `_onChunk` del constructor se deja intacto (dos caminos en paralelo, documentado). 6 tests en `openai.spec.ts` (texto, `reasoning_content`, fallback `reasoning`, sin razonamiento, `toolCallEnd`, y que omitir `onEvent` no cambia nada). Build + 205 tests (core) + 49 (cli) + lint verdes.
      Bug encontrado por los tests: la captura de razonamiento había quedado dentro del `if (content)`, así que se perdía en chunks que solo traían razonamiento.

- [x] **Emitir salida viva de `shell` vía `ToolContext.onOutput`**
      hecho: `ToolContext.onOutput?: (chunk) => void` y `ShellTool` coalesce los chunks por ventana (`outputThrottleMs`, default 100, `0` lo desactiva) y hace flush al terminar. `SessionManager` lo etiqueta con `id`/`name` de la call y lo emite como `ChatEvent` `toolOutput`, así que la UI lo recibe por el mismo canal que el resto. El truncado (`maxOutputBytes`) sigue aplicando **solo** al resultado final, no al stream (test explícito).
      4 tests en `tools/shell.spec.ts` (stream, sin `onOutput`, stream sin truncar, coalescing) + 2 en `SessionManager.spec.ts` (etiquetado con la call, turno idéntico sin listener). Build + 211 tests (core) + 49 (cli) + lint verdes.

- [x] **Incluir un resumen de cierre en `AgentResponse`**
      hecho: `TurnOutcome { status: "completed" | "toolError" | "incomplete", pending: string[], next? }` y `AgentResponse.outcome?`. `runAgentLoop` acumula las tools que fallaron (`pending`) y distingue el corte por `tools.maxIterations` (`incomplete` + qué hacer). El campo es opcional, así ningún `toEqual` existente cambió. 3 tests (completed, toolError con la tool nombrada, incomplete por tope de iteraciones).
      Nota: hoy lo rellena `runAgentLoop`; el camino de `generateImage` no lo emite (no hay turno ReAct que resumir).
- [x] **Añadir resumen del hijo y duración a `SpawnHandle`**
      `SpawnHandle` no lleva ni un resumen de lo que hizo el hijo ni una duración
      explícita (`startedAt`/`finishedAt` como ISO obligan a recalcular), así que la
      franja del CLI mide el tiempo por su cuenta y, al reanudar una sesión, el resumen
      se pierde: el histórico (`childHistory()`) solo conserva `result`/`error`, sin
      resumen corto ni métrica de tokens.
      Done when: `SpawnHandle` gana `summary?: string` y `durationMs?: number` (fijados
      al asentar, `durationMs` derivado de `startedAt`/`finishedAt`) y `childHistory()`
      los devuelve al reanudar, con un test en `tests/session/SessionManager.spec.ts`
      que lo comprueba; el CLI pinta la duración desde `durationMs` sin recalcular.
      hecho: `SpawnHandle.summary?: string` y `durationMs?: number`. Ambos los fija `SpawnManager.settle()` (spawn.ts), el punto único al que desemboca el `finally` de `run()`, así que éxito, error, timeout y cancel pasan por ahí; `finishedAt` se fija en el mismo sitio. `durationMs` = `Date.parse(finishedAt) - Date.parse(startedAt)` (clamp a 0 si el reloj va hacia atrás) y `summary` se deriva del propio hijo — su `result` o su `error`, aplanado a una línea y capado a 120 chars — para no inventar una llamada extra al modelo; un hijo sin texto deja `summary` en `undefined`. `snapshot()` los copia, así que `poll`/`list`/`wait`/`collect` y el evento `settled` los llevan, y `save()` persiste `spawnHistory` (que el listener de `settled` actualiza) por lo que `childHistory()` los devuelve al reanudar. Sin subir `SESSION_VERSION` (sigue en 4): son campos opcionales y un record viejo simplemente no los trae (`undefined`, nunca `NaN` ni `""`), igual que un hijo sin asentar. 4 tests nuevos en `tests/session/SessionManager.spec.ts` (duración + resumen en éxito, duración en error, supervivencia al guardado/recarga, y record antiguo sin los campos); el test que fija la forma del hijo en `running` ahora comprueba que los dos campos aún no están. `formatSpawnResult` y el texto inyectado en el padre no cambian. 233 tests (core) + 188 (cli) + lint + prettier + tsc verdes.
      Depends on: devolver estado consultable de los hijos.

- [ ] **Exponer los hijos asentados con resultado sin entregar**
      Hoy el resultado del hijo se inyecta como mensaje `system` en el history del padre (`SessionManager.ts:592`) y desde fuera nadie puede saber si esa entrega ya ocurrió; el CLI necesita saberlo para continuar solo tras un `delegate`.
      Done when: una prueba en `core/tests/session/SessionManager.spec.ts` fija que un hijo asentado con el padre sin turno posterior sigue en la lista y solo desaparece cuando el padre ejecuta un turno que inyecta su resultado como mensaje system (el punto de inyección en SessionManager.ts), y que la lista vuelve vacía cuando ya no queda ningún hijo sin entregar.
      Consumidor: `cli/TODO.md` §P6, tarea «Arrancar un turno sin prompt cuando un hijo deja trabajo».
      Depends on: nada.

### 9.1 orden sugerido

1. [x] Contrato: `SpawnEvent`/`SpawnStatus` reexportados + `listSpawns()` ya expuesto en `IHarness`.
2. [x] Listener de spawn en `IHarness`.
3. [x] `onEvent` en `ask()` + `reasoning` en el provider.
4. [x] Persistencia de handles + migración de `SessionStore`.
5. [x] `ToolContext.onOutput` (shell vivo).
6. [x] Resumen de cierre estructurado.
7. [ ] Hijos asentados con resultado sin entregar (desbloquea `cli/TODO.md` §P6).

Nota: los puntos 1–2 desbloquean `cli/TODO.md` §P1; el 3 desbloquea §P3; el 7 desbloquea §P6.

10. gateway persistente (F1–F5): `@racso2609/gateway` como paquete nuevo
    Formato de esta sección: ver la skill `todo-format`. Las secciones 0–9 se dejan como están.
    La referencia es `docs/ARCHITECTURE.md` (fases F0–F6, decisiones 1–7 y huecos 1–10): esta sección no repite el diseño, sólo lista las tareas con su `Done when`.
    Contexto: `core` es la librería base; el **gateway** es un **paquete nuevo y proceso aparte** (`@racso2609/gateway`) que consume la **lib publicada** del core, y el CLI es otra implementación separada que consume esa misma lib. Los tres se publican. Hoy `createHarness()` sólo vive dentro del proceso del CLI, así que nada puede correr sin una terminal abierta. Reutiliza lo que ya existe: `SpawnManager`, `SessionStore` y `SessionManagerImpl`; `IHarness` no cambia (decisión 7).
    Bloquea: nada del CLI actual; F0 (`cli/TODO.md` §P4) es requisito previo, porque el gateway consume el core del registro y no del workspace.

### F0 — prerrequisito: el paquete

- [ ] **Crear el paquete `gateway/` en el workspace**
      El gateway es un proceso de larga vida con su propio ciclo de release, así que no puede nacer dentro de `core/` ni de `cli/`.
      Done when: existe `gateway/package.json` con `name: "@racso2609/gateway"`, `private: false` y `@racso2609/core` como dependencia con rango publicado (no `workspace:*`), está listado en `pnpm-workspace.yaml` y `pnpm -r build` lo incluye.
      Depends on: publicar `@racso2609/core` (`cli/TODO.md` §P4).

### F1 — `SessionRegistry` + `runTurn` (huecos 1–3)

- [ ] **Añadir `SessionRegistry` al core**
      Hoy sólo hay `Harness` con **una** sesión activa y `loadSession` la sustituye, así que no hay nada que sostenga N sesiones simultáneas ni que las enumere por estado.
      Done when: un test en `core/tests/session/` crea dos sesiones vivas sobre un mismo `Config` y `SessionStore`, corre un turno en cada una y verifica que ambas persisten y que la segunda no ve el history de la primera; `pnpm --filter @racso2609/core test` en verde.
      Depends on: nada.

- [ ] **Mover el turno a `runTurn()` en `core/src/session/turn.ts` con `IHarness` intacta**
      El turno (bucle de stdin + `harness.ask` + traducción `ChatEvent`→`UiEvent`) vive en `cli/src/MainLoop.ts`, así que el gateway no puede reutilizarlo; va como función libre para no añadir una entrada pública al contrato (decisión 6).
      Done when: `runTurn()` exportado desde `core/src/session/turn.ts` ejecuta un turno con un prompt y devuelve los eventos sin leer stdin ni escribir en stdout, `core/src/contract.ts` (`IHarness`) no cambia y `pnpm -r test` sigue en verde.
      Depends on: añadir `SessionRegistry` al core.

- [ ] **Atravesar el turno con un `AbortSignal`**
      Hoy el `signal` sólo lo recibe el runner de hijos (`SpawnRunner.signal`), así que un turno en curso no se puede abortar desde fuera.
      Done when: `runTurn()` acepta un `AbortSignal`, un test en `core/tests/session/` aborta a mitad de turno y verifica que `ask` termina y que la sesión queda persistida sin el turno a medias.
      Depends on: mover el turno a `runTurn()` en `core/src/session/turn.ts` con `IHarness` intacta.

### F2 — servidor HTTP + SSE (huecos 4, 5, 8 y 10)

- [ ] **Serializar las escrituras del `SessionStore` con lease `<id>.lock` y tmp+rename**
      `save` hace hoy `fs.writeFileSync` sobre el fichero entero sin lock ni escritura atómica, así que dos escritores sobre la misma sesión se pisan y un corte a mitad deja un JSON inválido.
      Done when: existe un test en `core/tests/session/SessionStore.spec.ts` con dos `save` concurrentes sobre el mismo id que fija que no se pierde ninguna escritura y que el fichero final siempre es JSON válido, y `sessions/<id>.lock` aparece y se libera en la prueba.
      Depends on: nada.

- [ ] **Añadir el bloque `gateway` a `Config`**
      El gateway necesita puerto, bind y política de aprobaciones por defecto como configuración, no como constantes.
      Done when: `Config.gateway` existe con `enabled` (default `false`), `host`, `port` y la política de aprobaciones por defecto, aplicado en `applyDefaults` y validado en `validateConfig()`.
      Depends on: nada.

- [ ] **Añadir un `EventBuffer` circular por turno con sobre `{sessionId, turnId, seq}`**
      `ChatEvent` no lleva `seq` ni `turnId` y `onSpawnEvent` es live-only, así que un cliente que se engancha a mitad de turno no puede reconstruir lo ya emitido (decisión 2).
      Done when: un test en `gateway/tests/` arranca un turno, corta la conexión a mitad, reconecta con el último `seq` y recibe exactamente los eventos que faltaban, sin duplicados; el estado ya asentado se relee de `status()`/`conversation()`/`listSpawns()`.
      Depends on: mover el turno a `runTurn()` en `core/src/session/turn.ts` con `IHarness` intacta.

- [ ] **Exponer el servidor del gateway con `node:http` y SSE, no WebSocket**
      Hoy no hay ninguna referencia a `node:http` en `core/` ni en `cli/`: no existe servidor donde colgar el stream ni la SPA, y el flujo es unidireccional, así que SSE basta (decisión 2).
      Done when: el proceso `gateway` sirve un endpoint SSE que emite cada evento envuelto en `{sessionId, turnId, seq}` y atiende las acciones del usuario como peticiones HTTP normales, con un test de integración sobre un puerto efímero.
      Depends on: añadir un `EventBuffer` circular por turno con sobre `{sessionId, turnId, seq}`.

### F4 — aprobaciones (huecos 6 y 7)

- [ ] **Llevar `sessionId` en `ApprovalRequest`**
      Hoy `approveWith` instala un único handler global y la petición no dice de qué sesión viene, así que con N sesiones un `ask` no se puede atribuir.
      Done when: `ApprovalRequest` incluye `sessionId` y un test en `core/tests/session/` verifica que dos sesiones con una petición abierta cada una reciben el `sessionId` correcto.
      Depends on: añadir `SessionRegistry` al core.

- [ ] **Persistir `approvals[]` en `SpawnHandle` y `SessionRecord`**
      Ninguno de los dos lo tiene, así que la decisión sobre una tool no queda registrada junto al trabajo al que pertenece.
      Done when: una aprobación concedida o denegada queda escrita en `approvals[]` del `SpawnHandle` y sobrevive al guardado y recarga de `SessionRecord` sin subir `SESSION_VERSION` (campos opcionales); test en `core/tests/session/`.
      Depends on: llevar `sessionId` en `ApprovalRequest`.

- [ ] **Implementar la `ApprovalQueue` por sesión con TTL de 120 s y `deny` por defecto**
      `SessionManager.approve` deniega sin handler, así que una tool sujeta a aprobación mata el trabajo en silencio en vez de dejarlo registrado y rechazado (decisión 3).
      Done when: un test dispara una tool bajo política `ask`, no responde, avanza el reloj 120 s y comprueba que la tool quedó denegada con `ToolResult.isError` y registrada en `approvals[]`; otro test con dos sesiones verifica que la respuesta de la A no resuelve la petición de la B.
      Depends on: persistir `approvals[]` en `SpawnHandle` y `SessionRecord`.

### F5 — cronjobs y webhooks (hueco 9)

- [ ] **Crear `jobs.json` en `~/.racso-harness/` como almacenamiento de trabajos**
      No existe hoy ningún sitio donde persistir programaciones ni sus ejecuciones: `SessionStore` debe seguir siendo la única pieza que toca disco para sesiones.
      Done when: `jobs.json` con sus tipos y su lectura/escritura existe en el gateway, con test que lo crea, lo relee y comprueba que `SessionStore` no lo toca.
      Depends on: crear el paquete `gateway/` en el workspace.

- [ ] **Ejecutar cronjobs programados sobre `runTurn`**
      Es la mitad del objetivo del gateway: trabajo recurrente sin usuario delante.
      Done when: un trabajo con expresión cron registrado en `jobs.json` se ejecuta en el intervalo esperado (test con reloj falso) llamando a `runTurn` sobre una sesión existente o nueva, y deja rastro en `sessions/<id>.json`.
      Depends on: implementar la `ApprovalQueue` por sesión con TTL de 120 s y `deny` por defecto.

- [ ] **Recibir webhooks como disparadores del mismo camino**
      La otra mitad: reaccionar a un evento externo disparando el turno sin polling.
      Done when: un test hace `POST` al endpoint de webhook con un `id` registrado en `jobs.json`, dispara `runTurn` sobre la sesión asociada y otro `id` desconocido devuelve `404`.
      Depends on: ejecutar cronjobs programados sobre `runTurn`.

- [ ] **Persistir el estado de los trabajos entre reinicios**
      Un cronjob que se salta la ejecución perdida al reiniciar rompe la promesa de "corre siempre", que es la razón de tener un proceso de larga vida.
      Done when: matar el gateway a mitad de un trabajo y volver a arrancarlo restaura las programaciones de `jobs.json` y deja el trabajo interrumpido marcado como `error` en el historial, sin duplicar ejecuciones.
      Depends on: ejecutar cronjobs programados sobre `runTurn`.

- [ ] **Documentar el gateway en `CONTRACT.md`**
      `CONTRACT.md` describe el SDK publicado; un paquete nuevo que consume la lib no existe para quien integra si no está ahí.
      Done when: `CONTRACT.md` describe cómo arrancar `@racso2609/gateway`, qué rutas expone y qué importa del core más allá de `createHarness` (`runTurn`), dejando claro que `IHarness` no cambia.
      Depends on: recibir webhooks como disparadores del mismo camino.

### 10.1 orden sugerido

La referencia del orden es `docs/ARCHITECTURE.md` (fases F0–F6); aquí sólo se lista qué tarea de arriba abre cada fase.

1. F0 — el plan de publicación está cerrado en `docs/INSTALL.md` y sus tareas en `cli/TODO.md` §P4. El paquete `gateway/` necesita `@racso2609/core` publicado.
2. F1 — `SessionRegistry`, `runTurn()` en `core/src/session/turn.ts` con `IHarness` intacta y el `AbortSignal` que atraviesa el turno.
3. F2 — `SessionStore` con lease y tmp+rename, bloque `gateway` en `Config`, `EventBuffer` con sobre `{sessionId, turnId, seq}` y servidor `node:http` + SSE.
4. F4 — `sessionId` en `ApprovalRequest`, `approvals[]` en `SpawnHandle`/`SessionRecord` y `ApprovalQueue` por sesión con TTL 120 s y `deny` por defecto. Va antes de los trabajos: un cronjob que dispara tools con efectos necesita una decisión que no dependa de una terminal abierta.
5. F5 — `jobs.json`, cronjobs sobre `runTurn`, webhooks por el mismo camino, persistencia entre reinicios y `CONTRACT.md`.

### Descartados de la sección 10

- **«Diseñar el contrato del gateway» (`core/GATEWAY.md`)** — el diseño ya está cerrado en `docs/ARCHITECTURE.md` (decisiones 1–7 y huecos 1–10) → se sustituye por las tareas de F1, F2, F4 y F5, y lo que el consumidor necesita leer pasa a `CONTRACT.md` (tarea de F5).
- **«Definir el almacenamiento de trabajos»** — el diseño decidió `jobs.json` junto a `SessionStore` (`docs/ARCHITECTURE.md`, `## Modelo de runtime`) → queda como tarea de implementación de F5.
- **«Exponer un servidor HTTP con `spawn` y `status`»** — se reemplaza por el servidor `node:http` + SSE de F2, que sirve turnos y stream, no `spawn` suelto.
- **«Proteger el gateway con token»** — ninguna fase de `docs/ARCHITECTURE.md` lo decide → pasa a `Preguntas abiertas` de esta sección en vez de quedar como tarea.
- **«Definir la política de aprobaciones de un trabajo sin usuario»** — decidido: `ApprovalQueue` por sesión con TTL 120 s y `deny` por defecto (decisión 3) → queda como tarea de F4.

## Preguntas abiertas de la sección 10

- **¿Autentica el gateway las peticiones con un token?** Las fases F0–F6 de `docs/ARCHITECTURE.md` no lo deciden, y sin autenticación un puerto que ejecuta tools (`shell`) es ejecución remota en la máquina del usuario. No es tarea hasta que se decida: para cerrarla hay que fijar si el token vive en `config.gateway` y si toda ruta salvo `/health` lo exige.
- **¿Los `.map` viajan en los tarballs?** Afecta al tamaño del paquete del gateway igual que al de los dos actuales; queda abierto en `docs/INSTALL.md` (`Preguntas abiertas`, punto 3) y se cierra con la misma decisión.
