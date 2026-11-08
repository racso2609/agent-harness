# Journal — Core · §8–§9 — Session reporting

Índice: [TODO del repo](../../../TODO.md) · TODO vivo: [core/TODO.md](../../../core/TODO.md)
Estado: cerrado el 2026-11-07

La superficie que la UI necesita para reconstruir el estado: contrato de spawn, listener, estado consultable, persistencia, progreso del turno, salida viva de `shell`, resumen de cierre y los hijos asentados sin entregar.

### Exponer `SpawnEvent` y `SpawnStatus` en el contrato público

      review: `IHarness` ya exponía `spawn`/`pollSpawn`/`listSpawns`/`waitSpawn`/`collectSpawns` y `SpawnHandle` ya se importaba de `session/spawn.ts`; lo que faltaba era `SpawnEvent` y `SpawnStatus` fuera del módulo interno.
      hecho: `contract.ts` reexporta `SpawnEvent`/`SpawnHandle`/`SpawnStatus`, `index.ts` los publica desde `./contract` (ya no desde `./session/spawn`) y `tests/session/spawnContract.spec.ts` fija el shape de `started`/`settled`. Build + 195 tests (core) + 49 (cli) + lint verdes.

### Añadir un listener de spawn al `IHarness`

      review: `SpawnManager.on()` ya devolvía el unsubscribe y `emit()` aislaba errores de listener; faltaba exponerlo sin acoplar la UI a `SessionManagerImpl`.
      hecho: `SessionManager.onSpawnEvent()` construye el manager on-demand (un listener registrado antes del primer spawn igual lo recibe) y `IHarness`/`harness.ts` lo delegan. Semántica A: solo en vivo, sin replay; el estado inicial es `listSpawns()`. La suscripción interna del mensaje `system` sigue intacta (test explícito). 4 tests en `SessionManager.spec.ts` (started→settled, unsubscribe, coexistencia con la inyección, listener que lanza). Build + 199 tests (core) + 49 (cli) + lint verdes.
      Depends on: exponer `SpawnEvent` y `SpawnStatus` en el contrato público. [x]

### Devolver estado consultable de los hijos

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

### Persistir eventos de spawn en la sesión

      review: los handles vivían solo en `SpawnManager`, así que tras `/resume` no había rastro de qué hijos corrieron ni cómo terminaron, y la franja del TUI se perdía entera.
      decisión de formato: se guarda el **handle final** (`SpawnHandle[]`), no los eventos. El handle ya trae `startedAt`/`finishedAt` (toda la duración que hace falta) y crece O(hijos), mientras el array de eventos crece O(reintentos). Para un histórico de lectura basta.
      decisión de I/O: `save()` ya hace `writeFileSync` completo y se llama ~7 veces por turno; añadir una escritura por evento habría duplicado I/O sobre un JSON que crece con el historial. En su lugar, `SessionManager` acumula `spawnHistory` en memoria y lo persiste dentro del `save()` existente. Excepción: al hacer `settled` sí se llama a `save()`, porque un hijo puede terminar sin que haya otro turno y su estado no debe perderse.
      hecho: `SessionRecord.spawns?: SpawnHandle[]`, `SESSION_VERSION` 3 → 4, migración en `load` (`record.spawns ??= []`, así los llamadores no ramifican por versión). El campo se **omite** del JSON cuando no hay hijos (test). Al restaurar es histórico de **solo lectura**: los hijos no se reanudan y conservan el `status` con el que se persistieron.
      tests: 3 en `SessionStore.spec.ts` (round-trip con un hijo `done` y otro `error`, migración v3 → v4, campo omitido si no hay hijos) + 3 en `SessionManager.spec.ts` (persiste el hijo al terminar, persiste el error, no escribe el campo sin hijos). Build + 220 tests (core) + 103 (cli) + lint verdes.
      pendiente: cerrado en `cli/TODO.md` §P1 (franja con los hijos restaurados) y en §9 «Devolver estado consultable» (`childHistory()`).

### Emitir progreso del turno desde `ask()`

      review: `ask()` devolvía solo el `AgentResponse` final y, aunque `OpenAiProvider` ya tenía un `_onChunk` en el constructor, era global del provider (no por llamada) y solo transportaba texto: no había forma de atribuir eventos a un turno ni de ver tool calls o razonamiento.
      hecho: `ChatEvent`/`ChatEventListener` en `types/providers.ts` (`text`, `reasoning`, `toolCallStart`, `toolCallEnd`). `_handleStream(response, onEvent?)` emite texto y razonamiento por delta y `toolCallEnd` por llamada; `chat()` reenvía `options.onEvent`. `AssistantTurn.reasoning` guarda el razonamiento, nunca vuelve al history. `ask(prompt, onEvent?)` y `runAgentLoop` lo propagan; `IHarness.ask(prompt, { onEvent })` vía `AskOptions`. El `_onChunk` del constructor se deja intacto (dos caminos en paralelo, documentado). 6 tests en `openai.spec.ts` (texto, `reasoning_content`, fallback `reasoning`, sin razonamiento, `toolCallEnd`, y que omitir `onEvent` no cambia nada). Build + 205 tests (core) + 49 (cli) + lint verdes.
      Bug encontrado por los tests: la captura de razonamiento había quedado dentro del `if (content)`, así que se perdía en chunks que solo traían razonamiento.

