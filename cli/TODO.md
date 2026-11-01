# TODO — CLI (racso-harness)

## Contexto
El CLI hoy es síncrono por turno: `MainLoop.loop()` hace `await harness.ask(prompt)`
y no pinta nada hasta tener la respuesta completa. El core ya tiene lo necesario
para la parte difícil —`SpawnManager` con `SpawnStatus` (`running/done/error`) y
eventos `started/settled`, y un mensaje `system` que `formatSpawnResult` inyecta
en el padre cuando un hijo termina— pero el CLI no consume esos eventos.

Decidido: la UI será una **TUI de pantalla completa** inspirada en Antigravity CLI,
Claude Code y opencode. Las tareas de `P1` están escritas para funcionar en el modo
actual, pero se implementan dentro de esa TUI, así que `P0` va primero.

Formato de este archivo: ver la skill `todo-format`.

## P0 — TUI de pantalla completa (bloquea P1)

- [x] **Elegir el stack de rendering y su costo de dependencias** — DECIDIDO: ink
decisión: **ink 8 + React 19** (`jsx: react-jsx`, sin `import React`). Coste real medido al instalarlo: `+26` paquetes en producción. Alternativa descartada: renderer propio sobre ANSI + `readline` — cero dependencias, pero obliga a reimplementar layout, scroll y repintado, que es justo donde `terminal/stdin.ts` ya acumula deuda.
por qué encaja: ink da paneles, `useInput` y re-render incremental, y `MainLoop` ya no escribe a stdout directamente, así que los dos renderers conviven.

- [x] **Extraer la UI detrás de una interfaz de paneles**
hecho: `src/ui/UiAdapter.ts` define `UiEvent` (status, notice, text, reasoning, toolStart/Output/End, turnStart/End, spawn, spawnSettled, reset) y `UiAdapter` (`render`, `promptApproval`, `renderImage`, `close`). `MainLoop` solo habla esa interfaz; `renderEvents.ts#toUiEvents` traduce `ChatEvent` del core a la misma. Ningún módulo del loop escribe a stdout.

- [x] **Portar la pantalla base (historial + input + status bar)**
hecho: `ui/tui/App.tsx` (dos paneles + caja de input con `useInput` + status bar + franja de hijos) y `ui/TuiUiAdapter.tsx`, que monta ink y re-renderiza por evento. Arranca con `--tui`; el modo líneas sigue siendo el default (`CliUiAdapter` implementa la misma interfaz).
hecho (approval): `TuiUiAdapter.promptApproval` muestra la petición como pregunta seleccionable dentro del panel (`approval` en el estado) y resuelve la promesa al pulsar `y` (allow), `a` (always), `n`/`esc` (deny) o `←/→` + enter. El core ya aceptaba una promesa (`approvalHandler`), así que no hizo falta tocarlo; `always` sigue cacheándose en `SessionManager`. Una segunda petición mientras hay una en pantalla se **deniega** en vez de encolarse, para que el usuario siempre sepa qué está contestando. `close()` resuelve como `deny` cualquier approval abierta antes de desmontar.
pendiente (approval): no hay test de interacción real (los tests fijan el estado que recibe `App`, no las teclas). Probar a mano: `/spawn` o una tool `shell` en `--tui` debe abrir la pregunta y bloquear el turno hasta responder.
riesgo conocido: si `config.needsSetup()` es verdadero, `startSetup` corre **antes** de montar ink y compite por stdin con el renderer. Hoy no se dispara con una config existente, pero hay que decidir si el setup se pide en modo líneas aun con `--tui`, o se porta a la TUI.

- [x] **Definir el layout de progreso (franja de hijos + actividad)** — DECIDIDO: franja inferior colapsable
decisión: **una sola franja inferior, dinámica y colapsable**. Reglas: (1) si no corre nada, la franja no existe — cero líneas gastadas; (2) el turno en curso se indica con `activity` dentro del input box (`working`, `thinking`), no en la franja; (3) cada hijo ocupa una línea entre la conversación y el input, con icono, agente, id y tiempo; (4) un hijo terminado permanece 5 s marcado `done`/`error` y desaparece, para que un hijo rápido sea perceptible.
por qué no panel lateral: parte el ancho y con 80 columnas deja el texto en ~50, que es justo lo que rompe la legibilidad del historial (Claude Code lo usa porque asume pantalla ancha). Por qué no inline: el estado se pierde al hacer scroll y obliga a reescribir líneas ya pintadas, la misma deuda que `terminal/stdin.ts` arrastra.
hecho: `ui/tui/progress.ts` concentra la lógica pura (visibilidad con ventana de 5 s, tiempo transcurrido que congela al terminar, icono y color por estado) y `App.tsx` la consume; `TuiUiAdapter` pasa `startedAt`/`finishedAt` desde el `SpawnHandle` del core. 8 tests en `tests/ui/progress.spec.ts`.
pendiente: la `activity` del input solo se alimenta de `reasoning`/`turnStart`; cuando `P1` conecte `onSpawnEvent` conviene mostrar también el nombre de la tool en curso (`working · shell`).

