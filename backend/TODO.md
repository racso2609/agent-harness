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
- [] `tsconfig.json`: `rootDir` está en `src` pero `include` trae `tests/**` y `scripts/**` (TS6059 en cascada) + `baseUrl` deprecado (TS5101) + `moduleResolution: "bundler"` con `module: "NodeNext"` (TS5095/TS5109). `tsc --noEmit` hoy falla antes de tipar nada → cualquier pendiente nuevo entra sin typecheck.
- [] `tests/session/SessionStore.spec.ts:41` espera `version: 2`, el store persiste `3`. Test rojo (89/90 pasan).
- [] cablear el agente en `SessionManager`: `agentId`/`agent` no existen; se importan `AgentRegistry`/`AgentLoader`/`AgentSummary`/`composeSystemPrompt`/`strictestApproval`/`builtInDefaultAgent` y **no se usan**. Consecuencias: `composeSystemPrompt` nunca se manda al provider, `agent.tools` / `agent.approval` / `agent.maxIterations` se parsean pero se ignoran.
- [] `OpenAiProvider`: type-only imports (`AssistantTurn`, `ChatOptions`, `ChatResult`, `FinishReason`, `History`, `Model`, `Provider`, `TokenUsage`, `ToolCall`, `ToolSpec`) sin `type` → errores con `verbatimModuleSyntax`/`isolatedModules`.
- [] `shell`: `spawn("/bin/bash")` hardcodeado aunque el código ramifica por `process.platform` (Windows). Usar `bash` del `PATH` o `process.env.SHELL` con fallback, y documentar que en win32 no aplica `detached`/`kill(-pid)`.
- [] `runAgentLoop` no marca fallos al modelo: el `tool` message se empuja con `toolResult.output` sin prefijo aunque `isError` sea `true`; además se empuja tool result para calls con `parseError`/`name` vacío, desalineando `tool_call_id`. Prefijar `[tool error] …` y garantizar un `tool` message por cada `tool_call` (mismo orden).

### 4.2 pendientes de tooling (propuesta revisada, con orden y estimación)
- [] **normalizar tool calls que llegan como texto plano (DeepSeek)** — `normalizeToolMarkup`
- review: hoy solo se leen `delta.tool_calls`; los modelos que emiten `<tool_call>{json}</tool_call>`, fences ```tool_call``` o el markup `<|tool▁calls▁begin|>` devuelven `finishReason: "stop"` con JSON crudo en `text` y el loop corta.
- propuesta: `src/providers/normalizeToolMarkup.ts` → `normalizeToolMarkup(turn): AssistantTurn`, aplicado en `OpenAiProvider.chat()` solo si `turn.toolCalls.length === 0`. Patrones en orden (tool_call tags, fences, DeepSeek); si el JSON no parsea se deja el texto intacto + `logger.debug` (evitar falsos positivos). Al matchear: limpiar markup del `text`, ids sintéticos, `rawArgs` normalizado, `finishReason: "toolCalls"`. Flag `tools.normalizeTextToolCalls` (default `true`).
- tests: unit del normalizer (3 formatos, mixto, falso positivo, JSON inválido) + e2e en `openai.spec.ts` con stream con markup. ~120 LOC + ~80 LOC tests. Riesgo bajo.
- [] **límites de approval: allowlist read-only, deny patterns, sandbox de `workspace`**
- review: `writeFile`/`readFile`/`listDir` **nunca** llaman `ctx.approve` y aceptan rutas absolutas y `../..` (el `cwd` es cosmético: se puede leer/escribir cualquier ruta sin prompt). `approval: "ask"` solo cubre `shell` y su firma `approve(command: string) => boolean` no alcanza para "allow once / always". En `auto` no hay deny list. `agent.approval` + `strictestApproval` sin cablear.
- propuesta en 3 capas: (1) `src/tools/paths.ts#resolveInWorkspace` (`resolve` + `realpath` + `startsWith(root + sep)`, cubre symlinks) en los 3 file tools; `writeFile` rechaza `.git/` y `config.tools.writeDeny` (glob simple); (2) `src/tools/shellPolicy.ts` con `READ_ONLY_COMMANDS` + `DENY_PATTERNS` (`rm -rf /`, `curl | sh`, `dd if=`, `git push --force`, …) y nuevo `ToolContext.approve(req: ApprovalRequest) => Promise<"allow"|"deny">` con `{ tool, command, kind: read|write|exec }`; tabla por modo (`auto`: read-only/dir allow, exec con deny list; `ask`: prompt en write/exec no read-only; `deny`: solo reads; las tres respetan deny list); (3) cablear agente en `SessionManager` (`effectiveApproval = strictestApproval(config, agent)` + `maxIterations = min(...)` + system prompt) y "always allow" en memoria por sesión.
- estimación: capa 1 ~1h, capa 2 ~3h, capa 3 ~2h. Riesgo medio: cambia la firma de `ToolContext` → tocar los 4 tools, ambos specs y `SessionManager.toolContext()`; hacerlo en 3 commits para que el sandbox aterrice primero (es bug de seguridad).
- [] **tool calls en paralelo**
- review: hoy `for … await` secuencial en `runAgentLoop`. Riesgos reales: N `shell` en paralelo saturan la máquina, `writeFile` a la misma ruta es race, dependencias implícitas de orden en el modelo, y OpenAI exige que los `tool` messages vayan en el mismo orden que los `tool_calls`.
- propuesta: `config.tools.parallel: { enabled, maxConcurrency }` (default `false`/`4`), metadata `Tool.execution.parallelSafe` (`readFile`/`listDir` `true`; `writeFile`/`shell` `false`), `ToolRegistry.parallelizable(calls)`, `src/utils/concurrency.ts#runWithLimit` (~20 LOC, sin `p-limit`); recolectar resultados y recién entonces empujar los `tool` messages en el orden original. ~1.5h. Riesgo bajo detrás de flag; no activar por default sin métrica de calls múltiples.
- [] **streaming de tool calls al usuario en tiempo real** (hoy se loguea al completar cada call)
- review: `_onChunk` solo emite `content`; los `delta.tool_calls` se acumulan en silencio → un `shell` de 30s no muestra nada. El consumidor real es `logger`, así que no hace falta UI nueva. Emitir cada delta de `arguments` es ruido (JSON en pedacitos).
- propuesta nivel 1: reemplazar `onChunk` por `onEvent: (e: ChatEvent) => void` con `ChatEvent = text | toolCallStart | toolCallDelta`; `toolCallStart` se emite una sola vez por `index` (al aparecer `function.name`) y `SessionManager` lo loguea vía `logger.transient` ("→ shell …"). Nivel 2 (post-MVP): `ToolContext.onOutput?: (chunk) => void` que `ShellTool` llama con throttle ~100 ms para salida viva (el truncado sigue aplicando al resultado final, no al stream). Nivel 1 ~1h riesgo bajo; nivel 2 ~2h riesgo medio (no romper el redibujado del prompt en `stdin.ts`).

### 4.3 orden sugerido
1. 4.1 (`tsconfig` + test de `SessionStore`) — sin esto no hay typecheck real.
2. Sandbox de paths (4.2 approval, capa 1) — bug de seguridad.
3. Cablear agente (prompt/tools/approval/maxIterations) — bug funcional; habilita el resto.
4. `normalizeToolMarkup`.
5. Approval allowlist/deny + UI (capas 2 y 3).
6. Streaming nivel 1.
7. Paralelo (último, detrás de flag).

5. memory
- define how the memory will work
- select memory provider (postgress, enmgram, etc)

6. mcp connections

7. RAG integration??
