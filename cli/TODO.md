# TODO — CLI (racso-harness)

## Contexto

Dos renderers sobre un mismo contrato (`UiAdapter`/`UiEvent`), decidido en `P0`:
`CliUiAdapter` (líneas, **default**) y `TuiUiAdapter` (ink, `--tui`). `MainLoop` no
escribe a stdout: solo emite eventos, así que la lógica del turno es idéntica en ambos.

Hecho hasta hoy: `P0`, `P1`, `P2`, `P3` y `P4.5` cerrados y el core (§9.1) completo.
Quedan la publicación (`P4`, fase F0 de `docs/ARCHITECTURE.md`), la deuda del TUI (`P5`)
y la continuación automática (`P6`).

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

- [x] **Pintar los hijos restaurados al reanudar una sesión**
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

## P2 — Contrato de retorno de los subagentes

- [x] **Verificar el contrato de resultado de spawn en todos los agentes**
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

- [x] **Notificar al usuario el estado final de cada hijo**
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

- [x] **Cerrar cada turno con qué pasó, qué falta y qué sigue**
      Un turno que termina sin resumen obliga al usuario a inferir el estado.
      hecho: `formatTurnOutcome` devuelve `turn failed` / `turn incomplete` con `pending:` y
      `next:`; un turno `completed` no pinta nada.
      hecho (renderers): lo usan los dos; `notify` en modo líneas y
      `pushLine({ role: "notice" })` en la TUI.
      tests: 6 en `outcome.spec.ts` (los tres estados, el `next` opcional y los tres silencios),
      2 en `transcript.spec.ts` y 3 en `cliAdapter.spec.ts` para el cierre en cada renderer,
      incluido el silencio de un turno `completed` y el de un `turnEnd` sin `outcome`.
      Depends on: notificar al usuario el estado final de cada hijo.

- [ ] **El aviso de cierre no muestra el informe del hijo**
      El canal ya existe (`MainLoop.ts:78-84` traduce `settled` del core a
      `spawnSettled` y los dos renderers lo pintan), pero el formato degrada el informe
      de tres formas: `oneLine()` colapsa todo salto de línea a un espacio y
      `MAX_OUTCOME_CHARS = 200` corta con `…`, así que un informe de 30 líneas se lee
      como 200 caracteres sin estructura y el lector no distingue qué falta ni qué sigue;
      no se pinta la duración aunque `startedAt` y `finishedAt` están en el handle; y si
      el resultado superó `sessions.childResultMaxChars` (2000 por defecto,
      `SessionManager.ts:603`) el padre recibe un informe ya truncado sin que nadie lo
      diga.
      Done when: (1) el cierre respeta hasta N líneas en vez de 200 caracteres, conserva
      la estructura del informe y marca la elisión con `…`; (2) el cierre pinta la
      duración (`(+2m 14s)`) desde `startedAt`/`finishedAt`, o desde `durationMs` cuando
      exista; (3) un resultado que llegó truncado por `childResultMaxChars` se anuncia
      como tal en vez de aparentar que eso es todo.
      Depends on: el cierre del hijo en los dos renderers («Notificar al usuario el
      estado final de cada hijo») y, para la duración desde el contrato, la tarea de
      `core/TODO.md` «Añadir resumen del hijo y duración a SpawnHandle».
      Decidir antes: si el tope de N líneas es una constante del layout (como `GAP`) o un
      valor de config.

## P3 — Información adicional en el UI

- [x] **Mostrar el razonamiento del modelo en streaming**
      hecho: el razonamiento ya llegaba por `ChatEvent` pero el adapter lo **descartaba** (solo ponía `activity: thinking`). Ahora se acumula en su propia entrada `reasoning`, en dim y con glifo `~ `.
      hecho (config): `core` gana `ui.theme` (`user`, `reasoning`, `tool`, `answer`, `notice`; cada rol con `color`, `dim`, `bold`) con defaults aplicados en `applyDefaults`. **Solo config, sin env**, por decisión explícita. `ui/tui/theme.ts#resolveTheme` fusiona rol por rol sobre los defaults.

- [x] **Mostrar la salida viva de `shell`**
      hecho: `toolOutput` se acumula en la entrada `tool` (amarilla), y `toolStart` marca `working · <tool>` en el input.

