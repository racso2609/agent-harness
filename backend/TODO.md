- [x] Provider capabilities detection for loaded model
- [-] Configuration class turn on configuration mode if something missing
- [] Sanitize apikeys
  - definir si usar vault local (creo que seria mejor esta)
  - archivos con apikeys hasheadas

3. session manager
   - [x] send initial config params per session
     - maxMessage, autocompact: boolean, tokens limit etc
   - [x] prompt classification text generation or image generation

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
     - [] normalizar tool calls que llegan como texto plano (DeepSeek) — `normalizeToolMarkup`
     - [] límites de approval: allowlist read-only, deny patterns, sandbox de `workspace`
     - [] tool calls en paralelo
     - [] streaming de tool calls al usuario en tiempo real (hoy se loguea al completar cada call)

5. memory
   - define how the memory will work
   - select memory provider (postgress, enmgram, etc)

6. mcp connections

7. RAG integration??
