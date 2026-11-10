# Arquitectura de racso-harness

## Contexto

`@racso2609/core` es la **librería base** de todo: expone `createHarness(deps): IHarness` (`core/src/contract.ts`) como SDK sin interacción, con `SessionManager`, `SessionStore`, `SpawnManager`, providers, tools, agents y skills, y no sabe nada de terminal, HTTP ni renderers. Sobre esa lib se apoyan dos implementaciones **separadas**: `@racso2609/cli` (proceso corto, una sesión, renderer de líneas por defecto y TUI ink con `--tui`) y el **gateway**, un **servicio aparte de larga vida** que será su propio paquete/proceso y consume la **lib publicada** del core para poder manejarlo todo a medida (N sesiones en vivo, streaming a navegador, aprobaciones remotas, cronjobs y webhooks). Un **frontal web** llegará después del gateway, agrupará sesiones en progreso, mostrará estado e historial de cada una, creará sesiones nuevas y permitirá chatear desde ahí (estilo OpenClaw / Hermes UI); después soportará cronjobs y webhooks. Los dos paquetes actuales se publican; el detalle de publicación vive en `docs/INSTALL.md`.

## Modelo de runtime

Dos procesos sobre una sola lib. El estado compartido es el **directorio**, no un socket.

```
        ~/.racso-harness/
        ├── config.json                  (Config, core/src/configuration/index.ts)
        ├── sessions/<id>.json           (SessionRecord v4, core/src/session/SessionStore.ts)
        ├── sessions/<id>.lock           (lease de escritura por sesión)
        ├── agents/*.md                  (AgentLoader)
        ├── skills/                      (SkillLoader)
        └── jobs.json                    (cronjobs + webhooks: F5)

  proceso `cli`  (corto: una sesión, una terminal)          proceso `gateway`  (larga vida + SPA)
  ┌───────────────────────────────────────────┐            ┌───────────────────────────────────────────┐
  │ createHarness()  → IHarness               │            │ createHarness() → IHarness (N veces)      │
  │ SessionManager   (una sesión activa)      │            │ SessionRegistry (N SessionManagerImpl)    │
  │ SpawnManager     (hijos en background)    │            │ TurnController (1 turno por sesión)       │
  │ approveWith()    (handler de terminal)    │            │ EventBuffer    (circular, por turno)      │
  │ MainLoop         (stdin → ask() → UiEvent)│            │ ApprovalQueue  (por sesión, TTL 120 s)    │
  │ CliUiAdapter / TuiUiAdapter               │            │ Scheduler      (jobs.json: cron/webhooks) │
  │                                           │            │ node:http → SSE  +  SPA estática          │
  └──────────────┬────────────────────────────┘            └──────────────┬────────────────────────────┘
                 │ R: config.json, sessions/*.json                          │ R/W: config.json, sessions/*.json,
                 │ W: sessions/<id>.json, <id>.lock                         │      <id>.lock, jobs.json
                 ▼                                                          ▼
        └────────────────~/.racso-harness/ (disco: único canal)────────────────┘
```

**El CLI y el gateway no se hablan entre sí**: no hay IPC, ni socket, ni cola de mensajes entre ellos; comparten el estado por disco y la sesión persistida (`sessions/<id>.json`) es el único canal. El coste de esa decisión es que ninguno de los dos ve los cambios del otro en caliente: sólo al leer (`SessionStore.load`) o en el siguiente arranque.

## Huecos exactos en el código