- [x] **Formatear el texto del stream en lugar de concatenar caracteres** — DECIDIDO: bloques incrementales
      problema: `appendToLast` concatenaba deltas en una línea, así que el markdown del modelo (`**`, `#`, fences) se veía literal mientras llegaba y solo se formateaba al final. Además **el texto final se descartaba en TUI**: `MainLoop` hacía `if (!this.isTui() && text)`, así que si el proveedor no mandaba deltas la respuesta no aparecía.
      solución: `ui/tui/markdown.ts#MarkdownStream` acumula el stream y separa **bloques cerrados** (párrafo, heading, lista, quote, regla, código con lenguaje) de la **cola abierta**. Los cerrados se pintan con su estilo final; la cola se muestra plana. Nada parpadea y el último bloque se estiliza en cuanto se cierra.
      hecho: `MainLoop` emite `answer` con el texto final autoritativo (`{ type: "answer", text }`), que reemplaza lo acumulado en TUI e imprime una línea en modo líneas. `App.tsx` renderiza por rol con glifo (`› ` usuario, `~ ` razonamiento, `⏵ ` tool, `· ` aviso, sin glifo la respuesta), así que se distinguen sin depender del color.
      bugs que encontraron los tests: (1) la última línea de un bloque abierto desaparecía si no acababa en `\n` — el caso normal de un stream real; (2) un fence sin cerrar nunca se convertía en bloque de código al terminar. Ambos corregidos y cubiertos en `tests/ui/markdown.spec.ts` (16 tests).

- [x] **Colapsar razonamiento y tool calls** — DECIDIDO: ventana deslizante + expandir
      problema: razonamiento y salida de tools competían por el espacio con la respuesta; con un `shell` charlatán o un thinking largo el mensaje útil desaparecía de la pantalla.
      decisión: **mientras el turno corre** se ven solo las últimas `PREVIEW_LINES` (6) líneas de cada entrada, con un `…` que indica que hay más — así hay señal de vida sin inundar. **Al terminar el turno** la entrada se colapsa a su cabecera (`412 car.` / `8 líneas`). **Expandida** se ve completa. Una tool que **falló nunca se oculta**: un error no debería necesitar una tecla para verse.
      atajos: `ctrl+r` razonamiento, `ctrl+t` tools (globales, `onToggleAll`: si algo está colapsado abre todo, si no cierra todo), y `enter` con el input vacío alterna la última entrada colapsable visible. `enter` con texto sigue enviando el prompt.
      hecho: `ui/tui/collapse.ts` (puro: `estimateLines`, `tail`, `collapse`), 11 tests en `tests/ui/collapse.spec.ts`. `App.tsx` aplica la ventana a `reasoning` y `tool`; `TuiUiAdapter` guarda el set `expanded` por índice y lo **resetea al empezar cada turno**, para que el transcript no se llene de entradas abiertas de turnos anteriores.
      pendiente: el corte se calcula con `width: Infinity` (una línea lógica = una visual). Con líneas muy largas la ventana de 6 mostrará menos de lo esperado; pasa a `useStdout().stdout.columns` cuando importe.

- [x] **Dar aire vertical al texto final (interlineado y separación de bloques)**
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
      Done when: existe una regla de espaciado declarada (línea en blanco entre entradas,
      margen antes de heading/lista/código/tabla y aire antes/después de la respuesta
      final en modo líneas) y un test la fija.
      Depends on: nada.

## P4 — F0: empaquetado y publicación

Contexto: es la fase **F0** de `docs/ARCHITECTURE.md` y su plan completo vive en
`docs/INSTALL.md` (decisiones de empaquetado, cambios por fichero, orden de
publicación, tabla de roturas y notas de verificación): aquí solo van las tareas,
no el contenido del plan. Hoy los dos paquetes se usan sólo desde el workspace
(`@racso/cli` depende de `@racso/core` con `workspace:*`) y `cli/package.json`
declara `private: true`, así que `@racso/cli` no se publica. Destino: **GitHub
Packages con scope `@racso2609`** (la org `racso` no existe —`gh api orgs/racso` →
404— y el dueño del repo es `racso2609`) **más los `.tgz` en GitHub Releases**
como canal sin token; ya no es npm público `@racso`. F0 cierra cuando
`pnpm -r build && pnpm -r lint && pnpm -r test` está en verde y un consumidor
externo importa el core desde el registro, no desde el workspace.

- [ ] **Renombrar el scope a `@racso2609` en los dos `package.json`**
      GitHub Packages exige que el scope coincida con el dueño del paquete, y el dueño
      del repo es `racso2609`, no la inexistente org `racso`.
      Done when: `grep '"name"' core/package.json cli/package.json` devuelve
      `@racso2609/core` y `@racso2609/cli`, y no queda ningún `"name": "@racso/`.
      Depends on: nada.

