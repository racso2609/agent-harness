# Journal — CLI · P6 — Continuación automática tras un hijo

Índice: [TODO del repo](../../../TODO.md) · TODO vivo: [cli/TODO.md](../../../cli/TODO.md)
Estado: cerrado el 2026-11-02

El turno sin prompt que arranca sola la sesión cuando un hijo deja trabajo sin entregar: la señal del core, el disparador, el tope y el aviso en el cierre del turno.

### Exponer si un hijo asentado dejó trabajo sin entregar
      El core ya responde la pregunta: `pendingSpawns()` devuelve los hijos asentados
      cuyo resultado aún no ha entrado en un turno del padre, y el CLI lo consume para
      decidir si continuar. Antes de esto el CLI no podía decidir: el core no decía si el
      resultado del hijo llegó antes o después del último turno del padre ni cuántos hijos
      quedaron sin entregar.
hecho (contrato): `IHarness.pendingSpawns` en `core/src/contract.ts:131`, documentado
como vista de sólo lectura que no drena; la declaración interna está en
`core/src/session/SessionManager.ts:158`.
hecho (implementación): `SessionManager.pendingSpawns()` en
`core/src/session/SessionManager.ts:640` devuelve una copia de `undelivered`, que sólo
vacía `flushPendingSpawns()`; `core/src/harness.ts:140` delega con
`return this.session.pendingSpawns()`.
hecho (consumidor): `cli/src/MainLoop.ts` la usa dos veces —
`this.harness.pendingSpawns()` dentro de `maybeContinue()` (`:303`) y en el cierre del
turno, para comparar el lote ya entregado (`:434`).
hecho (tests): los 8 casos de `core/tests/session/SessionManager.spec.ts`
(`:1358-1600`): «reports a settled child until the parent runs the turn that delivers
it», «persists the delivered child result even when the turn then fails», «delivers two
settled children in settlement order», «does not report a running child as pending»,
«hands out a copy of the pending children, not its own array», «queues a settled child
that was never delivered when the session is resumed», «does not queue a child already
delivered before the resume», «does not queue a child that was still running when the
process died».
      Depends on: nada; el consumidor del CLI quedó cableado en la tarea siguiente.
      Nota: el contrato vive como tarea espejo en `core/TODO.md` §9 («Exponer los hijos asentados con resultado sin entregar»).

### Arrancar un turno sin prompt cuando un hijo deja trabajo
      `MainLoop` encola un turno de continuación (mismo camino que `enqueue`) cuando un
      `spawnSettled` trae trabajo pendiente y el usuario no está escribiendo.
hecho (disparador): en `cli/src/MainLoop.ts:188`, dentro de `onSpawnEvent`, la
suscripción `if (event.type === "settled") this.maybeContinue();`; el método
`protected maybeContinue(...)` vive en `cli/src/MainLoop.ts:302` y el turno entra por
`if (decision.continue) this.enqueue(CONTINUATION_PROMPT, "continuation", pending);`
(`cli/src/MainLoop.ts:327`).
hecho (guardas de fuente, porque el bucle no es montable en test): en
`cli/tests/ui/spawnWiring.spec.ts`, el cuerpo de `maybeContinue` obtenido con
`between("protected maybeContinue(", "protected isWaitingForPrompt()")` lo fijan cuatro
casos —«asks the core what is still undelivered instead of trusting the event»,
«only continues while the loop waits with nothing queued», «queues the continuation
through enqueue, marked as such», «says it is waiting at most once per
undelivered batch»—, más «evaluates the continuation after a child settles» sobre la
suscripción y «feeds the draft signal the TUI reports» sobre `onDraftChange`. La
decisión pura está cubierta en
`cli/tests/ui/continuation.spec.ts` («continues when an undelivered child left a
result», «does not continue for a child that failed», «does not continue with nothing
undelivered», «keeps waiting while the loop is inside a turn»).
      Decidir antes (resuelto): (i) solo aplica en TUI — lo fija «never continues in line
      mode» en `spawnWiring.spec.ts`, y `nextPrompt()` en `cli/src/MainLoop.ts:359` contiene
      `if (!this.isTui())`; (ii) el turno automático **no** pisa lo que el usuario escribe:
      `continuationDecision` recibe `hasUserDraft` y devuelve `DRAFT_WAITING_NOTICE`, fijado
      por «waits and says so when the user is typing» en `continuation.spec.ts`.
      Depends on: exponer si un hijo asentado dejó trabajo sin entregar.

