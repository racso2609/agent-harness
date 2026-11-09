# Journal — CLI · P2 — Contrato de retorno de los subagentes

Índice: [TODO del repo](../../../TODO.md) · TODO vivo: [cli/TODO.md](../../../cli/TODO.md)
Estado: cerrado el 2026-11-01

Contrato de resultado de spawn verificado en todos los agentes, aviso del estado final de cada hijo y cierre del turno con qué pasó y qué sigue.

### Verificar el contrato de resultado de spawn en todos los agentes
      `formatSpawnResult` cubría error y texto vacío, pero ningún test lo fijaba… y el bug
      estaba ahí: usaba `?? `, así que un hijo con `result: ""` inyectaba en el padre una
      cabecera sin cuerpo. `outcomeText` trata `undefined`, `""` y espacios como "sin salida".
      hecho (tests, core): 6 casos en `SessionManager.spec.ts` — `done` con texto (mensaje
      exacto), `done` sin texto (`(no output)`), `error` con y sin mensaje (`unknown error`),
      truncado por `childResultMaxChars`, y dos que fijan el shape del handle. El del texto
      vacío se verificó revirtiendo la corrección: falla sin ella.
      hecho (docs): `default`, `coder` y `senior-architect` tienen una sección "When the parent
      spawned you" (o "When you spawned a child"): el mensaje final es la respuesta al padre, el
      history no cruza la frontera, y una respuesta vacía llega como `(no output)`.
      Depends on: nada.

### Notificar al usuario el estado final de cada hijo
      Hoy el resultado del hijo llega al padre como mensaje `system` en el turno
      siguiente; el usuario en pantalla no ve nada en el momento en que termina.
      hecho: `ui/outcome.ts` concentra los dos textos; `formatSpawnOutcome` compone
      `spawn <id> <status> (<agent>): <desenlace>` y `oneLine` colapsa saltos de línea y corta a
      200 con `…`; `(no output)` y `unknown error` para vacíos.
      hecho (renderers): lo usan los dos; `notify` en modo líneas y
      `pushLine({ role: "notice" })` en la TUI.
      hecho (anclaje): `ui/tui/entries.ts` ancla la entrada abierta por rol, así que el aviso del
      hijo que cae a mitad de la respuesta (o de la salida de una tool) no la parte en dos.
      tests: 15 en `outcome.spec.ts` (los helpers puros), 2 en `transcript.spec.ts` y 3 en
      `cliAdapter.spec.ts` para el aviso de cierre del hijo en cada renderer, 3 más en
      `transcript.spec.ts` para el aviso que cae a mitad de la respuesta, y 4 en
      `transcript.spec.ts` que fijan el anclaje de `tool`: la salida de un comando se concatena
      en una sola entrada aunque caiga un aviso (o un `spawnSettled`) en medio, y dos comandos
      seguidos abren una entrada cada uno con sus chunks en orden.
      Depends on: consumir los eventos de spawn.

### Cerrar cada turno con qué pasó, qué falta y qué sigue
      Un turno que termina sin resumen obliga al usuario a inferir el estado.
      hecho: `formatTurnOutcome` devuelve `turn failed` / `turn incomplete` con `pending:` y
      `next:`; un turno `completed` no pinta nada.
      hecho (renderers): lo usan los dos; `notify` en modo líneas y
      `pushLine({ role: "notice" })` en la TUI.
      tests: 6 en `outcome.spec.ts` (los tres estados, el `next` opcional y los tres silencios),
      2 en `transcript.spec.ts` y 3 en `cliAdapter.spec.ts` para el cierre en cada renderer,
      incluido el silencio de un turno `completed` y el de un `turnEnd` sin `outcome`.
      Depends on: notificar al usuario el estado final de cada hijo.