- [ ] **Renombrar los imports de `@racso/core` a `@racso2609/core` en el cli**
Es **requisito** del rename de scope, no una opción: `grep -rln "@racso/core"
cli/src cli/tests cli/bin` devuelve 22 ficheros y `tsc && tsc-alias -f` no
reescribe imports de paquetes (sólo los alias `@/*`), así que hoy `cli/dist/main.js`
sigue emitiendo `import { setLoggerLevel } from "@racso/core"`. Con el paquete
llamado `@racso2609/core`, un `dist` sin renombrar importa un paquete que no existe
y el canal de Releases queda roto; hasta recompilar, el `dist` no es válido.
Done when: `grep -rn "@racso/core" cli/src cli/tests cli/bin` no devuelve nada y,
tras `pnpm --filter @racso2609/cli build`, `grep -c "@racso2609/core"
cli/dist/main.js` devuelve `1` o más.
Depends on: renombrar el scope a `@racso2609` en los dos `package.json`.

- [ ] **Añadir `files` explícito a los dos paquetes**
      Sin `files` el tarball del core mete 205 ficheros / 182 KB y el del cli 123 / 207 KB
      (`src/`, `tests/`, `TODO.md`, configs y los `.map` innecesarios).
      Done when: `core/package.json` declara `files: ["dist", "agents", "skills"]` y
      `cli/package.json` declara `files: ["dist", "bin", "racso-logo.txt"]`, con el logro
      verificado en la tarea de auditar los tarballs.
      Depends on: nada.

- [ ] **Quitar `private: true` del cli y pasar la dependencia del core a `workspace:^`**
      Con `private: true` `pnpm publish` aborta con `[EPRIVATE]`, y con `workspace:*` el
      tarball fija la versión exacta del core y obliga a republicar el cli en cada bump.
Done when: (a) `grep -c '"private"' cli/package.json` devuelve `0`; (b) el
`package.json` del tarball (`pnpm pack` y extraer) no contiene `"private"`; (c) ese
mismo `package.json` deja `"@racso2609/core": "^1.0.0"` y ningún `workspace:`.
      Depends on: renombrar el scope a `@racso2609` en los dos `package.json`.

- [ ] **Añadir `engines.node` a los dos paquetes**
      Sin `engines` nada impide instalar en un Node que no soporta las dependencias, y el
      fallo aparece en runtime en vez de en la instalación.
      Done when: `core/package.json` declara `engines.node: ">=20.11"` (por
      `import.meta.dirname`) y `cli/package.json` declara `">=22"` (por `ink@8` y
      `terminal-image@5`), y `pnpm pack` de cada paquete deja ese campo en el
      `package.json` del tarball.
      Depends on: nada.

- [ ] **Sacar `terminal-image` y `tsconfig-paths` de las dependencias de producción del core**
      `grep -rn terminal-image core/src` no devuelve nada (sólo lo importa
      `cli/src/terminal/stdin.ts`), y `tsconfig-paths` no se importa en ningún sitio del
      core porque los alias `@/*` los resuelve `tsc-alias -f` en build-time; el SDK no
      debe arrastrar `jimp` ni un loader de paths que no usa.
      Done when: `terminal-image` sale de `dependencies` del core (a `devDependencies` o
      fuera) y `tsconfig-paths` deja de estar en `dependencies`, de modo que
      `pnpm --filter @racso2609/core build && pnpm --filter @racso2609/core test` sigue en
      verde y el `pnpm-lock.yaml` deja de resolver `jimp` para el core.
      Depends on: nada.

- [ ] **Construir y auditar los dos tarballs antes de publicar**
      `dist` está en `.gitignore`, así que un tarball sin `pnpm -r build` sale vacío y el
      fallo llega al usuario como `ERR_MODULE_NOT_FOUND`.
      Done when: `pnpm -r build && pnpm pack --pack-destination /tmp/rel` en cada paquete
      produce un `tar -tzf` con 135 entradas en el core (93 sin `.map`) y 61 en el cli, sin
      `package/src/`, `package/tests/` ni `package/TODO.md`, y el `package.json` del tarball
      del cli declara la dependencia del core con `^1.0.0` (no `workspace:*`) y sin `"private": true`.
      Depends on: añadir `files` explícito a los dos paquetes, quitar `private: true` del
 cli y pasar la dependencia del core a `workspace:^`, renombrar los imports de
`@racso/core` a `@racso2609/core` en el cli.

- [ ] **Añadir el `.npmrc` de publicación con el token por variable de entorno**
      Sin registry por scope, `pnpm publish` va a `registry.npmjs.org`; el token nunca
      puede quedar en claro en el fichero.
      Done when: `.npmrc` de la raíz declara
      `@racso2609:registry=https://npm.pkg.github.com` y
      `//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}`, y `pnpm publish --dry-run
--no-git-checks` en `core/` anuncia el destino `https://npm.pkg.github.com`.
      Depends on: renombrar el scope a `@racso2609` en los dos `package.json`.

