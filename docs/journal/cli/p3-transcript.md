# Journal — CLI · P3 — Información adicional en el UI

Índice: [TODO del repo](../../../TODO.md) · TODO vivo: [cli/TODO.md](../../../cli/TODO.md)
Estado: cerrado el 2026-11-01

Razonamiento en streaming, salida viva de `shell`, formateo incremental del stream, colapso de razonamiento y tools, y aire vertical en el texto final.

### Mostrar el razonamiento del modelo en streaming
      hecho: el razonamiento ya llegaba por `ChatEvent` pero el adapter lo **descartaba** (solo ponía `activity: thinking`). Ahora se acumula en su propia entrada `reasoning`, en dim y con glifo `~ `.
      hecho (config): `core` gana `ui.theme` (`user`, `reasoning`, `tool`, `answer`, `notice`; cada rol con `color`, `dim`, `bold`) con defaults aplicados en `applyDefaults`. **Solo config, sin env**, por decisión explícita. `ui/tui/theme.ts#resolveTheme` fusiona rol por rol sobre los defaults.

### Mostrar la salida viva de `shell`
      hecho: `toolOutput` se acumula en la entrada `tool` (amarilla), y `toolStart` marca `working · <tool>` en el input.

### Formatear el texto del stream en lugar de concatenar caracteres
      problema: `appendToLast` concatenaba deltas en una línea, así que el markdown del modelo (`**`, `#`, fences) se veía literal mientras llegaba y solo se formateaba al final. Además **el texto final se descartaba en TUI**: `MainLoop` hacía `if (!this.isTui() && text)`, así que si el proveedor no mandaba deltas la respuesta no aparecía.
      solución: `ui/tui/markdown.ts#MarkdownStream` acumula el stream y separa **bloques cerrados** (párrafo, heading, lista, quote, regla, código con lenguaje) de la **cola abierta**. Los cerrados se pintan con su estilo final; la cola se muestra plana. Nada parpadea y el último bloque se estiliza en cuanto se cierra.
      hecho: `MainLoop` emite `answer` con el texto final autoritativo (`{ type: "answer", text }`), que reemplaza lo acumulado en TUI e imprime una línea en modo líneas. `App.tsx` renderiza por rol con glifo (`› ` usuario, `~ ` razonamiento, `⏵ ` tool, `· ` aviso, sin glifo la respuesta), así que se distinguen sin depender del color.
      bugs que encontraron los tests: (1) la última línea de un bloque abierto desaparecía si no acababa en `\n` — el caso normal de un stream real; (2) un fence sin cerrar nunca se convertía en bloque de código al terminar. Ambos corregidos y cubiertos en `tests/ui/markdown.spec.ts` (16 tests).

### Colapsar razonamiento y tool calls
      problema: razonamiento y salida de tools competían por el espacio con la respuesta; con un `shell` charlatán o un thinking largo el mensaje útil desaparecía de la pantalla.
      decisión: **mientras el turno corre** se ven solo las últimas `PREVIEW_LINES` (6) líneas de cada entrada, con un `…` que indica que hay más — así hay señal de vida sin inundar. **Al terminar el turno** la entrada se colapsa a su cabecera (`412 car.` / `8 líneas`). **Expandida** se ve completa. Una tool que **falló nunca se oculta**: un error no debería necesitar una tecla para verse.
      atajos: `ctrl+r` razonamiento, `ctrl+t` tools (globales, `onToggleAll`: si algo está colapsado abre todo, si no cierra todo), y `enter` con el input vacío alterna la última entrada colapsable visible. `enter` con texto sigue enviando el prompt.
      hecho: `ui/tui/collapse.ts` (puro: `estimateLines`, `tail`, `collapse`), 11 tests en `tests/ui/collapse.spec.ts`. `App.tsx` aplica la ventana a `reasoning` y `tool`; `TuiUiAdapter` guarda el set `expanded` por índice y lo **resetea al empezar cada turno**, para que el transcript no se llene de entradas abiertas de turnos anteriores.
      pendiente: el corte se calcula con `width: Infinity` (una línea lógica = una visual). Con líneas muy largas la ventana de 6 mostrará menos de lo esperado; pasa a `useStdout().stdout.columns` cuando importe.