| hueco                                         | fichero/símbolo                                                                                                  | qué falta                                                                                                                                                                                                                                                                 | fase |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1. Registro de sesiones vivas                 | `core/src/harness.ts`, `core/src/contract.ts` (`IHarness.loadSession`)                                           | Hoy sólo hay `Harness` con **una** sesión activa y `loadSession` la sustituye; no hay nada que sostenga N sesiones simultáneas ni que las enumere por estado.                                                                                                             | F1   |
| 2. Ejecución del turno sin terminal           | `cli/src/MainLoop.ts`                                                                                            | El turno (bucle de stdin + `harness.ask` + traducción `ChatEvent`→`UiEvent`) vive dentro del cliente de terminal; el gateway no puede reutilizarlo.                                                                                                                       | F1   |
| 3. Cancelación del turno                      | `core/src/session/spawn.ts` (`SpawnRunner.signal`)                                                               | Ningún `AbortSignal` atraviesa el turno de la sesión principal; el `signal` sólo lo recibe el runner de hijos, así que un turno en curso no se puede abortar desde fuera.                                                                                                 | F1   |
| 4. Streaming a cliente remoto                 | `core/src/types/providers.ts` (`ChatEvent`, `ChatEventListener`), `IHarness.onSpawnEvent`                        | `ChatEvent` no lleva `seq` ni `turnId`; `onSpawnEvent` es live-only (no replica el pasado); no existe `EventBuffer`. Un cliente que se engancha a mitad de turno no puede reconstruir lo ya emitido.                                                                      | F2   |
| 5. Servidor HTTP                              | `core/src/`, `cli/src/`                                                                                          | Ninguna referencia a `node:http` en ninguno de los dos paquetes: no hay servidor donde colgar SSE ni la SPA.                                                                                                                                                              | F2   |
| 6. Cola de aprobaciones                       | `core/src/contract.ts` (`ApprovalHandler`, `IHarness.approveWith`), `core/src/tools/Tool.ts` (`ApprovalRequest`) | `approveWith` instala **un único handler global**; `ApprovalRequest` no lleva `sessionId`; `SessionManager.approve` **deniega sin handler** (`core/src/session/SessionManager.ts`), así que N sesiones comparten handler y una petición no se puede atribuir a su sesión. | F4   |
| 7. Persistencia de la decisión                | `core/src/session/spawn.ts` (`SpawnHandle`), `core/src/session/SessionStore.ts` (`SessionRecord`)                | Ninguno de los dos tiene `approvals[]`: la decisión tomada sobre una tool no queda registrada junto al trabajo al que pertenece.                                                                                                                                          | F4   |
| 8. Lock/atomicidad del store                  | `core/src/session/SessionStore.ts` (`SessionStore.save`, `SESSION_VERSION = 4`)                                  | `save` hace `fs.writeFileSync` sobre el fichero entero, sin lock y sin tmp+rename: dos escritores sobre la misma sesión se pisan y un fallo a mitad deja el JSON truncado.                                                                                                | F2   |
| 9. Almacenamiento de trabajos (cron/webhooks) | —                                                                                                                | No existe `jobs.json` ni equivalente: no hay persistencia de programaciones ni de sus ejecuciones.                                                                                                                                                                        | F5   |
| 10. Bloque `gateway` en `Config`              | `core/src/configuration/index.ts`                                                                                | `Config` no tiene bloque `gateway` (no hay puerto, bind, ni política de aprobaciones por defecto del servicio).                                                                                                                                                           | F2   |
| 11. Cancelación que no corta la llamada en vuelo | `core/src/session/SessionManager.ts` (`spawnManager().runner`), `core/src/types/providers.ts` (`Provider.chat`) | `IHarness.cancelSpawn` aborta el `AbortController` del hijo y el estado pasa a `cancelled`, pero el runner no pasa ese `signal` a `child.ask()` y `Provider.chat()` no acepta señal: sólo hay un `if (signal.aborted) throw` tras `child.initialize()`, así que cancelar no interrumpe la petición ya lanzada al proveedor. | A2 |

## Decisiones

### 1. `SessionRegistry` en core en lugar de N `createHarness()`

**Veredicto: un `SessionRegistry` en core sobre N `SessionManagerImpl` que comparten un solo `Config` y un solo `SessionStore`.**