- [ ] **Publicar `@racso2609/core`**
      Es la lib base de los otros dos paquetes: sin core en el registry no hay nada que
      consuman el cli ni el gateway.
      Done when: `pnpm publish --no-git-checks` en `core/` termina sin error y
      `npm view @racso2609/core version --registry=https://npm.pkg.github.com` con
      `GITHUB_TOKEN` en el entorno devuelve la versión publicada.
 Depends on: añadir el `.npmrc` de publicación, construir y auditar los dos tarballs
antes de publicar.

- [ ] **Publicar `@racso2609/cli`**
      Va después del core porque depende de él, y es el paquete que trae el binario
      `racso-harness`.
      Done when: `pnpm publish --no-git-checks` en `cli/` termina sin error y
      `npm view @racso2609/cli version --registry=https://npm.pkg.github.com` con
      `GITHUB_TOKEN` devuelve la versión publicada.
      Depends on: publicar `@racso2609/core`.

- [ ] **Crear el release con los `.tgz` adjuntos**
      Es el canal sin token: quien no quiera configurar `.npmrc` ni PAT instala desde el
      release con un `npm i https://github.com/...` y nada más.
      Done when: `gh release view v<versión> --repo racso2609/agent-harness` lista
      `racso2609-core-<versión>.tgz` y `racso2609-cli-<versión>.tgz`, y el tag coincide
      con la `version` publicada de los dos paquetes.
      Depends on: publicar `@racso2609/cli`.

- [ ] **Convertir el guion de `docs/INSTALL.md` en un script de smoke test de instalación limpia**
      Hoy no existe ningún script: el smoke test sólo está escrito como guion manual en
      `docs/INSTALL.md`, así que nadie lo ejecuta antes de publicar.
      Done when: existe `scripts/smoke-install.mjs` en la raíz que crea un directorio
      temporal, instala los dos `.tgz`, verifica `typeof createHarness === "function"`,
      que `node_modules/.bin/racso-harness` existe y que un primer arranque con `HOME`
      propio siembra `agents/*.md` (6) y `skills/*.md` (2); el script termina en verde
      contra los `.tgz` recién empaquetados.
      Depends on: construir y auditar los dos tarballs antes de publicar.

- [ ] **Documentar la instalación en el README con los dos canales**
      El README explica el diseño pero no cómo se instala ni qué crea el primer arranque,
      y hay dos formas de instalar con requisitos distintos (token o no).
      Done when: el README tiene una sección de instalación con el canal de GitHub
      Releases (sin token), el de GitHub Packages (`.npmrc` con `read:packages`), la
      versión de Node requerida (`>=22` para el CLI, `>=20.11` para el SDK solo) y qué
      ficheros crea en `~/.racso-harness/`.
      Depends on: crear el release con los `.tgz` adjuntos.

## P4.5 — Scroll del transcript y ruido del logger

Lo que el usuario reportó: "scrolleo un poco para arriba y el contenido se vuelve
loco y me lleva muy arriba en el historial; si scrolleas mientras se genera pasan
cosas raras" y "que los logger info y warn no aparezcan salvo con un modo debug".

- [x] **Medir el transcript en líneas visuales, no en "las últimas 60 entradas"**
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

- [x] **Rueda del ratón y arreglo del recorte del transcript**
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

- [x] **Silenciar `logger.info`/`warn` del core salvo en modo debug**
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

## P5 — Deuda conocida del TUI

- [ ] **Probar la interacción real por teclado**
      Los tests cubren la lógica pura (colapso, markdown, layout, tema) pero **nadie ha
      probado las teclas**: `ctrl+r`, `ctrl+t`, `enter` sobre entrada vacía, y las flechas
      del approval. Ink captura stdin y aquí no hay TTY interactivo.
      Done when: un test monta `App` con stdin simulado y verifica al menos el approval y
      los dos toggles; si ink no lo permite, se documenta como verificación manual.

- [ ] **Portar el setup interactivo a la TUI**
      Si `config.needsSetup()` es verdadero, `startSetup` corre **antes** de montar ink y
      compite por stdin con el renderer. Riesgo latente en instalación nueva.
      Done when: existe una instalación sin config que arranca con `--tui` sin conflicto de
      stdin (o el setup se fuerza en modo líneas y se documenta).

- [ ] **Truncar tablas es agresivo en terminales estrechas**
      Con `MIN_COLUMN_WIDTH = 3` una tabla de cuatro columnas en 50 columnas deja celdas
      de tres caracteres (`pro`, `mod`), legibles pero poco útiles. Falta decidir si se
      colapsa a una lista vertical cuando el ancho no alcanza.
      Done when: está escrito el umbral (p. ej. < 40 columnas → lista) y aplicado.

- [ ] **Los tests de lógica pura no cubren el cableado al render**
      Dos bugs del TUI salieron en prueba visual y no en tests: la captura de razonamiento
      dentro de un `if (content)`, y el truncado de tablas calculado pero no aplicado al
      render. Es el mismo tipo de error (lo que se calcula no es lo que se pinta).
      Done when: al menos un test renderiza un componente con ink y compara la salida.