### Dar aire vertical al texto final (interlineado y separación de bloques)
      Hoy las entradas y los bloques del markdown se pintan pegados uno detrás de otro
      (`App.tsx` no añade margen entre `<Line>` ni entre bloques, y el modo líneas no
      deja aire antes ni después de la respuesta), así que párrafos, listas y respuestas
      se leen como un muro de texto.
      decisión: el interlineado es una **constante del layout**, no un valor de
      `ui.theme`, porque el espaciado no depende del color ni del rol y en modo líneas no
      hay tema que leer.
      hecho: `src/ui/tui/layout.ts` gana `GAP = 1` y `gapBefore(absoluteIndex)` puro (0 en
      el índice 0, `GAP` en cualquier otro); `src/ui/tui/entries.ts` gana `WindowEntry` /
      `EntryWindow` y `windowOf`, que resuelve el índice absoluto y el aire de cada entrada
      (`gapBefore(absolute)`); `src/ui/tui/App.tsx` extrae `VISIBLE = 60`, pide la ventana a
      `windowOf(state.lines, VISIBLE)` y solo consume lo que llega (`{ line, absolute, gap }`),
      sin recalcular índices — la `key` del map sigue siendo el índice relativo a la ventana;
      `src/ui/CliUiAdapter.ts` mantiene la bandera `turnPrinted` (se resetea en `turnStart`, se
      pone a true en `notify` y en `writeChunk`) y el caso `answer` imprime `\n${text}\n` solo
      si ya hubo salida en el turno.
      tests: `tests/ui/layout.spec.ts` 12→15 (bloque `describe("gapBefore")`: índice 0 →
      0, cualquier otro → `GAP`) y `tests/ui/cliAdapter.spec.ts` 7→9 (respuesta no
      primera → `"\n<texto>\n"`, primera → sin aire inicial), manteniendo los 7 previos
      con `toBe` de literal completo.
      bug cazado en render de ink, no en los tests puros: el primer intento pasaba a
      `gapBefore` el índice de la ventana (`slice(-60)`), así que en un transcript de más de 60
      entradas la primera visible perdía su aire; el test que lo fija es
      `tests/ui/tuiWindow.spec.ts`, que afirma sobre las entradas **ya resueltas**
      (`entries[0]` de un transcript de 62 → `{ line: "L2", absolute: 2, gap: GAP }`), y un test
      anterior que llamaba `gapBefore(window.start)` a mano era tautológico y se sustituyó. La
      suite queda en 15 ficheros / 185 tests.
corrección (posterior a `P4.5`): el párrafo de arriba cita `App.tsx` con `VISIBLE = 60` y
`windowOf(state.lines, VISIBLE)`, y eso **ya no existe**: `grep -n VISIBLE
cli/src/ui/tui/App.tsx` solo devuelve `MENU_VISIBLE_ROWS`, y `App.tsx:516` pide la ventana
a `visibleWindow({ heights, viewportLines, view })` de `cli/src/ui/tui/scroll.ts`, porque
`P4.5` mide en líneas visuales y no en número de entradas. Sigue vigente lo que importa:
la regla de espaciado (`GAP = 1` y `gapBefore` en `cli/src/ui/tui/layout.ts:105` y `:113`,
con `windowOf` en `cli/src/ui/tui/entries.ts:93`) y el aire de la respuesta en modo líneas
(`turnPrinted` en `cli/src/ui/CliUiAdapter.ts:78`, `:85`, `:93`, `:133`, `:137`).
tests: 15 casos en `cli/tests/ui/layout.spec.ts` (`grep -c 'it('`) y 5 en
`cli/tests/ui/tuiWindow.spec.ts` para `windowOf`, incluido el transcript desplazado que
afirma `{ line: "L2", absolute: 2, gap: GAP }`; `cli/tests/ui/cliAdapter.spec.ts` cubre el
aire de la respuesta en modo líneas.
      Done when: existe una regla de espaciado declarada (línea en blanco entre entradas,
      margen antes de heading/lista/código/tabla y aire antes/después de la respuesta
      final en modo líneas) y un test la fija.
      Depends on: nada.
