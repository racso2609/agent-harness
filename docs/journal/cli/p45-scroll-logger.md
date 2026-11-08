# Journal — CLI · P4.5 — Scroll del transcript y ruido del logger

Índice: [TODO del repo](../../../TODO.md) · TODO vivo: [cli/TODO.md](../../../cli/TODO.md)
Estado: cerrado el 2026-11-03

El transcript medido en líneas visuales con la vista estable, la rueda del ratón y el arreglo del recorte, y el `logger.info`/`warn` del core silenciado salvo en `--debug`.

### Medir el transcript en líneas visuales, no en "las últimas 60 entradas"
      hecho: `ui/tui/scroll.ts` (puro: `ScrollView{offset,follow}`, `bottomView`,
      `scrollBy`, `scrollToTop/Bottom`, `clampView`, `viewWithContent`, `measureEntries`,
      `visibleWindow` con `cutTop`/`cutBottom`/`padTop`) y `ui/tui/viewport.ts`
      (`chromeRows`, `viewportRows`, `scrollActionForKey`, `nextView`). La ventana se pide
      al alto real del terminal (`useWindowSize`), el gap viaja dentro de la altura de cada
      entrada (nunca se pinta un segundo `marginTop`) y el panel recibe `padTop` para medir
      exactamente el viewport: ink recorta por abajo, que es donde está la respuesta, y ese
      recorte era una de las causas del salto. Los trucos que se quitaron: clave de React
      por índice absoluto (antes usaba la posición en la ventana, así que al desplazarse
      React reutilizaba la entrada equivocada), `overflowY="hidden"` para que una fila que
      entra o sale no empuje los paneles, y ninguna altura `flexGrow` que deje rebosar.
      hecho (teclas): `pageUp`/`pageDown` = una página (viewport − 1, para conservar una
      línea de contexto), `ctrl+u`/`ctrl+d` = media página, flechas = una línea —antes las
      swallowaba el fallback que añade texto al borrador—, `home`/`end` = extremos. En el
      approval las flechas siguen eligiendo opción y el paging sigue scrolleando.
      hecho (estabilidad): contenido nuevo no mueve la vista si el usuario está scrolleado
      (`follow: false`), cada evento se re-clampa contra el tamaño actual (resize incluido),
      y volver al fondo re-engancha `follow`; al empezar un turno la vista vuelve al fondo.
      tests: 24 en `tests/ui/scroll.spec.ts` (ventana, clamp, relleno, alturas de entradas
      colapsadas/expandidas, trim) y 18 en `tests/ui/viewport.spec.ts` (geometría, teclas,
      clamp de un offset obsoleto).
      pendiente: verificado por tests de la lógica pura y por render real de `App` (ver el
      cierre de abajo); falta la prueba en un TTY real (ver "Probar la interacción real por
      teclado" en `P5`).
      Depends on: ninguno.

### Rueda del ratón y arreglo del recorte del transcript
      Lo que el usuario reportó después: "el scroll ya no existe" y "quiero poder usar el
      mouse o el touchpad sin problema y que no se sienta tosco".
      hecho (rueda): ink 8 no reporta eventos de ratón, así que la TUI activa el modo SGR
      (`ui/tui/viewport.ts#MOUSE_ENABLE`, `1000h`+`1006h`) y lee las muescas de stdin
      espiando el `read` que ink consume —no un listener `data`, que pondría stdin en modo
      fluyente y dejaría sin datos a ink—. `wheelScrollLines` (puro) traduce
      `ESC[<64;…M`/`ESC[<65;…M` a ±`WHEEL_LINES` (3 líneas) e ignora clics y arrastres. La
      captura desactiva la selección nativa: para copiar hay que mantener `Shift`/`Option`.
      hecho (recorte): tres bugs de render medidos montando `App` en ink. (1) sin
      `flexShrink={0}` Yoga encogía las filas al desbordar la caja y dos entradas se pintaban
      en la misma fila (líneas que desaparecían); (2) `cutTop` se calculaba pero no se
      pintaba: la primera fila de la ventana se dibujaba desde su primer renglón, así que al
      entrar en una entrada alta se veía su principio y se perdía lo nuevo; ahora el `gap`
      es `gapBefore(absolute) - cutTop` (margen negativo) y el clip de la caja corta por
      arriba; (3) `height={viewportLines}` contaba el borde, así que el panel pintaba dos
      filas menos de las que el modelo de scroll creía —el fondo del historial se recortaba
      siempre—; ahora suma `BORDER_ROWS`.
      hecho (formato): padding y aire, con las medidas en un solo sitio. `PANEL_PADDING_X=2` y
      `PANEL_PADDING_Y=1` viven en `viewport.ts` y los leen tanto el render como la geometría;
      antes el borde se contaba dos veces en un sitio y cero en otro. `PANEL_CHROME` ahora es
      `BORDER_ROWS + 2*PANEL_PADDING_X` (antes 6 fijo, que dejaba 2 columnas sin usar), la
      caja del transcript usa `viewportLines + TRANSCRIPT_CHROME_Y` y su clip vive en una caja
      interna, dentro del padding, para que una fila cortada no pinte sobre el borde; la caja
      de input y la de approval también llevan `paddingY` y sus constantes (`INPUT_ROWS=5`,
      `APPROVAL_ROWS=9`) ahora cuadran con lo que se pinta.
      tests: 6 en `tests/ui/wheel.spec.ts` (muescas, lote, clics ignorados, par
      enable/disable) y 3 de render en `tests/ui/scrollRender.spec.tsx` (fondo de una entrada
      alta visible, sin solape al scrollear dentro de ella, tres líneas por muesca sin
      ensuciar el borrador).
      pendiente: en un TTY real, confirmar que la rueda llega (tmux y algunos emuladores
      interceptan el modo SGR) y elegir si la captura de ratón debería ser opcional.
      Depends on: ninguno.

### Silenciar `logger.info`/`warn` del core salvo en modo debug
      El core emitía `logger.info`/`warn` en cada tool call, loader y cambio de agente, y
      los adapters los pintaban como `notice`: se leían como si fueran conversación.
      hecho: el nivel por defecto de `core/src/utils/logger.ts` pasa de `"info"` a
      `DEFAULT_LOG_LEVEL = "error"`, así que pino no formatea ni entrega a nadie los
      `info`/`warn`. Se añaden `setLoggerLevel`/`getLoggerLevel` y `createLogger(sink,
{level})` (retrocompatible), exportados desde `core/src/index.ts`. `cli/src/flags.ts`
      extrae `parseFlags(argv)` (`--tui`, `--debug`/`-v`) y `main.ts` fija el nivel `debug`
      **antes** de construir `MainLoop`: `env.ts` se evalúa en import-time, así que tocar
      `process.env` después del arranque no habría tenido efecto. En `--tui` el sink del
      adapter descarta: un log nunca puede pintarse dentro del transcript.
      tests: 6 en `core/tests/utils/logger.spec.ts` (nivel por defecto, `debug` por env y
      por setter, `silent`, contrato de orden) y 4 en `cli/tests/flags.spec.ts`.
      pendiente: decidir si en `--debug --tui` los logs deberían ir a un archivo en vez de
      descartarse; hoy el modo debug es útil en modo líneas.
      Depends on: ninguno.