- [x] **Los tests del renderer de líneas fijaban el texto con aserciones tautológicas**
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

- [ ] **Decidir si la expansión sobrevive al turno**
      El caso `turnStart` de `cli/src/ui/TuiUiAdapter.tsx:225` hace
      `expanded: new Set<number>()`, es decir **vacía el set de entradas expandidas al
      empezar cada turno**. La intención original era que el transcript no se quedara
      lleno de entradas abiertas de turnos anteriores. Ahora que el set guarda índices
      **absolutos** del transcript ya no hay desalineación al desplazarse la ventana de
      60 entradas —`toggleEntry` (`TuiUiAdapter.tsx:88`) recibe el índice absoluto que
      manda el `onToggle` de `App` (`ui/tui/App.tsx:149`, `state.lines.length - 1`) y
      `toggleAll` (`TuiUiAdapter.tsx:103`) lo construye con
      `this.state.lines.map((line, index) => ...)` sobre la lista completa—, así que la
      decisión de vaciarlo merece revisarse: hoy una entrada que el usuario expandió
      explícitamente se colapsa sola cuando empieza el siguiente turno, aunque el
      usuario no haya tocado nada.
      Done when: está escrito, con su motivo, si el set se vacía en `turnStart` o si se
      conserva; y si se conserva, hay un test que fija que una entrada expandida en el
      turno N sigue expandida en el turno N+1, y una poda para que el set no crezca sin
      límite.
      Depends on: nada.

- [x] **`/resume` dejaba en pantalla la conversación de la sesión anterior**
      El core ya restauraba el historial (`SessionManager.load` → `this.history =
record.history`), pero el CLI no tenía con qué leerlo ni evento para repintarlo, así que
      una sesión reanudada seguía mostrando los mensajes viejos hasta que el usuario los
      borraba y ponía los de la sesión cargada a mano.
      hecho (core): `conversation(): ConversationEntry[]` en `src/session/SessionManager.ts:582`
      filtra `system` (persona del agente, memoria de compactación) y `tool` (su resultado ya
      está resumido en la respuesta), descarta mensajes con `content` vacío tras `trim()`,
      respeta el orden más antiguo primero y devuelve copia (nunca la referencia interna
      `this.history`). Tipo `ConversationEntry` en `src/types/session.ts:36`, en `IHarness`
      (`src/contract.ts:83`) y delegado de una línea en `src/harness.ts:56`; documentado en
      `core/CONTRACT.md:97`.
      hecho (cli): evento `{ type: "conversation"; entries }` en `UiEvent`
      (`src/ui/UiAdapter.ts:55`), que **reemplaza** el transcript y no va con `reset`;
      `MainLoop#showConversation` (`src/MainLoop.ts:37`) no emite nada si la conversación está
      vacía (una sesión nueva no debe borrar la pantalla) y se llama tras `initialize()`
      (`src/MainLoop.ts:110`) y cuando un comando cambia de sesión (`src/MainLoop.ts:289`, antes
      de `showChildHistory`). La TUI (`src/ui/TuiUiAdapter.tsx:318`) sustituye `lines` (`user` →
      entrada `user`, `assistant` → `answer` pasado por `MarkdownStream` para que el histórico
      se pinte con el mismo markdown que una respuesta en vivo) y limpia `streams`, `anchors`,
      `spawns` (la franja viva era de la sesión anterior) y `expanded`; conserva `history` (los
      hijos restaurados llegan justo después) y `status`. El modo líneas
      (`src/ui/CliUiAdapter.ts:147`) limpia la pantalla y resume en vez de volcar al scrollback:
      `formatConversationSummary` (`src/ui/CliUiAdapter.ts:45`) compone
      `conversation restored: N messages`, `you: …` y `assistant: …` con el último intercambio,
      colapsando espacios y saltos y recortando a 200 con `…`.
      tests: 6 en `core/tests/session/SessionManager.spec.ts` (filtrado de system/tool, respuesta
      vacía, copia, historial vacío, orden), 5 en `tests/ui/cliAdapter.spec.ts` (limpia antes de
      resumir, solo el último intercambio, recorte a 200, sesión sin respuesta, conversación
      vacía sin tocar pantalla), 2 en `tests/ui/spawnWiring.spec.ts` (el helper emite lo que dice
      el harness, silencio si vacía) y 4 en `tests/ui/transcript.spec.ts` (reemplaza las
      entradas, vacía la franja viva y el set `expanded`, conserva los hijos restaurados, no
      limpia si está vacía).

