# Journal — CLI · P5 — Reanudar una sesión repinta el transcript

Índice: [TODO del repo](../../../TODO.md) · TODO vivo: [cli/TODO.md](../../../cli/TODO.md)
Estado: cerrado el 2026-11-06

`/resume` (y el flag `--resume`) reemplaza el transcript en los dos renderers con la conversación de la sesión reanudada, sin los turnos que nadie escribió.

### `/resume` dejaba en pantalla la conversación de la sesión anterior
      El core ya restauraba el historial (`SessionManager.load` → `this.history =
record.history`), pero el CLI no tenía con qué leerlo ni evento para repintarlo, así que
      una sesión reanudada seguía mostrando los mensajes viejos hasta que el usuario los
      borraba y ponía los de la sesión cargada a mano.
      hecho (core): `conversation(): ConversationEntry[]` en `src/session/SessionManager.ts:582`
      filtra `system` (persona del agente, memoria de compactación) y `tool` (su resultado ya
      está resumido en la respuesta), descarta mensajes con `content` vacío tras `trim()`,
      respeta el orden más antiguo primero y devuelve copia (nunca la referencia interna
      `this.history`). Tipo `ConversationEntry` en `src/types/session.ts:36`, en `IHarness`
      (`src/contract.ts:83`) y delegado de una línea en `src/harness.ts:56`; documentado en
      `core/CONTRACT.md:97`.
      hecho (cli): evento `{ type: "conversation"; entries }` en `UiEvent`
      (`src/ui/UiAdapter.ts:55`), que **reemplaza** el transcript y no va con `reset`;
      `MainLoop#showConversation` (`src/MainLoop.ts:37`) no emite nada si la conversación está
      vacía (una sesión nueva no debe borrar la pantalla) y se llama tras `initialize()`
      (`src/MainLoop.ts:110`) y cuando un comando cambia de sesión (`src/MainLoop.ts:289`, antes
      de `showChildHistory`). La TUI (`src/ui/TuiUiAdapter.tsx:318`) sustituye `lines` (`user` →
      entrada `user`, `assistant` → `answer` pasado por `MarkdownStream` para que el histórico
      se pinte con el mismo markdown que una respuesta en vivo) y limpia `streams`, `anchors`,
      `spawns` (la franja viva era de la sesión anterior) y `expanded`; conserva `history` (los
      hijos restaurados llegan justo después) y `status`. El modo líneas
      (`src/ui/CliUiAdapter.ts:147`) limpia la pantalla y resume en vez de volcar al scrollback:
      `formatConversationSummary` (`src/ui/CliUiAdapter.ts:45`) compone
      `conversation restored: N messages`, `you: …` y `assistant: …` con el último intercambio,
      colapsando espacios y saltos y recortando a 200 con `…`.
      tests: 6 en `core/tests/session/SessionManager.spec.ts` (filtrado de system/tool, respuesta
      vacía, copia, historial vacío, orden), 5 en `tests/ui/cliAdapter.spec.ts` (limpia antes de
      resumir, solo el último intercambio, recorte a 200, sesión sin respuesta, conversación
      vacía sin tocar pantalla), 2 en `tests/ui/spawnWiring.spec.ts` (el helper emite lo que dice
      el harness, silencio si vacía) y 4 en `tests/ui/transcript.spec.ts` (reemplaza las
      entradas, vacía la franja viva y el set `expanded`, conserva los hijos restaurados, no
      limpia si está vacía).