### Acotar las continuaciones automáticas
      Sin tope, un hijo que deja trabajo cada vez encadena turnos infinitos y gasta tokens
      sin control. Ya hay tope.
hecho (config): `maxAutoContinuations?: number | false` en `SessionsConfig`
(`core/src/configuration/index.ts:102`) y su default
`config.sessions.maxAutoContinuations ??= 5` (`core/src/configuration/index.ts:174`),
donde `0` y `false` significan deshabilitado.
hecho (lectura y decisión): `protected maxAutoContinuations()` en
`cli/src/MainLoop.ts:333` lee el valor de la config en cada decisión, y `maybeContinue`
le pasa `budget: { used: this.autoContinuations, max: this.maxAutoContinuations() }`
(`cli/src/MainLoop.ts:313`).
hecho (aviso): `autoContinuationLimitNotice` en `cli/src/ui/continuation.ts:20`,
emitido desde `continuationDecision` (`cli/src/ui/continuation.ts:115`).
hecho (tests): en `cli/tests/ui/continuation.spec.ts`, los casos del bloque «automatic
continuation cap» —«continues below the cap», «stops at the cap and says the number»,
«takes the number in the notice from the cap, not from the text», «stays stopped once
the cap is exceeded», «treats 0 as disabled», «treats false as disabled at any count»,
«lets a human prompt open a new budget», «keeps the waiting notice when the user types
on a spent budget», «says nothing about the cap when no child left work», «writes the
cap notice in English with the interpolated number».
      Decidir antes (resuelto): el default es **5**; el contador se resetea con input del
      usuario — `enqueueFromUser` hace `this.autoContinuations = 0;`
      (`cli/src/MainLoop.ts:283`), fijado por «opens a new budget whenever the user sends a
      prompt» en `cli/tests/ui/spawnWiring.spec.ts`.
      Depends on: arrancar un turno sin prompt cuando un hijo deja trabajo.

### Contar el turno automático como continuación en el cierre del turno
      El aviso de cierre (`formatTurnOutcome`) hoy describe el turno pasado; en una cadena automática debe indicar que la sesión sigue sola, para que el usuario no crea que el proceso quedó parado.
hecho (texto): `cli/src/ui/outcome.ts:8` exporta
`CONTINUING_ALONE_NOTICE = "session continues on its own"`; `formatTurnOutcome`
(`cli/src/ui/outcome.ts:58`) acepta un tercer parámetro `more = false`
(`cli/src/ui/outcome.ts:64`) y añade el aviso al final del cierre cuando es verdadero
(`cli/src/ui/outcome.ts:79`).
hecho (cableado): `UiEvent` gana el campo opcional `continuation`
(`cli/src/ui/UiAdapter.ts:45`); `MainLoop` lo marca en el `turnEnd`
(`cli/src/MainLoop.ts:450`: `continuation: turn.continuation &&
this.queue.some((entry) => entry.continuation)`) y los dos renderers lo pasan a
`formatTurnOutcome` — `cli/src/ui/CliUiAdapter.ts:140` y
`cli/src/ui/TuiUiAdapter.tsx:341` —, que ya no cierran en silencio un turno
`completed` cuando la sesión sigue sola.
hecho (tests): bloque `describe("formatTurnOutcome while the session continues alone")`
en `cli/tests/ui/outcome.spec.ts:126-158`, 4 casos: el literal completo del turno
encadenado (`… · session continues on its own`, `:127`), el silencio del turno
`completed` automático (`:138`), el último turno de la cadena cerrando sin aviso (`:144`)
y la estabilidad de `CONTINUING_ALONE_NOTICE` (`:155`). Los tres primeros son los que pide
el `Done when:`.
Depends on: arrancar un turno sin prompt cuando un hijo deja trabajo.