**Segunda tanda (revisión de la primera).** La primera tanda dejaba tres defectos: el turno
automático se guardaba como `user` a secas y `/resume` lo pintaba como si lo hubiera escrito
el usuario; un turno de generación de imagen llamaba a `provider.generateImage(prompt)` sin
empujar el `user`, así que tras reanudar aparecía una respuesta sin su pregunta; y la TUI
reemplazaba el transcript sin tocar `running`/`activity`, con el reloj de trabajo corriendo
sobre una cola que ya no existía.
hecho (core): flag `unprompted?: true` —nombre elegido porque describe el hecho que importa
(nadie lo pidió) y no el origen del texto— en `AskOptions` (`src/contract.ts:55`),
propagado a `UserMessage` (`src/types/providers.ts:120`) y de `Harness.ask`
(`src/harness.ts:24`) a `SessionManager.ask` (`src/session/SessionManager.ts:721`) y al
helper `userMessage()` (`src/session/SessionManager.ts:878`): el turno **se guarda igual**
en el historial (el modelo tiene que verlo) y solo se oculta de la UI. El filtro vive en
`conversation()` (`src/session/SessionManager.ts:582`), única puerta, así que ningún
renderer puede reintroducir el defecto; el flag **no** se expone en `ConversationEntry` y el
`assistant` de un turno `unprompted` sí se muestra (es trabajo real). `sessionTitle()`
(`src/session/SessionManager.ts:358`) ignora los `unprompted`, o una sesión que arrancó con
una continuación se titularía con esa frase. Nuevo helper `runImageTurn()`
(`src/session/SessionManager.ts:889`) que empuja el `user` con la misma forma que el camino
de texto (respetando `unprompted`) antes de llamar al endpoint de imagen.
hecho (cli): `MainLoop` pasa `unprompted: turn.continuation ? true : undefined`
(`src/MainLoop.ts:319`): solo el turno que nadie pidió —`CONTINUATION_PROMPT`, el texto que
encola el core— lleva el flag, nunca un prompt del usuario aunque haya hijos esperando. En
la TUI, `case "conversation"` (`src/ui/TuiUiAdapter.tsx:318`) deja el renderer en reposo
(`running: false`, `activity: undefined`) y resuelve como `deny` la aprobación que hubiera
pedido el turno de la sesión anterior —ese turno esperaba una respuesta que ya nadie va a
dar, igual que hace `close()` al salir—.
tests: 6 nuevos en `core/tests/session/SessionManager.spec.ts:1761` (turno `unprompted` en
el historial pero fuera de `conversation()`, turno normal visible, respuesta del
`unprompted` sí visible, `ask(..., { unprompted: true })` end-to-end, prompt de imagen en
historial y en `conversation()`, `sessionTitle()` ignora el `unprompted`) y 6 en el nuevo
`tests/ui/resumeWiring.spec.ts:213` (monta el `MainLoop` real con ink stubbeado y un
`IHarness` falso completo, metiendo los prompts por el `onSubmit` del adapter: repintado de
conversación + hijos tras `/resume` una sola vez y conversación antes que franja, renderer
en reposo tras repintar, nada al arrancar sin nada que mostrar, nada si el comando no cambió
de sesión, la continuación llega a `ask` con `unprompted: true`, y un prompt del usuario no
lleva el flag). Las dos guardas de fuente con `indexOf` sobre `MainLoop.ts` que había en
`tests/ui/spawnWiring.spec.ts` se retiraron: lo que fijaban lo fijan ahora esos tests de
comportamiento. En `tests/ui/cliAdapter.spec.ts` las aserciones pasaron de
`startsWith`/`toContain` a comparar la salida completa con `toBe`.
compatibilidad: `SESSION_VERSION` sigue en 4. Los historiales ya persistidos no distinguen el
prompt de continuación, así que se acepta que los turnos viejos se lean como estaban y solo
los nuevos se marquen; el campo es opcional y `SessionStore.load` no cambió.
hecho (cli): el arranque sí pasa la sesión. `src/main.ts` acepta el flag y lo entrega a
`MainLoop.start()` (`src/main.ts:81`), que lo resuelve en `MainLoop#resumeTarget`
(`src/MainLoop.ts:187`) contra `harness.resolveSession(...)`: `SessionManager.initialize({sessionId})`
hace `store.load(id)` literal, así que un prefijo o un índice que llegaran ahí arrancarían una
sesión nueva en silencio. Formas aceptadas por `src/flags.ts`: `--resume <id>`, `-r <id>`,
`--session <id>`, `-s <id>`, `--resume=<id>` y `-r=<id>` (el `=` corto antes se ignoraba sin
avisar). Un id completo, un prefijo único o un índice 1-based: la resolución es siempre la
misma que la de `/resume`. `--resume`/`-r` desnudo reanuda la más reciente
(`listSessions()[0]`, ordenada por actividad; `src/MainLoop.ts:200`). Cualquier argv ambiguo
termina en error de uso con exit 2 (`USAGE_EXIT_CODE`, `src/main.ts:40` y `src/MainLoop.ts:58`),
nunca en sesión nueva silenciosa: valor que no resuelve, `--session`/`-s` sin valor, valor
vacío y store vacío con `--resume` desnudo (`NO_SESSIONS_TO_RESUME`, `src/MainLoop.ts:27`).
`usageError` (`src/flags.ts`) es pegajoso: gana a los demás flags de la misma línea de
comandos, con la excepción documentada de `--version`/`-V`, que es consulta pura y gana al
error de uso. El repintado de `start()` (`src/MainLoop.ts:147`, `showConversation`) se activa
justo con esa ruta. `src/main.ts` se reorganizó alrededor de `run(deps)` inyectable
(argv/stdout/stderr/exit/logo/version/createLoop) para que el orden de efectos sea testeable, y
el arranque quedó tras un guard de entrypoint (`realpathSync` con fallback `pathToFileURL`,
`isEntrypoint`) para que importar el módulo no tenga efectos.
tests: `cli/tests/flags.spec.ts` (parser: las cuatro formas, el `=`, el valor vacío y el
`--version` que gana al error), `cli/tests/main.spec.ts` (cadena argv → `run()` →
`MainLoop.start()` → `resolveSession()` → `initialize`, con el `MainLoop` real) y
`cli/tests/ui/resumeWiring.spec.ts` (resolución y rechazos). Suite: 477 tests en 30 ficheros,
en verde.
pendiente: no se ha probado contra un historial persistido real en una sesión interactiva;
todo lo anterior está verificado con `IHarness` stubbeado o con el `MainLoop` real pero sin
store de verdad. Eso es lo único que queda abierto.
Done when: tras `/resume` la pantalla muestra solo la conversación de la sesión reanudada,
en los dos renderers y sin intervención manual.
Depends on: nada.

