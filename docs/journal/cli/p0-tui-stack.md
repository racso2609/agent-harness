# Journal — CLI · P0 — TUI de pantalla completa

Índice: [TODO del repo](../../../TODO.md) · TODO vivo: [cli/TODO.md](../../../cli/TODO.md)
Estado: cerrado el 2026-11-01

Stack de rendering (ink 8 + React 19), la UI detrás de `UiAdapter`, la pantalla base con approval y el layout de la franja de progreso.

### Elegir el stack de rendering y su costo de dependencias
      decisión: **ink 8 + React 19** (`jsx: react-jsx`, sin `import React`). Coste real medido al instalarlo: `+26` paquetes en producción. Alternativa descartada: renderer propio sobre ANSI + `readline` — cero dependencias, pero obliga a reimplementar layout, scroll y repintado, que es justo donde `terminal/stdin.ts` ya acumula deuda.
      por qué encaja: ink da paneles, `useInput` y re-render incremental, y `MainLoop` ya no escribe a stdout directamente, así que los dos renderers conviven.

### Extraer la UI detrás de una interfaz de paneles
      hecho: `src/ui/UiAdapter.ts` define `UiEvent` (status, notice, text, reasoning, toolStart/Output/End, turnStart/End, spawn, spawnSettled, reset) y `UiAdapter` (`render`, `promptApproval`, `renderImage`, `close`). `MainLoop` solo habla esa interfaz; `renderEvents.ts#toUiEvents` traduce `ChatEvent` del core a la misma. Ningún módulo del loop escribe a stdout.

### Portar la pantalla base (historial + input + status bar)
      hecho: `ui/tui/App.tsx` (dos paneles + caja de input con `useInput` + status bar + franja de hijos) y `ui/TuiUiAdapter.tsx`, que monta ink y re-renderiza por evento. Arranca con `--tui`; el modo líneas sigue siendo el default (`CliUiAdapter` implementa la misma interfaz).
      hecho (approval): `TuiUiAdapter.promptApproval` muestra la petición como pregunta seleccionable dentro del panel (`approval` en el estado) y resuelve la promesa al pulsar `y` (allow), `a` (always), `n`/`esc` (deny) o `←/→` + enter. El core ya aceptaba una promesa (`approvalHandler`), así que no hizo falta tocarlo; `always` sigue cacheándose en `SessionManager`. Una segunda petición mientras hay una en pantalla se **deniega** en vez de encolarse, para que el usuario siempre sepa qué está contestando. `close()` resuelve como `deny` cualquier approval abierta antes de desmontar.
      pendiente (approval): no hay test de interacción real (los tests fijan el estado que recibe `App`, no las teclas). Probar a mano: `/spawn` o una tool `shell` en `--tui` debe abrir la pregunta y bloquear el turno hasta responder.
      riesgo conocido: si `config.needsSetup()` es verdadero, `startSetup` corre **antes** de montar ink y compite por stdin con el renderer. Hoy no se dispara con una config existente, pero hay que decidir si el setup se pide en modo líneas aun con `--tui`, o se porta a la TUI.

### Definir el layout de progreso (franja de hijos + actividad)
      decisión: **una sola franja inferior, dinámica y colapsable**. Reglas: (1) si no corre nada, la franja no existe — cero líneas gastadas; (2) el turno en curso se indica con `activity` dentro del input box (`working`, `thinking`), no en la franja; (3) cada hijo ocupa una línea entre la conversación y el input, con icono, agente, id y tiempo; (4) un hijo terminado permanece 5 s marcado `done`/`error` y desaparece, para que un hijo rápido sea perceptible.
      por qué no panel lateral: parte el ancho y con 80 columnas deja el texto en ~50, que es justo lo que rompe la legibilidad del historial (Claude Code lo usa porque asume pantalla ancha). Por qué no inline: el estado se pierde al hacer scroll y obliga a reescribir líneas ya pintadas, la misma deuda que `terminal/stdin.ts` arrastra.
      hecho: `ui/tui/progress.ts` concentra la lógica pura (visibilidad con ventana de 5 s, tiempo transcurrido que congela al terminar, icono y color por estado) y `App.tsx` la consume; `TuiUiAdapter` pasa `startedAt`/`finishedAt` desde el `SpawnHandle` del core. 8 tests en `tests/ui/progress.spec.ts`.
      pendiente: la `activity` del input solo se alimenta de `reasoning`/`turnStart`; cuando `P1` conecte `onSpawnEvent` conviene mostrar también el nombre de la tool en curso (`working · shell`).