Cada sesión viva necesita provider, history y usage propios (igual que `SessionManagerImpl` hijo de `spawn`), pero no necesita su propio `Config` ni su propio store: N × `createHarness()` obliga a releer `config.json` N veces, y aísla approvals y spawns por sesión sin ninguna ganancia, porque el gateway quiere una política de aprobación y un directorio comunes. Con un registry, el gateway enumera sesiones, rutea un turno a la correcta y mantiene el estado compartido en un solo sitio. `IHarness` no cambia: el registry se construye con las piezas que la lib ya exporta.

### 2. SSE en lugar de WebSocket, y reenganche a mitad de turno

**Veredicto: SSE sobre `node:http`, con sobre `{sessionId, turnId, seq}` y un `EventBuffer` circular por turno.**

`ChatEvent` (`core/src/types/providers.ts`) no lleva `seq` ni `turnId`, y `onSpawnEvent` no replica el pasado; sin el buffer, **recargar el navegador a mitad de turno pierde el texto en vuelo** que ya salió por el stream. Por eso el gateway envuelve cada evento en `{sessionId, turnId, seq}` y lo guarda en un anillo por turno: el cliente que vuelve manda el `turnId` y el último `seq` que vio y recibe el resto desde el buffer. SSE basta porque el flujo es unidireccional (servidor→navegador) y las acciones del usuario son peticiones HTTP normales; no hace falta un canal bidireccional. Lo **ya asentado** no se reconstruye por eventos, se relee de las proyecciones puras del core: `status()` para el estado de la sesión, `conversation()` para el historial legible y `listSpawns()`/`childHistory()` para los hijos.

### 3. Cola de aprobaciones por sesión

**Veredicto: `ApprovalQueue` por sesión, `wait` con TTL de 120 s y `deny` por defecto; la decisión se persiste en `SpawnHandle.approvals[]`.**

Hoy `approveWith` instala un único handler global y `ApprovalRequest` no lleva `sessionId`, de modo que con N sesiones una petición no se puede atribuir. La cola es por sesión para que un `ask` de la sesión A no se conteste desde el panel de la B. Si **no hay cliente conectado** o no contesta en 120 s, la petición se resuelve como `deny`: la tool `shell` no se ejecuta y el trabajo **no muere en silencio**, queda registrado como denegado en `SpawnHandle.approvals[]` y el turno continúa con el error de tool (`ToolResult.isError`), visible en `conversation()`. En el gateway, esta fase va **después** de los turnos (F4) y **antes** de cronjobs/webhooks (F5): un cronjob que dispara tools con efectos necesita antes un mecanismo de decisión que no dependa de que haya una terminal abierta.

### 4. Fase 1 del frontal: sólo lectura

**Veredicto: la fase 1 del frontal leerá `SessionStore` + proyecciones puras: 0 arranques de provider y 0 escrituras.**

Agrupar sesiones, ver estado e historial no necesita un turno: `SessionStore.list()`/`load()`, `conversation()` y `status()` dan todo lo que se pinta. Escribir sí lo necesita, y exige dos piezas que aún no existen: el turno **fuera** de `MainLoop` (hueco 2) y un store con **lock** (hueco 8). Publicar primero el frontal de lectura separa el riesgo de UI del riesgo de concurrencia: si algo falla en F3, no hay forma de corromper una sesión.

### 5. Concurrencia del `SessionStore`

**Veredicto: lease por fichero (`<id>.lock`) más escritura atómica tmp+rename.**

`save` hace hoy `fs.writeFileSync` sobre el fichero entero (`SESSION_VERSION = 4`): dos escritores sobre la misma sesión se pisan y un corte a mitad deja un JSON inválido que `load` descarta. El lease `<id>.lock` serializa a los escritores de **una** sesión (no bloquea sesiones distintas) y el tmp+rename garantiza que el lector siempre ve un fichero completo o el anterior, nunca uno truncado. La combinación mínima que evita perder datos con dos turnos sobre la misma sesión es **lease + relectura dentro del lease**: el segundo turno no puede partir de la copia en memoria que leyó antes de adquirirlo. El lease lleva expiración por si un proceso muere sin liberarlo.