- [ ] **Un mensaje de commit afirma el estado del padre, y hay que medirlo en el padre**
      Los commits `eae796b` y `aa46e50` afirman cosas sobre el commit anterior («five
      mutations», «only one of them was covered») que resultaron falsas al medirlas: se
      midieron en el árbol de trabajo y no sobre `git archive <padre>`, así que la frase
      describía el árbol y no el commit que decía describir. La causa común es escribir
      la justificación antes de medir; cuando luego se mide, la afirmación ya está en el
      mensaje.
      Done when: está escrito en el TODO (o donde corresponda del proceso) que toda
      afirmación de un mensaje de commit sobre el comportamiento del padre se mide sobre
      `git archive <sha-padre>` y no sobre el árbol, y la próxima revisión de commit
      comprueba ese punto explícitamente.
      Depends on: nada.

## P6 — Continuación automática tras un hijo

Punto del usuario: «cuando un delegate termine si aun hay trabajo que hacer la session debe seguir el trabajo que queda no esperar por mi». Hoy no lo hace: `SessionManager` inyecta el resultado del hijo asentado como mensaje `system` en el history del padre (`SessionManager.ts:592`), pero el turno del padre ya había terminado, así que `MainLoop` vuelve a `nextPrompt()` y la sesión se queda esperando input humano. El mecanismo para arrancar un turno sin usuario ya existe (`queue`/`pending` en `MainLoop`); falta decidir cuándo usarlo.

- [ ] **Exponer si un hijo asentado dejó trabajo sin entregar**
      El CLI no puede decidir si continuar porque el core no dice si el resultado del hijo llegó antes o después del último turno del padre ni cuántos hijos quedaron sin entregar.
      Done when: una prueba en `core/tests/session/SessionManager.spec.ts` verifica que la API nueva devuelve los `spawnId` asentados cuyo resultado aún no ha entrado en un turno del padre, y vuelve a devolver lista vacía una vez entregados.
      Depends on: nada.
      Nota: el contrato vive como tarea espejo en `core/TODO.md` §9 («Exponer los hijos asentados con resultado sin entregar»).

- [ ] **Arrancar un turno sin prompt cuando un hijo deja trabajo**
      `MainLoop` debe encolar un turno de continuación (mismo camino que `enqueue`) cuando un `spawnSettled` trae trabajo pendiente y el usuario no está escribiendo.
      Done when: existe un test (o, si el bucle no es montable en test, una guarda de fuente documentada igual que las de §P1) que fija que tras un `settled` con trabajo pendiente el CLI llama a `harness.ask` sin input del usuario y sin esperar a `nextPrompt`.
      Depends on: exponer si un hijo asentado dejó trabajo sin entregar.
      Decidir antes: si aplica solo con `--tui` o también en modo líneas, y si el turno automático pisa una línea que el usuario está escribiendo.