## P1 — Feedback mientras el turno corre

- [x] **Consumir los eventos de spawn en la UI**
hecho: `MainLoop` se suscribe con `harness.onSpawnEvent()` al inicializar y traduce cada evento a `spawn`/`spawnSettled`; el adapter del TUI actualiza la franja y el de líneas imprime una línea por arranque y por cierre (con el error del hijo si falló).

- [x] **Mostrar trabajo en curso**
hecho: `activity` dentro del input box. `turnStart` → `working`, `reasoning` → `thinking`, `toolStart` → `working · <tool>`, `toolEnd` → `working`, `turnEnd` → reposo. El status bar sigue mostrando provider/modelo/agente/tokens.
nota: el caso `working` usa texto plano, no spinner animado; un spinner necesita un tick que repinte aunque no lleguen eventos. Se deja para cuando haga falta (un `shell` largo ya muestra salida viva, que es mejor señal).

- [x] **Mostrar estado por subagente**
hecho: cada hijo aparece con `agentId`, `spawnId`, tiempo transcurrido e icono (`◐` corriendo, `✓` done, `✗` error), y se marca al hacer `settled`; desaparece 5 s después (`progress.ts`).

## P2 — Contrato de retorno de los subagentes

- [ ] **Verificar el contrato de resultado de spawn en todos los agentes**
  `formatSpawnResult` ya cubre error y texto vacío (`(no output)`, "unknown error"),
  pero ningún test lo fija como contrato: se puede romper sin que nadie lo note.
  Done when: un test por caso (`done` con texto, `done` sin texto, `error`) y una
  nota en `core/agents/*.md` de que el mensaje final es la respuesta al padre.
  Depends on: nada.

- [ ] **Notificar al usuario el estado final de cada hijo**
  Hoy el resultado del hijo llega al padre como mensaje `system` en el turno
  siguiente; el usuario en pantalla no ve nada en el momento en que termina.
  Done when: al hacer `settled` la TUI pinta una línea con resultado o error del hijo.
  Depends on: consumir los eventos de spawn.

- [ ] **Cerrar cada turno con qué pasó, qué falta y qué sigue**
  Un turno que termina sin resumen obliga al usuario a inferir el estado.
  Done when: el cierre del turno incluye estado (éxito/fallo), pendientes y el
  siguiente paso concreto.
  Depends on: notificar al usuario el estado final de cada hijo.

## P3 — Información adicional en el UI

- [ ] **Mostrar el razonamiento del modelo en streaming**
  `Capabilities.reasoning` existe en los tipos, pero `harness.ask()` solo devuelve
  un `AgentResponse` final: hoy es imposible pintar tokens intermedios.
  Done when: la TUI pinta el razonamiento parcial (colapsado o atenuado) mientras
  llega, y la respuesta final lo reemplaza.
  Depends on: exponer streaming en la capa de providers (`core/TODO.md` §9).

- [ ] **Mostrar la salida viva de `shell`**
  Un `shell` de 30s no muestra nada hasta terminar, que es el mismo problema que
  el razonamiento pero en la tool.
  Done when: `ToolContext.onOutput` alimenta la vista de la tool con throttle y el
  truncado sigue aplicando solo al resultado final.
  Depends on: exponer streaming en la capa de providers.

## Descartados

- **"add more info on the ui"** — sin objeto: no dice qué información ni para qué
  decisión del usuario → sustituido por las tareas concretas de `P0`, `P1` y `P3`.
- **"never make possible that user dont know if a process is running"** — es el
  criterio de aceptación de "Mostrar trabajo en curso", no una tarea aparte → fusionado.
- **"always said which is the next step"** — iba implícito en tres bullets
  distintos del punto 2 → fusionado en "Cerrar cada turno con qué pasó…".
- **"make sure the process finish successfully"** — no es accionable desde el CLI
  (depende del proveedor); lo accionable es reportar el estado, que es lo que queda.

## Preguntas abiertas

- **¿Vale la pena integrar `fzf`?** Aparcado: ahora no es interesante porque la TUI
  propia pasa a ser el camino principal. Se reabre si alguna lista supera las ~15
  entradas (modelos, agentes, historial) y se quiere delegar la selección en un
  binario externo; para cerrarla hay que decidir si `fzf` es una dependencia
  aceptable para un binario instalable o si se mantiene el `commandMenu` propio.
- **¿Qué se toma de cada referencia?** Antigravity CLI, Claude Code y opencode
  resuelven el mismo problema con layouts distintos (panel lateral, estado inline,
  modo de pantalla completa). Para cerrarla hay que listar 3–4 elementos concretos
  a imitar y descartar lo que no encaje antes de portar la pantalla base.