### 6. El turno como función libre en `core/src/session/turn.ts`

**Veredicto: `runTurn()` es una función libre exportada desde `core/src/session/turn.ts`; `IHarness` queda intacta.**

Meterlo en el contrato obligaría a añadir una entrada pública (`runTurn` o equivalente) que el CLI no usa y que habría que versionar en cada ajuste de streaming. Una función libre compone con lo que ya existe —`SessionManagerImpl`, `ask(prompt, { onEvent })`— y sirve a los dos consumidores por igual: el gateway la llama por sesión, el CLI la puede ir adoptando sin cambiar su tipo de retorno. `IHarness` sigue siendo el SDK estable; el gateway importa `runTurn` del paquete publicado como import adicional, no como método del contrato.

### 7. Qué NO se toca en esta fase

**Veredicto: no hay web, no hay cronjobs, no hay multi-provider nuevo y no se cambia `IHarness` en esta fase.**

La lista es explícita: (1) sin frontal web — primero el servidor y su stream (F2, F3); (2) sin cronjobs ni webhooks ni `jobs.json` — van en F5, después de las aprobaciones; (3) sin providers nuevos ni cambios en `core/src/types/providers.ts` más allá del sobre de eventos en el gateway; (4) sin cambios en `IHarness` (`core/src/contract.ts`) ni reescrituras de `SessionManager`, `SessionStore` o `SpawnManager` más allá de lo que pidan los huecos 7 y 8. Cada cosa que se difiere tiene su fase en la sección siguiente, para que no se cuele como "de paso".

## Fases

1. **F0 — empaquetado y publicación.** Entrega: `core/` y `cli/` publicables y consumibles por un tercer paquete (el gateway). Cierre: `pnpm -r build && pnpm -r lint && pnpm -r test` en verde y un consumidor externo que importa `@racso2609/core` del registro, no del workspace. Depende de: nada (bloquea a todas).
2. **F1 — `SessionRegistry` + `runTurn`.** Entrega: `SessionRegistry` sobre N `SessionManagerImpl` con `Config`/`SessionStore` compartidos (decisión 1) y `runTurn()` en `core/src/session/turn.ts` (decisión 6). Cierre: un test en `core/tests/session/` que crea dos sesiones, corre un turno en cada una y comprueba que ambas persisten y que el segundo no ve el history del primero; `pnpm --filter @racso2609/core test` en verde. Depende de: F0.
3. **F2 — servidor HTTP + SSE.** Entrega: proceso gateway con `node:http`, endpoint SSE con sobre `{sessionId, turnId, seq}` y `EventBuffer` por turno (decisión 2), `SessionStore` con lease + tmp+rename (decisión 5) y bloque `gateway` en `Config` (hueco 10). Cierre: test de integración que abre el stream, arranca un turno, corta la conexión a mitad, reconecta con el último `seq` y recibe exactamente los eventos que faltaban, sin duplicados; más un test de dos `save` concurrentes sobre la misma sesión que no pierde mensajes. Depende de: F1.
4. **F3 — frontal read-only.** Entrega: SPA que lista sesiones en progreso con estado e historial, leyendo `SessionStore` + `status()`/`conversation()`/`listSpawns()`, sin crear sesiones ni escribir (decisión 4). Cierre: al cargar el frontal no se instancia ningún provider (0 llamadas a `initialize`/`ask` en el servidor) y ningún fichero de `sessions/` cambia de `mtime` durante la sesión de navegación. Depende de: F2.
5. **F4 — aprobaciones.** Entrega: `ApprovalQueue` por sesión con TTL 120 s y `deny` por defecto, `sessionId` en la petición y `approvals[]` en `SpawnHandle`/`SessionRecord` (decisión 3, huecos 6 y 7). Cierre: test que dispara una tool bajo política `ask`, no responde, avanza el reloj 120 s y comprueba que la tool quedó denegada y registrada en `approvals[]`; segundo test con dos sesiones que verifica que la respuesta de la A no resuelve la petición de la B. Depende de: F2.
6. **F5 — cronjobs y webhooks.** Entrega: `Scheduler` en el gateway sobre `jobs.json`, disparando `runTurn` en sesiones existentes o nuevas, con las aprobaciones de F4 como gate. Cierre: un job programado que corre y deja rastro en `sessions/<id>.json`, y un webhook que dispara el mismo camino; ambos con test en verde. Depende de: F4.
7. **F6 — frontal escritura.** Entrega: crear sesiones y chatear desde el navegador (POST de turno + SSE ya existente), con aprobaciones resueltas desde la UI. Cierre: desde el frontend se crea una sesión, se manda un prompt, se ve el streaming y se responde una aprobación, y `sessions/<id>.json` contiene el turno completo. Depende de: F3 y F4.