- [ ] **Acotar las continuaciones automáticas**
      Sin tope, un hijo que deja trabajo cada vez encadena turnos infinitos y gasta tokens sin control.
      Done when: existe un límite configurable (en `config.sessions`) con default documentado y una prueba fija que al alcanzarlo no se arranca otro turno y se avisa al usuario.
      Depends on: arrancar un turno sin prompt cuando un hijo deja trabajo.
      Decidir antes: valor del default y si el contador se resetea con input del usuario.

- [ ] **Contar el turno automático como continuación en el cierre del turno**
      El aviso de cierre (`formatTurnOutcome`) hoy describe el turno pasado; en una cadena automática debe indicar que la sesión sigue sola, para que el usuario no crea que el proceso quedó parado.
      Done when: un test de `cli/tests/ui/outcome.spec.ts` fija el texto de un turno encadenado y el silencio del turno final.
      Depends on: arrancar un turno sin prompt cuando un hijo deja trabajo.

## Deuda de proceso

- [ ] **Decidir si se reescribe el asunto del commit `ec23080`**
      El slice de `P2` ya está cerrado (producción, tests y este TODO), pero su asunto dice
      `wip(cli): report the outcome of a turn and of every child`. Un `rebase -i` lo
      convertiría en `feat(cli): ...`; hacerlo reescribe historia y la rama es compartida,
      así que la decisión —reescribir o dejarlo— tiene que quedar explícita. Hoy el `wip` es
      lo único que contradice el estado del TODO.
      Done when: está escrito, con la decisión y su motivo, si el asunto se reescribe o se
      deja — y si se reescribe, `git log --oneline` ya no muestra ningún `wip(`.
      Depends on: nada.

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
- **¿Vale la pena usar el gateway desde el CLI?** Hoy el CLI habla `@racso/core`
  en proceso, así que meter un gateway añadiría un salto de red y un servicio que
  mantener sin resolver ningún problema actual (mono-usuario, una sesión a la vez).
  Sólo se reabre si el gateway existe (`core/TODO.md` §10) y aparece un caso real
  —varios terminales contra las mismas sesiones, o correr el CLI en otra máquina—.
  Para cerrarla hay que decidir qué se gana frente a ejecutar el core in-process.

## P7 — deriva de agentes en runtime

Los agentes se versionan como markdown con frontmatter en `core/agents/` y se cargan
en runtime desde `~/.racso-harness/agents/`. `ensureAgentsDir` (`core/src/agents/seed.ts`)
sólo siembra el directorio **cuando está vacío**: eso es deliberado (protege los
agentes que el usuario ya personalizó), pero deja sin camino la **actualización** de un
agente ya existente. Consecuencia: editar `core/agents/<id>.md` no cambia nada en
runtime, y cualquier mejora del contrato de un agente se queda en el repo sin efecto.
Por eso `core/agents/code-reviewer.md` se copió a mano a
`~/.racso-harness/agents/code-reviewer.md` al cerrar los niveles de revisión.

- [ ] **Detectar y mostrar la deriva entre `core/agents/` y `~/.racso-harness/agents/`**
Hoy no hay forma de saber si el agente que corre es el del repo; hace falta un comando (p.ej. `/agents diff` o `/agents status`) que liste, por cada `.md` de `core/agents/`, si falta en runtime, si es idéntico o si diverge.
Done when: con los 6 agentes sembrados y `coder.md` divergente (`approval: auto` en runtime, `ask` en el repo), el comando reporta 5 idénticos y `coder.md` como `modified`, y un test lo fija.
Depends on: nada.

- [ ] **Resincronizar un agente de runtime sin pisar personalizaciones**
Falta el flujo explícito de actualización: `/agents sync <id>` (o `--all`) que muestre el diff y **sólo** sobrescriba tras confirmación explícita, marcando el fichero como personalizado cuando el usuario decida conservarlo.
Done when: `/agents sync` sobre un `coder.md` divergente muestra el diff y no escribe nada sin confirmación; con confirmación deja `diff core/agents/coder.md ~/.racso-harness/agents/coder.md` vacío, y un test cubre ambos caminos.
Depends on: detectar y mostrar la deriva.

> Nota de deriva ya existente (no corregida): en esta máquina
> `~/.racso-harness/agents/coder.md` declara `approval: auto` y
> `core/agents/coder.md` declara `approval: ask`. Es una decisión del usuario sobre su
> propia máquina; se resuelve con `/agents sync` o dejándolo como está, no editando el
> repo a ciegas. Los otros cinco (`code-reviewer`, `reviewer`, `senior-architect`,
> `default`, `shell-operator`) eran idénticos antes de este cambio; `code-reviewer` se
> resincronizó a mano.
