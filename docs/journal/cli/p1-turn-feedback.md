# Journal — CLI · P1 — Feedback mientras el turno corre

Índice: [TODO del repo](../../../TODO.md) · TODO vivo: [cli/TODO.md](../../../cli/TODO.md)
Estado: cerrado el 2026-11-01

Los eventos de spawn en la UI, el trabajo en curso dentro del input, el estado por subagente y los hijos restaurados al reanudar.

### Consumir los eventos de spawn en la UI
      hecho: `MainLoop` se suscribe con `harness.onSpawnEvent()` al inicializar y traduce cada evento a `spawn`/`spawnSettled`; el adapter del TUI actualiza la franja y el de líneas imprime una línea por arranque y por cierre (con el error del hijo si falló).

### Mostrar trabajo en curso
      hecho: `activity` dentro del input box. `turnStart` → `working`, `reasoning` → `thinking`, `toolStart` → `working · <tool>`, `toolEnd` → `working`, `turnEnd` → reposo. El status bar sigue mostrando provider/modelo/agente/tokens.
      nota: el caso `working` usa texto plano, no spinner animado; un spinner necesita un tick que repinte aunque no lleguen eventos. Se deja para cuando haga falta (un `shell` largo ya muestra salida viva, que es mejor señal).

### Mostrar estado por subagente
      hecho: cada hijo aparece con `agentId`, `spawnId`, tiempo transcurrido e icono (`◐` corriendo, `✓` done, `✗` error), y se marca al hacer `settled`; desaparece 5 s después (`progress.ts`).

### Pintar los hijos restaurados al reanudar una sesión
      El core ya persistía el histórico (`SessionRecord.spawns`, `SESSION_VERSION` 4) pero
      `listSpawns()` solo devuelve los del proceso actual, así que tras `/resume` la franja
      arrancaba vacía y el usuario perdía el rastro de qué hijos corrieron.
      hecho (core): `IHarness.childHistory()` devuelve el transcript persistido en orden de
      lanzamiento y como copia, y convive con `listSpawns()`: la vista viva sigue siendo la
      de este proceso, porque un hijo restaurado no se puede `poll`/`wait`/`cancel` y no debe
      parecer que sí.
      hecho (cli): `spawnHistory` en `UiEvent`, emitido por `MainLoop#showChildHistory` tras
      `initialize()` y tras cualquier comando que cambie de sesión (compara
      `status().sessionId` antes/después; solo el core sabe si hubo carga real).
      `progress.ts` gana `toSpawnEntry` y `spawnStrip`: los vivos primero, luego hasta
      `RESTORED_LIMIT` (5) restaurados y un `+N older from previous runs` para el resto, sin
      duplicar un hijo vivo que siga en el histórico. Las filas restauradas van atenuadas y no
      tickean; un hijo que seguía `running` al cerrar la sesión se lee `interrupted` en vez de
      fingir que corre. En modo líneas se imprime una línea de resumen.
      tests: 8 en `progress.spec.ts` (mapeo, reloj congelado, `interrupted`, orden, no
      duplicado, tope, ventana de linger) y 2 de `showChildHistory` (`spawnHistory` con hijos,
      silencio sin hijos). El resto del cableado va como guardas de fuente: `MainLoop` corre un
      bucle de stdin y no se puede montar en un test.
      pendiente: verificado por tests; falta verlo en una sesión real con hijos.
      Depends on: persistencia de handles (`core/TODO.md` §9.1.4, ya hecho).
