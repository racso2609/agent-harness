# Journal — CLI · P5 — Tests del renderer de líneas

Índice: [TODO del repo](../../../TODO.md) · TODO vivo: [cli/TODO.md](../../../cli/TODO.md)
Estado: cerrado el 2026-11-04

Las aserciones tautológicas de `cliAdapter.spec.ts` sustituidas por literales exactos, con el barrido de revert que fija qué caso caza cada mutación.

### Los tests del renderer de líneas fijaban el texto con aserciones tautológicas
      `cli/tests/ui/cliAdapter.spec.ts` afirmaba `expect(output).toContain(
formatSpawnOutcome(handle))`, es decir, comparaba la salida del adaptador contra la
      **misma** función que el adaptador usa por dentro (`CliUiAdapter.ts:96`,
      `TuiUiAdapter.tsx:259`). El test fijaba que el renderer delega en el formateador, no lo
      que el usuario lee: cambiando el separador de `": "` a `" =>> "` en
      `cli/src/ui/outcome.ts:34,38`, `cliAdapter.spec.ts` seguía en verde y solo lo cazaba
      `outcome.spec.ts`. Es el patrón "aserción debilitada / tautológica" de la regla 7 de
      `core/agents/code-reviewer.md`.
      hecho: el test ya no importa `formatSpawnOutcome` ni `formatTurnOutcome`: los siete casos
      comparan la salida completa contra el literal exacto con `toBe`, incluido el `\n` final —
      hijo `done` (`spawn spawn-1 done (coder): all tests pass\n`), hijo `error`,
      `(no output)`, turno `failed` y los dos silencios. Se añadió el caso «says unknown error
      instead of a header with an empty body», que fija
      `spawn spawn-1 error (coder): unknown error\n` y cierra el hueco del error sin mensaje.
      revert: el barrido de revert se hizo y está en verde como prueba, con las cifras medidas una a
      una sobre los **M = 12 casos** del fichero en el momento de medir. Cambiar el separador `": "`
      por `" =>> "` en `outcome.ts:34,38` —las dos líneas que componen la cabecera— deja el fichero
      en **4 failed / 12 casos (medido con M = 12)** (los cuatro casos de `settling a child`);
      `"unknown error"` → `"unknown"` deja **1 failed / 12 casos (medido con M = 12)** (el caso del
      error vacío); `"(no output)"` → `"(empty)"` deja **1 failed / 12 casos (medido con M = 12)**;
      `"turn failed"` → `"turn error"` deja **1 failed / 12 casos (medido con M = 12)**; y `notify`
      emitiendo `\n\n` en `CliUiAdapter.ts` deja **10 failed / 12 casos (medido con M = 12)**. Todos
      los reverts se restauraron. Regla: M es solo el tamaño del fichero en el momento de medir, así
      que cada vez que se añada o se quite un caso hay que volver a medir y actualizar M; lo que **no
      caduca** es cuál es el caso con nombre que caza cada mutación, y eso es lo que hay que mantener
      correcto. La aserción ya no es tautológica: cada mutación tiene un caso con nombre que la caza
      porque cada caso compara la salida completa contra su literal, así que cualquier carácter
      distinto rompe el `toBe` del caso que imprime esa cadena —el separador lo cazan los cuatro de
      `settling a child`, que son los únicos que fijan una cabecera con cuerpo; el `"unknown error"`
      lo caza el caso del error vacío, y `"(no output)"` y `"turn failed"` tienen un caso cada uno
      porque son los únicos que los imprimen; y el `\n\n` de más lo cazan diez—. Un matiz que
      conviene dejar escrito: los dos casos de silencio («says nothing when…») siguen verdes con el
      `\n\n` porque imprimen cadena vacía y no hay salto de más que ver. Con eso el test fija lo que
      el usuario lee y no que el renderer delegue.
      turnPrinted: los tres sitios donde se pone la bandera en `cli/src/ui/CliUiAdapter.ts` (dentro
      de `notify`, dentro de `writeChunk` y el reset a `false` en `case "turnStart"`) están ahora
      discriminados uno a uno. Un matiz sobre lo que estaba realmente sin cubrir: el camino de
      `notify` **ya tenía cobertura indirecta** en el commit anterior (`eae796b`, 9 casos) a través
      del caso «puts a blank line before and after an answer that follows output», que imprime por
      la vía de `toolStart` y por tanto pasa por `notify` —borrar la asignación de `notify()` allí
      dejaba **1 failed / 9**—; lo que estaba sin cubrir era la asignación de `writeChunk()`
      (borrarla dejaba `9 passed`) y el reset de `turnStart`. Con los 12 casos de hoy, borrar
      `this.turnPrinted = true;` de `notify()` deja **2 failed / 12 casos (medido con M = 12)**
      («puts a blank line before an answer that follows a notice» y el preexistente «puts a blank
      line before and after an answer that follows output»), borrar la asignación de `writeChunk()`
      deja **1 failed / 12 casos (medido con M = 12)** («puts a blank line before an answer that
      follows streamed text») y quitar `this.turnPrinted = false;` de `case "turnStart"` deja
      **1 failed / 12 casos (medido con M = 12)** («does not inherit the previous turn when a new
      turn starts»). Los tres casos nuevos los fijan de forma explícita, en particular el de
      `notify`, que antes solo caía de rebote según qué evento usara el caso.
      Done when: `cliAdapter.spec.ts` no importa `formatSpawnOutcome` ni `formatTurnOutcome`,
      sus casos comparan con `toBe` el literal completo y el barrido de revert del separador
      deja el fichero en rojo.
      Depends on: nada.
