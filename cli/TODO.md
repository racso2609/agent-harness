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
pendiente del prototipo: scroll real del historial (hoy muestra las últimas 40 líneas), menú de comandos `/` dentro del input, y approval interactivo — `promptApproval` **deniega** las operaciones con efectos secundarios porque ink es dueño de stdin; hay que resolverlo antes de usar `--tui` como modo diario.

- [ ] **Definir el layout de progreso (franja de hijos + actividad)**
  Antigravity, Claude Code y opencode reservan espacio fijo para "qué está
  corriendo"; decidirlo después de construir las tareas de `P1` fuerza a rehacerlas.
  Done when: está escrito dónde vive el estado de subagentes (franja inferior,
  panel lateral o inline) y qué se ve cuando no hay nada corriendo.
  Depends on: portar la pantalla base.

## P1 — Feedback mientras el turno corre

- [ ] **Consumir los eventos de spawn en la UI**
  `SpawnManager.on()` no tiene ningún suscriptor fuera de `SessionManager`, así que
  un hijo que arranca o termina es invisible para el usuario.
  Done when: `MainLoop` recibe `started`/`settled` y la UI actualiza la franja de hijos.
  Depends on: persistir eventos de spawn (`core/TODO.md` §9).

- [ ] **Mostrar trabajo en curso**
  Sin indicador, un turno largo es indistinguible de un CLI colgado.
  Done when: mientras el turno está en vuelo la status bar muestra actividad
  (spinner + tool en ejecución) y vuelve a reposo al terminar.
  Depends on: portar la pantalla base.

- [ ] **Mostrar estado por subagente**
  El usuario debe poder ver qué agentes están corriendo, desde cuándo y con qué
  estado, sin adivinar por logs.
  Done when: cada spawn activo aparece con `agentId`, `status` y tiempo
  transcurrido, y desaparece (o se marca `done`/`error`) al hacer `settled`.
  Depends on: consumir los eventos de spawn; definir el layout de progreso.

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