## Riesgos

- **Dos procesos escriben la misma sesión a la vez** (CLI abierto y gateway sirviendo esa sesión) → el lease `<id>.lock` con expiración + relectura dentro del lease (decisión 5) lo convierte en espera acotada, no en corrupción.
- **Cliente que recarga a mitad de turno y pierde texto en vuelo** → sobre `{sessionId, turnId, seq}` con `EventBuffer` circular por turno, y reconstrucción de lo asentado desde `status()`/`conversation()`/`listSpawns()`.
- **Aprobación sin nadie conectado que ejecuta una tool peligrosa** → TTL 120 s con `deny` por defecto y decisión registrada en `approvals[]`, visible en el historial.
- **El CLI se queda con la lógica del turno dentro de `MainLoop`** y el gateway la duplica → `runTurn()` en `core/src/session/turn.ts` desde F1, con `IHarness` intacta, y el CLI migrando en F2–F3.
- **`gateway` como paquete nuevo rompe el contrato publicado del core** → `IHarness` no cambia (decisión 7): el gateway consume `createHarness` más imports adicionales, así que un fallo del gateway no obliga a republicar ni a subir versión mayor del core.

## Notas de verificación

- `cli/package.json` declara `"private": true`: a día de hoy `@racso/cli` no se publica, sólo se publica el del core (ambos con el scope actual, sin renombrar; el scope decidido es `@racso2609`, ver `docs/INSTALL.md`). Lo que el contexto llama "ambos paquetes se publican" es el **objetivo** y es lo que cierra F0; no es cierto en el estado actual del repo.
- `node_modules` en la raíz confirma el workspace pnpm; `pnpm-workspace.yaml` no se leyó línea a línea, pero los scripts raíz son `pnpm -r build|lint|test` (`package.json`).
- El `signal: AbortSignal` está en las opciones de `type SpawnRunner` (`core/src/session/spawn.ts:42`), no en
  el `SpawnHandle` (`spawn.ts:7`), que no declara ni `signal` ni `approvals[]`.
- La denegación sin handler está en `core/src/session/SessionManager.ts` (`approve`, `logger.warn("Approval required but no handler installed; denying")`), no en `Harness`.
- El directorio raíz y las rutas de `config.json` y `sessions/` salen de `core/src/utils/env.ts` (`HARNESS_DIR_NAME = ".racso-harness"`, `harnessHome()`) y de `core/src/session/SessionStore.ts`/`core/src/configuration/index.ts`. `agents/` y `skills/` existen en el runtime (`agentsHome()`, `skillsHome()`) aunque el contexto sólo enumeraba config, sessions, leases y jobs; se incluyen en el diagrama porque están en disco.
- `docs/` no existía; este documento lo crea. `docs/INSTALL.md` no se toca ni se referencia como existente.
- No se ejecutó ningún test: es un documento de diseño y no cambia comportamiento.
