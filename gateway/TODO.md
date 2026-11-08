# TODO — Gateway (@racso2609/gateway)

Proceso **aparte** que consume la **lib publicada** del core (`@racso2609/core`), no el
workspace: es un servicio de larga vida con su propio ciclo de release. Hoy **no existe
`gateway/`** (`pnpm-workspace.yaml` solo lista `core` y `cli`), así que ninguna de estas
tareas está empezada. Bloqueado por la verificación de **F0** de `cli/TODO.md` §P4: el
paquete necesita `@racso2609/core` publicado en el registry.

Índice: no hace falta, todas las tareas están abiertas y agrupadas por fase.

Formato de este archivo: ver la skill `todo-format`. El diseño no se repite aquí: vive en
`docs/ARCHITECTURE.md` (fases F0–F6, decisiones 1–7 y huecos 1–10).

## F0 — prerrequisito: el paquete

- [ ] **Crear el paquete `gateway/` en el workspace**
El gateway es un proceso de larga vida con su propio ciclo de release, así que no puede nacer dentro de `core/` ni de `cli/`.
Done when: existe `gateway/package.json` con `name: "@racso2609/gateway"`, `private: false` y `@racso2609/core` como dependencia con rango publicado (no `workspace:*`), está listado en `pnpm-workspace.yaml` y `pnpm -r build` lo incluye.
Depends on: publicar `@racso2609/core` (`cli/TODO.md` §P4).
pendiente: sigue bloqueado porque el prerrequisito no está cumplido: no existe el directorio `gateway/` y `pnpm-workspace.yaml` solo lista `core` y `cli`; `cli/TODO.md` §P4 declara que la publicación (F0 de `docs/ARCHITECTURE.md`) todavía no está hecha. Se desbloquea al cerrar `cli/TODO.md` §P4.

## F1 — SessionRegistry + runTurn

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

## F2 — servidor HTTP + SSE

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

## F4 — aprobaciones

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

## F5 — cronjobs y webhooks

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

## Orden sugerido

La referencia del orden es `docs/ARCHITECTURE.md` (fases F0–F6); aquí sólo se lista qué tarea de arriba abre cada fase.

1. F0 — el plan de publicación está cerrado en `docs/INSTALL.md` y sus tareas en `cli/TODO.md` §P4. El paquete `gateway/` necesita `@racso2609/core` publicado.
2. F1 — `SessionRegistry`, `runTurn()` en `core/src/session/turn.ts` con `IHarness` intacta y el `AbortSignal` que atraviesa el turno.
3. F2 — `SessionStore` con lease y tmp+rename, bloque `gateway` en `Config`, `EventBuffer` con sobre `{sessionId, turnId, seq}` y servidor `node:http` + SSE.
4. F4 — `sessionId` en `ApprovalRequest`, `approvals[]` en `SpawnHandle`/`SessionRecord` y `ApprovalQueue` por sesión con TTL 120 s y `deny` por defecto. Va antes de los trabajos: un cronjob que dispara tools con efectos necesita una decisión que no dependa de una terminal abierta.
5. F5 — `jobs.json`, cronjobs sobre `runTurn`, webhooks por el mismo camino, persistencia entre reinicios y `CONTRACT.md`.

## Descartados

- **«Diseñar el contrato del gateway» (`core/GATEWAY.md`)** — el diseño ya está cerrado en `docs/ARCHITECTURE.md` (decisiones 1–7 y huecos 1–10) → se sustituye por las tareas de F1, F2, F4 y F5, y lo que el consumidor necesita leer pasa a `CONTRACT.md` (tarea de F5).
- **«Definir el almacenamiento de trabajos»** — el diseño decidió `jobs.json` junto a `SessionStore` (`docs/ARCHITECTURE.md`, `## Modelo de runtime`) → queda como tarea de implementación de F5.
- **«Exponer un servidor HTTP con `spawn` y `status`»** — se reemplaza por el servidor `node:http` + SSE de F2, que sirve turnos y stream, no `spawn` suelto.
- **«Proteger el gateway con token»** — ninguna fase de `docs/ARCHITECTURE.md` lo decide → pasa a `Preguntas abiertas` de esta sección en vez de quedar como tarea.
- **«Definir la política de aprobaciones de un trabajo sin usuario»** — decidido: `ApprovalQueue` por sesión con TTL 120 s y `deny` por defecto (decisión 3) → queda como tarea de F4.

## Preguntas abiertas

- **¿Autentica el gateway las peticiones con un token?** Las fases F0–F6 de `docs/ARCHITECTURE.md` no lo deciden, y sin autenticación un puerto que ejecuta tools (`shell`) es ejecución remota en la máquina del usuario. No es tarea hasta que se decida: para cerrarla hay que fijar si el token vive en `config.gateway` y si toda ruta salvo `/health` lo exige.
- **¿Los `.map` viajan en los tarballs?** Afecta al tamaño del paquete del gateway igual que al de los dos actuales; queda abierto en `docs/INSTALL.md` (`Preguntas abiertas`, punto 3) y se cierra con la misma decisión.