**Segunda tanda (revisión de la primera).** La primera tanda dejaba tres defectos: el turno
automático se guardaba como `user` a secas y `/resume` lo pintaba como si lo hubiera escrito
el usuario; un turno de generación de imagen llamaba a `provider.generateImage(prompt)` sin
empujar el `user`, así que tras reanudar aparecía una respuesta sin su pregunta; y la TUI
reemplazaba el transcript sin tocar `running`/`activity`, con el reloj de trabajo corriendo
sobre una cola que ya no existía.
hecho (core): flag `unprompted?: true` —nombre elegido porque describe el hecho que importa
(nadie lo pidió) y no el origen del texto— en `AskOptions` (`src/contract.ts:55`),
propagado a `UserMessage` (`src/types/providers.ts:120`) y de `Harness.ask`
(`src/harness.ts:24`) a `SessionManager.ask` (`src/session/SessionManager.ts:721`) y al
helper `userMessage()` (`src/session/SessionManager.ts:878`): el turno **se guarda igual**
en el historial (el modelo tiene que verlo) y solo se oculta de la UI. El filtro vive en
`conversation()` (`src/session/SessionManager.ts:582`), única puerta, así que ningún
renderer puede reintroducir el defecto; el flag **no** se expone en `ConversationEntry` y el
`assistant` de un turno `unprompted` sí se muestra (es trabajo real). `sessionTitle()`
(`src/session/SessionManager.ts:358`) ignora los `unprompted`, o una sesión que arrancó con
una continuación se titularía con esa frase. Nuevo helper `runImageTurn()`
(`src/session/SessionManager.ts:889`) que empuja el `user` con la misma forma que el camino
de texto (respetando `unprompted`) antes de llamar al endpoint de imagen.
hecho (cli): `MainLoop` pasa `unprompted: turn.continuation ? true : undefined`
(`src/MainLoop.ts:319`): solo el turno que nadie pidió —`CONTINUATION_PROMPT`, el texto que
encola el core— lleva el flag, nunca un prompt del usuario aunque haya hijos esperando. En
la TUI, `case "conversation"` (`src/ui/TuiUiAdapter.tsx:318`) deja el renderer en reposo
(`running: false`, `activity: undefined`) y resuelve como `deny` la aprobación que hubiera
pedido el turno de la sesión anterior —ese turno esperaba una respuesta que ya nadie va a
dar, igual que hace `close()` al salir—.
tests: 6 nuevos en `core/tests/session/SessionManager.spec.ts:1761` (turno `unprompted` en
el historial pero fuera de `conversation()`, turno normal visible, respuesta del
`unprompted` sí visible, `ask(..., { unprompted: true })` end-to-end, prompt de imagen en
historial y en `conversation()`, `sessionTitle()` ignora el `unprompted`) y 6 en el nuevo
`tests/ui/resumeWiring.spec.ts:213` (monta el `MainLoop` real con ink stubbeado y un
`IHarness` falso completo, metiendo los prompts por el `onSubmit` del adapter: repintado de
conversación + hijos tras `/resume` una sola vez y conversación antes que franja, renderer
en reposo tras repintar, nada al arrancar sin nada que mostrar, nada si el comando no cambió
de sesión, la continuación llega a `ask` con `unprompted: true`, y un prompt del usuario no
lleva el flag). Las dos guardas de fuente con `indexOf` sobre `MainLoop.ts` que había en
`tests/ui/spawnWiring.spec.ts` se retiraron: lo que fijaban lo fijan ahora esos tests de
comportamiento. En `tests/ui/cliAdapter.spec.ts` las aserciones pasaron de
`startsWith`/`toContain` a comparar la salida completa con `toBe`.
compatibilidad: `SESSION_VERSION` sigue en 4. Los historiales ya persistidos no distinguen el
prompt de continuación, así que se acepta que los turnos viejos se lean como estaban y solo
los nuevos se marquen; el campo es opcional y `SessionStore.load` no cambió.
hecho (cli): el arranque sí pasa la sesión. `src/main.ts` acepta el flag y lo entrega a
`MainLoop.start()` (`src/main.ts:102`), que lo resuelve en `MainLoop#resolveResume`
(`src/MainLoop.ts:218`) contra `harness.resolveSession(...)`: `SessionManager.initialize({sessionId})`
hace `store.load(id)` literal, así que un prefijo o un índice que llegaran ahí arrancarían una
sesión nueva en silencio. Formas aceptadas por `src/flags.ts`: `--resume <id>`, `-r <id>`,
`--session <id>`, `-s <id>`, `--resume=<id>` y `-r=<id>` (el `=` corto antes se ignoraba sin
avisar). Un id completo, un prefijo único o un índice 1-based: la resolución es siempre la
misma que la de `/resume`. `--resume`/`-r` desnudo reanuda la más reciente
(`listSessions()[0]`, ordenada por actividad; `src/MainLoop.ts:232`). Cualquier argv ambiguo
termina en error de uso con exit 2 (`USAGE_EXIT_CODE`, `src/main.ts:40` y `src/MainLoop.ts:58`),
nunca en sesión nueva silenciosa: valor que no resuelve, `--session`/`-s` sin valor, valor
vacío y store vacío con `--resume` desnudo (`NO_SESSIONS_TO_RESUME`, `src/MainLoop.ts:27`).
`usageError` (`src/flags.ts`) es pegajoso: gana a los demás flags de la misma línea de
comandos, con la excepción documentada de `--version`/`-V`, que es consulta pura y gana al
error de uso. Un `--resume` irresoluble no sale por `shutdown()` ni escribe desde el bucle:
`resolveResume` lanza `UsageError` y `main.ts` es el único que decide el código de salida
(exit 2, por `stderr`). `main.ts` llama a `resolveResume` **antes** del logo y de `start()`,
porque el logo se pinta más de una vez y `startSetup()` escribe en el terminal y puede pedir
input: un arranque condenado no debe llegar ni a lo uno ni a lo otro. `start()` vuelve a
resolver (la llaman también con el flag crudo), y resolver un id completo es idempotente
porque `resolveSession` prueba primero la coincidencia exacta.
El repintado de `start()` (`src/MainLoop.ts:155`, `showConversation`) se activa
justo con esa ruta. `src/main.ts` se reorganizó alrededor de `run(deps)` inyectable
(argv/stdout/stderr/exit/logo/version/createLoop) para que el orden de efectos sea testeable, y
el arranque quedó tras un guard de entrypoint (`realpathSync` con fallback `pathToFileURL`,
`isEntrypoint`) para que importar el módulo no tenga efectos.
tests: `cli/tests/flags.spec.ts` (parser: las cuatro formas, el `=`, el valor vacío y el
`--version` que gana al error), `cli/tests/main.spec.ts` (cadena argv → `run()` →
`resolveSession()` → `MainLoop.start()` → `initialize`, con el `MainLoop` real; un rechazo
con `--tui` no construye el renderer —se espía `TuiUiAdapter#start`— y un `--resume abc`
irresoluble no pinta el logo ni una vez) y `cli/tests/ui/resumeWiring.spec.ts` (resolución y
rechazos). Suite: 480 tests en 30 ficheros, en verde.
pendiente: no se ha probado contra un historial persistido real en una sesión interactiva;
todo lo anterior está verificado con `IHarness` stubbeado o con el `MainLoop` real pero sin
store de verdad. Eso es lo único que queda abierto.
Done when: tras `/resume` la pantalla muestra solo la conversación de la sesión reanudada,
en los dos renderers y sin intervención manual.
Depends on: nada.