### Emitir salida viva de `shell` vía `ToolContext.onOutput`

      hecho: `ToolContext.onOutput?: (chunk) => void` y `ShellTool` coalesce los chunks por ventana (`outputThrottleMs`, default 100, `0` lo desactiva) y hace flush al terminar. `SessionManager` lo etiqueta con `id`/`name` de la call y lo emite como `ChatEvent` `toolOutput`, así que la UI lo recibe por el mismo canal que el resto. El truncado (`maxOutputBytes`) sigue aplicando **solo** al resultado final, no al stream (test explícito).
      4 tests en `tools/shell.spec.ts` (stream, sin `onOutput`, stream sin truncar, coalescing) + 2 en `SessionManager.spec.ts` (etiquetado con la call, turno idéntico sin listener). Build + 211 tests (core) + 49 (cli) + lint verdes.

### Incluir un resumen de cierre en `AgentResponse`

      hecho: `TurnOutcome { status: "completed" | "toolError" | "incomplete", pending: string[], next? }` y `AgentResponse.outcome?`. `runAgentLoop` acumula las tools que fallaron (`pending`) y distingue el corte por `tools.maxIterations` (`incomplete` + qué hacer). El campo es opcional, así ningún `toEqual` existente cambió. 3 tests (completed, toolError con la tool nombrada, incomplete por tope de iteraciones).
      Nota: hoy lo rellena `runAgentLoop`; el camino de `generateImage` no lo emite (no hay turno ReAct que resumir).

### Añadir resumen del hijo y duración a `SpawnHandle`

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

### Exponer los hijos asentados con resultado sin entregar

      Hoy el resultado del hijo se inyecta como mensaje `system` en el history del padre (`SessionManager.ts:592`) y desde fuera nadie puede saber si esa entrega ya ocurrió; el CLI necesita saberlo para continuar solo tras un `delegate`.
      Done when: una prueba en `core/tests/session/SessionManager.spec.ts` fija que un hijo asentado con el padre sin turno posterior sigue en la lista y solo desaparece cuando el padre ejecuta un turno que inyecta su resultado como mensaje system (el punto de inyección en SessionManager.ts), y que la lista vuelve vacía cuando ya no queda ningún hijo sin entregar.
 hecho: `SessionManager` mantiene la cola `protected undelivered: SpawnHandle[] = []` (`src/session/SessionManager.ts:223`), que se llena en el listener de `settled` (L696-701, reemplazando cualquier entrada previa del mismo hijo para no encolarlo dos veces) y se vacía en `flushPendingSpawns()` (L712-731), llamado desde el turno (L795). El marcador de entrega es `protected delivered = new Set<string>()` (L241): el push al history añade el `spawnId` y `save()` lo persiste como `SessionRecord.deliveredSpawns` (L419-435), de modo que al reanudar (L335-339) solo se reencolan los hijos asentados que aún no se entregaron; un hijo todavía `running` no se encola y uno ya entregado no se repite. El acceso público es `pendingSpawns(): SpawnHandle[]` (L640-642), documentado como copia que no drena la cola, y está en el contrato (`contract.ts:128`, `IHarness.pendingSpawns`, delegado en `harness.ts:140-142`).
 tests: 8 casos en `tests/session/SessionManager.spec.ts` — «reports a settled child until the parent runs the turn that delivers it» (L1358), «persists the delivered child result even when the turn then fails» (L1387), «delivers two settled children in settlement order» (L1430), «does not report a running child as pending» (L1463), «hands out a copy of the pending children, not its own array» (L1477), «queues a settled child that was never delivered when the session is resumed» (L1492), «does not queue a child already delivered before the resume» (L1527) y «does not queue a child that was still running when the process died» (L1572). Verificado ahora: `npx vitest run tests/session/SessionManager.spec.ts -t pending` → 5 passed; `-t resumed` → 2 passed; `-t "settled child until the parent runs the turn"` → 1 passed.
 nota: `deliveredSpawns` no sube `SESSION_VERSION` (sigue en 4); un record anterior se lee como «nada entregado» y el peor caso es volver a entregar un resultado una vez (comentado en `SessionManager.ts:331-334` y `SessionStore.ts:78-83`).
      Consumidor: `cli/TODO.md` §P6, tarea «Arrancar un turno sin prompt cuando un hijo deja trabajo».
      Depends on: nada.
