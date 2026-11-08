# TODO — CLI (racso-harness)

El CLI (`@racso2609/cli`) es el cliente de terminal: dos renderers sobre un mismo contrato
`UiAdapter`/`UiEvent` (`CliUiAdapter` de líneas, por defecto, y `TuiUiAdapter` con ink tras
`--tui`), con `MainLoop` que solo emite eventos y nunca escribe a stdout. Lo que queda
abierto es un ítem de `P2`, la verificación de la publicación (`P4`), la deuda del TUI
(`P5`), la prueba de humo de la continuación automática (`P6`) y `P7`.
Formato: skill `todo-format`. Historial: docs/journal/cli/.

## Abierto

- **El aviso de cierre no muestra el informe del hijo** — P2 · `Done when` en §P2
- **Verificar la instalación publicada y decidir el canal Packages** — P4 · `Done when` en §P4
- **Probar la interacción real por teclado** — P5 · `Done when` en §P5
- **Portar el setup interactivo a la TUI** — P5 · `Done when` en §P5
- **Truncar tablas es agresivo en terminales estrechas** — P5 · `Done when` en §P5
- **Los tests de lógica pura no cubren el cableado al render** — P5 · `Done when` en §P5
- **Decidir si la expansión sobrevive al turno** — P5 · `Done when` en §P5
- **Un mensaje de commit afirma el estado del padre, y hay que medirlo en el padre** — P5 · `Done when` en §P5
- **Decidir si se reescribe el asunto del commit `ec23080`** — Deuda de proceso · `Done when` en §Deuda de proceso
- **Detectar y mostrar la deriva entre `core/agents/` y `~/.racso-harness/agents/`** — P7 · `Done when` en §P7
- **Resincronizar un agente de runtime sin pisar personalizaciones** — P7 · `Done when` en §P7

## P0 — TUI de pantalla completa (bloquea P1)

Los cuatro ítems de la sección están cerrados; su cuerpo narrativo y sus decisiones viven
en [journal P0](../docs/journal/cli/p0-tui-stack.md).

- [x] **Elegir el stack de rendering y su costo de dependencias**
Fijó ink 8 + React 19 como stack del renderer de pantalla completa frente a un renderer propio sobre ANSI + `readline`.
Done when: no se fijó uno; el hecho está en el journal.
hecho: `cli/package.json` con `ink@8` y `react@19` — ver [journal P0](../docs/journal/cli/p0-tui-stack.md)

- [x] **Extraer la UI detrás de una interfaz de paneles**
Sacó toda escritura a stdout de `MainLoop` detrás de `UiAdapter`, para que los dos renderers compartan la lógica del turno.
Done when: no se fijó uno; el hecho está en el journal.
hecho: `cli/src/ui/UiAdapter.ts` — ver [journal P0](../docs/journal/cli/p0-tui-stack.md)

- [x] **Portar la pantalla base (historial + input + status bar)**
Montó la pantalla de pantalla completa (dos paneles, input con `useInput`, status bar y approval) manteniendo el modo líneas como default.
Done when: no se fijó uno; el hecho está en el journal.
hecho: `cli/src/ui/tui/App.tsx` — ver [journal P0](../docs/journal/cli/p0-tui-stack.md)

- [x] **Definir el layout de progreso (franja de hijos + actividad)**
Decidió una única franja inferior dinámica y colapsable para los hijos, con la actividad del turno dentro del input.
Done when: no se fijó uno; el hecho está en el journal.
hecho: `cli/src/ui/tui/progress.ts` — ver [journal P0](../docs/journal/cli/p0-tui-stack.md)

## P1 — Feedback mientras el turno corre

Los cuatro ítems de la sección están cerrados; su cuerpo narrativo vive en
[journal P1](../docs/journal/cli/p1-turn-feedback.md).

- [x] **Consumir los eventos de spawn en la UI**
Suscribió `MainLoop` a `onSpawnEvent()` para que los dos renderers pinten arranque y cierre de cada hijo.
Done when: no se fijó uno; el hecho está en el journal.
hecho: `cli/src/MainLoop.ts` — ver [journal P1](../docs/journal/cli/p1-turn-feedback.md)

- [x] **Mostrar trabajo en curso**
Añadió `activity` dentro del input box para que el usuario sepa que el turno sigue aunque no lleguen eventos.
Done when: no se fijó uno; el hecho está en el journal.
hecho: `cli/src/ui/tui/App.tsx` — ver [journal P1](../docs/journal/cli/p1-turn-feedback.md)

- [x] **Mostrar estado por subagente**
Pinta cada hijo con agente, id, tiempo e icono por estado, y lo retira 5 s después de asentar.
Done when: no se fijó uno; el hecho está en el journal.
hecho: `cli/src/ui/tui/progress.ts` — ver [journal P1](../docs/journal/cli/p1-turn-feedback.md)

- [x] **Pintar los hijos restaurados al reanudar una sesión**
Hizo visible tras `/resume` el histórico de hijos persistido, que antes arrancaba vacío porque `listSpawns()` solo ve el proceso actual.
Done when: no se fijó uno; el hecho está en el journal.
Depends on: persistencia de handles (`core/TODO.md` §9.1.4, ya hecho).
hecho: `cli/src/MainLoop.ts#showChildHistory` — ver [journal P1](../docs/journal/cli/p1-turn-feedback.md)

## P2 — Contrato de retorno de los subagentes

Los tres primeros ítems están cerrados; su cuerpo narrativo vive en
[journal P2](../docs/journal/cli/p2-outcome-contract.md). Queda abierto el del aviso de cierre.

- [x] **Verificar el contrato de resultado de spawn en todos los agentes**
Fijó con tests que un hijo sin salida llega al padre como `(no output)` en vez de una cabecera con cuerpo vacío.
Done when: no se fijó uno; el hecho está en el journal.
Depends on: nada.
hecho: `core/tests/session/SessionManager.spec.ts` — ver [journal P2](../docs/journal/cli/p2-outcome-contract.md)

- [x] **Notificar al usuario el estado final de cada hijo**
Llevó al usuario, en el momento en que termina, el desenlace de cada hijo que antes solo veía el padre en el turno siguiente.
Done when: no se fijó uno; el hecho está en el journal.
Depends on: consumir los eventos de spawn.
hecho: `cli/src/ui/outcome.ts` — ver [journal P2](../docs/journal/cli/p2-outcome-contract.md)

- [x] **Cerrar cada turno con qué pasó, qué falta y qué sigue**
Añadió un cierre de turno (`turn failed` / `turn incomplete` con `pending:` y `next:`) para que el usuario no tenga que inferir el estado.
Done when: no se fijó uno; el hecho está en el journal.
Depends on: notificar al usuario el estado final de cada hijo.
hecho: `cli/src/ui/outcome.ts#formatTurnOutcome` — ver [journal P2](../docs/journal/cli/p2-outcome-contract.md)

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

Los cinco ítems de la sección están cerrados; su cuerpo narrativo vive en
[journal P3](../docs/journal/cli/p3-transcript.md).

- [x] **Mostrar el razonamiento del modelo en streaming**
Dejó de descartar el razonamiento que ya llegaba por `ChatEvent` y lo pinta en su propia entrada, en dim.
Done when: no se fijó uno; el hecho está en el journal.
hecho: `cli/src/ui/tui/App.tsx` — ver [journal P3](../docs/journal/cli/p3-transcript.md)

- [x] **Mostrar la salida viva de `shell`**
Acumula la salida de la tool en su entrada para que un `shell` largo dé señal de vida mientras corre.
Done when: no se fijó uno; el hecho está en el journal.
hecho: `cli/src/ui/UiAdapter.ts` (`toolOutput`) — ver [journal P3](../docs/journal/cli/p3-transcript.md)

- [x] **Formatear el texto del stream en lugar de concatenar caracteres**
Pinta bloques cerrados con su estilo final y deja la cola abierta plana, para que el markdown no se vea literal ni parpadee.
Done when: no se fijó uno; el hecho está en el journal.
hecho: `cli/src/ui/tui/markdown.ts#MarkdownStream` — ver [journal P3](../docs/journal/cli/p3-transcript.md)

- [x] **Colapsar razonamiento y tool calls**
Reservó el espacio para la respuesta con una ventana de 6 líneas mientras el turno corre y un colapso a cabecera al terminar, sin ocultar nunca una tool que falló.
Done when: no se fijó uno; el hecho está en el journal.
hecho: `cli/src/ui/tui/collapse.ts` — ver [journal P3](../docs/journal/cli/p3-transcript.md)

- [x] **Dar aire vertical al texto final (interlineado y separación de bloques)**
Dio espaciado declarado entre entradas y bloques, que antes se pintaban pegados como un muro de texto.
Done when: existe una regla de espaciado declarada (línea en blanco entre entradas,
margen antes de heading/lista/código/tabla y aire antes/después de la respuesta
final en modo líneas) y un test la fija.
Depends on: nada.
hecho: `cli/src/ui/tui/layout.ts#gapBefore` — ver [journal P3](../docs/journal/cli/p3-transcript.md)

## P4 — F0: publicación y verificación

La fase **F0** de `docs/ARCHITECTURE.md` está hecha salvo verificarla: el **empaquetado y
la publicación están HECHOS** —release `v1.0.0` con `racso2609-core-1.0.0.tgz` y
`racso2609-cli-1.0.0.tgz`, publicado el 2026-11-05, y `README.md` ya tiene su sección
`## Instalación`—. Lo que queda es **verificar** esa instalación contra los `.tgz`
publicados y **decidir el canal** de GitHub Packages, que hoy no es verificable
(`npm view` da 401 sin token).

Los ocho ítems de empaquetado y publicación están cerrados; su cuerpo narrativo y sus
`pendiente:` viven en [journal P4 empaquetado](../docs/journal/cli/p4-packaging.md) y
[journal P4 publicación](../docs/journal/cli/p4-publish.md).

- [x] **Renombrar el scope a `@racso2609` en los dos `package.json`**
Alineó el scope con el dueño real del repo, requisito de GitHub Packages, porque la org `racso` no existe.
Done when: `grep '"name"' core/package.json cli/package.json` devuelve
`@racso2609/core` y `@racso2609/cli`, y no queda ningún `"name": "@racso/`.
Depends on: nada.
hecho: `core/package.json` y `cli/package.json` — ver [journal P4 empaquetado](../docs/journal/cli/p4-packaging.md)

- [x] **Renombrar los imports de `@racso/core` a `@racso2609/core` en el cli**
Renombró los 22 ficheros que importaban el paquete viejo, sin lo cual el `dist` del cli importaría un paquete inexistente.
Done when: `grep -rn "@racso/core" cli/src cli/tests cli/bin` no devuelve nada y,
tras `pnpm --filter @racso2609/cli build`, `grep -c "@racso2609/core"
cli/dist/main.js` devuelve `1` o más.
Depends on: renombrar el scope a `@racso2609` en los dos `package.json`.
hecho: `cli/src` y `cli/tests` (22 ficheros) — ver [journal P4 empaquetado](../docs/journal/cli/p4-packaging.md)

- [x] **Añadir `files` explícito a los dos paquetes**
Recortó el tarball a lo publicable, que sin `files` arrastraba `src/`, `tests/` y `TODO.md`.
Done when: `core/package.json` declara `files: ["dist", "agents", "skills"]` y
`cli/package.json` declara `files: ["dist", "bin", "racso-logo.txt"]`, con el logro
verificado en la tarea de auditar los tarballs.
Depends on: nada.
hecho: `core/package.json:16` y `cli/package.json:10` — ver [journal P4 empaquetado](../docs/journal/cli/p4-packaging.md)

- [x] **Quitar `private: true` del cli y pasar la dependencia del core a `workspace:^`**
Desbloqueó `pnpm publish` (`[EPRIVATE]`) y evitó fijar la versión exacta del core en cada bump.
Done when: (a) `grep -c '"private"' cli/package.json` devuelve `0`; (b) el
`package.json` del tarball (`pnpm pack` y extraer) no contiene `"private"`; (c) ese
mismo `package.json` deja `"@racso2609/core": "^1.0.0"` y ningún `workspace:`.
Depends on: renombrar el scope a `@racso2609` en los dos `package.json`.
hecho: `cli/package.json:22` — ver [journal P4 empaquetado](../docs/journal/cli/p4-packaging.md)

- [x] **Añadir `engines.node` a los dos paquetes**
Declaró el Node mínimo para que el fallo aparezca en la instalación y no en runtime.
Done when: `core/package.json` declara `engines.node: ">=20.11"` (por
`import.meta.dirname`) y `cli/package.json` declara `">=22"` (por `ink@8` y
`terminal-image@5`), y `pnpm pack` de cada paquete deja ese campo en el
`package.json` del tarball.
Depends on: nada.
hecho: `core/package.json:17` y `cli/package.json:11` — ver [journal P4 empaquetado](../docs/journal/cli/p4-packaging.md)

- [x] **Sacar `terminal-image` y `tsconfig-paths` de las dependencias de producción del core**
Evitó que el SDK arrastrara `jimp` y un loader de paths que no usa, ya que solo el cli importa `terminal-image`.
Done when: `terminal-image` sale de `dependencies` del core (a `devDependencies` o
fuera) y `tsconfig-paths` deja de estar en `dependencies`, de modo que
`pnpm --filter @racso2609/core build && pnpm --filter @racso2609/core test` sigue en
verde y el `pnpm-lock.yaml` deja de resolver `jimp` para el core.
Depends on: nada.
hecho: `core/package.json` (`dotenv`, `pino`, `pino-pretty`) — ver [journal P4 empaquetado](../docs/journal/cli/p4-packaging.md)

- [x] **Añadir el `.npmrc` de publicación con el token fuera del repo**
Puso el registry por scope en el `.npmrc` versionado y dejó el token fuera del repo, porque pnpm no expande variables en un `.npmrc` versionado.
Done when: el `.npmrc` de la raíz declara
`@racso2609:registry=https://npm.pkg.github.com`, no contiene ningún token ni la variable
`GITHUB_TOKEN`, la configuración del PAT queda documentada en ese mismo `.npmrc` como
`pnpm config set` fuera del repo, y `pnpm publish --dry-run --no-git-checks` en `core/`
anuncia el destino `https://npm.pkg.github.com`.
Depends on: renombrar el scope a `@racso2609` en los dos `package.json`.
hecho: `.npmrc` de la raíz — ver [journal P4 empaquetado](../docs/journal/cli/p4-packaging.md)

- [x] **Construir y auditar los dos tarballs antes de publicar**
Construyó y auditó los dos tarballs antes de publicar, porque `dist` está en `.gitignore` y un tarball sin build saldría vacío.
Done when: `pnpm -r build && pnpm pack --pack-destination /tmp/rel` en cada paquete
produce un `tar -tzf` con 135 entradas en el core (93 sin `.map`) y 61 en el cli, sin
`package/src/`, `package/tests/` ni `package/TODO.md`, y el `package.json` del tarball
del cli declara la dependencia del core con `^1.0.0` (no `workspace:*`) y sin `"private": true`.
La exclusión de `src/`, `tests/` y `TODO.md` ya está automatizada: el check
`core tarball excludes src/, tests/ and TODO.md` de `scripts/smoke-install.mjs:148`
(con `CORE_FORBIDDEN` en `:25`) falla si el tarball filtra cualquiera de los tres,
así que la auditoría manual solo tiene que confirmar el recuento de entradas.
Depends on: añadir `files` explícito a los dos paquetes, quitar `private: true` del
cli y pasar la dependencia del core a `workspace:^`, renombrar los imports de
`@racso/core` a `@racso2609/core` en el cli.
hecho: `scripts/smoke-install.mjs` — ver [journal P4 publicación](../docs/journal/cli/p4-publish.md)

- [x] **Publicar `@racso2609/core`**
Publicó la lib base de los otros paquetes: sin core en el registry no hay nada que consuman el cli ni el gateway.
Done when: `pnpm publish --no-git-checks` en `core/` termina sin error y
`npm view @racso2609/core version --registry=https://npm.pkg.github.com` con
`GITHUB_TOKEN` en el entorno devuelve la versión publicada.
Depends on: añadir el `.npmrc` de publicación, construir y auditar los dos tarballs
antes de publicar.
hecho: release `v1.0.0`, `racso2609-core-1.0.0.tgz` — ver [journal P4 publicación](../docs/journal/cli/p4-publish.md)

- [x] **Publicar `@racso2609/cli`**
Publicó el paquete que trae el binario `racso-harness`, después del core porque depende de él.
Done when: `pnpm publish --no-git-checks` en `cli/` termina sin error y
`npm view @racso2609/cli version --registry=https://npm.pkg.github.com` con
`GITHUB_TOKEN` devuelve la versión publicada.
Depends on: publicar `@racso2609/core`.
hecho: release `v1.0.0`, `racso2609-cli-1.0.0.tgz` — ver [journal P4 publicación](../docs/journal/cli/p4-publish.md)

- [x] **Crear el release con los `.tgz` adjuntos**
Creó el canal sin token: quien no quiera configurar `.npmrc` ni PAT instala desde el release.
Done when: `gh release view v<versión> --repo racso2609/agent-harness` lista
`racso2609-core-<versión>.tgz` y `racso2609-cli-<versión>.tgz`, y el tag coincide
con la `version` publicada de los dos paquetes.
Depends on: publicar `@racso2609/cli`.
hecho: release `v1.0.0` del 2026-11-05 — ver [journal P4 publicación](../docs/journal/cli/p4-publish.md)

- [x] **Convertir el guion de `docs/INSTALL.md` en un script de smoke test de instalación limpia**
Convirtió el guion manual de `docs/INSTALL.md` en un script ejecutable, porque nadie lo corría antes de publicar.
Done when: existe `scripts/smoke-install.mjs` en la raíz que crea un directorio
temporal, instala los dos `.tgz` con `npm` y el script termina en verde contra los `.tgz`
recién empaquetados. Lo que comprueba hoy, verificado en el propio script: que el core
instalado expone `createHarness` como función (check
`import("@racso2609/core") exposes createHarness`, `:263`); que el binario instalado
existe y responde —`npx --no-install racso-harness --version` (`:238`), check en `:247`,
que es lo que resuelve `node_modules/.bin/racso-harness`; que el tarball del core trae
`package/dist/` (`:126`), exactamente 6 ficheros `.md` bajo `package/agents/`
(`EXPECTED_AGENTS = 6`, `:23`, check en `:131`) y al menos uno bajo `package/skills/`
(`:140`, no exige 2); y que ese tarball excluye `src/`, `tests/` y `TODO.md` (`:148`).
Depends on: construir y auditar los dos tarballs antes de publicar.
hecho: `scripts/smoke-install.mjs` — ver [journal P4 publicación](../docs/journal/cli/p4-publish.md)

- [x] **Documentar la instalación en el README con los dos canales**
Escribió la sección de instalación con los dos canales y los requisitos de cada uno, que el README no explicaba.
Done when: el README tiene una sección de instalación con el canal de GitHub
Releases (sin token), el de GitHub Packages (`.npmrc` con `read:packages`), la
versión de Node requerida (`>=22` para el CLI, `>=20.11` para el SDK solo) y qué
ficheros crea en `~/.racso-harness/`.
Depends on: crear el release con los `.tgz` adjuntos.
hecho: `README.md` `## Instalación` — ver [journal P4 publicación](../docs/journal/cli/p4-publish.md)

- [ ] **Verificar la instalación publicada y decidir el canal Packages**
Lo que cierra F0 de verdad: los dos `.tgz` existen y el README los documenta, pero
nadie ha ejecutado el smoke test contra lo **publicado**, y la decisión sobre el canal
GitHub Packages sigue sin tomar porque hoy no es verificable (`npm view` da 401 sin
token), así que el canal que el README anuncia como canónico no está probado.
Done when: se descargan los `.tgz` publicados con
`gh release download v1.0.0 --repo racso2609/agent-harness` y se ejecuta
`node scripts/smoke-install.mjs` contra ellos; la salida en verde queda pegada en esta
tarea; y está escrita, con su motivo, la decisión sobre el canal GitHub Packages
(se mantiene como canónico, se degrada a best-effort o se retira del README) junto con
el comando que la haría verificable el día que exista un token con `read:packages`.
Depends on: nada.

#### Notas

- `pendiente:` de «Renombrar los imports de `@racso/core` a `@racso2609/core` en el cli»: la
  mitad que recompila (`pnpm --filter @racso2609/cli build` y `grep -c` sobre
  `cli/dist/main.js`) no se pudo hacer en su momento porque `cli/dist/main.js` no existe sin
  build. Hoy el release `v1.0.0` trae el `dist` construido, así que esa mitad se cubre en
  «Verificar la instalación publicada y decidir el canal Packages».
- `pendiente:` de «Añadir `files` explícito» y de «Añadir `engines.node`»: la verificación
  sobre el `package.json` **dentro del tarball** (`pnpm pack` y extraer) queda cubierta por la
  auditoría de los tarballs y por `scripts/smoke-install.mjs`.
- `pendiente:` de «Quitar `private: true`…»: la expansión de `workspace:^` a `^1.0.0` y la
  ausencia de `"private"` dentro del tarball se confirman en la auditoría de los tarballs.
- `pendiente:` de «Sacar `terminal-image` y `tsconfig-paths`…»: que el `pnpm-lock.yaml` deje de
  resolver `jimp` para el core se confirma con un `pnpm install` en limpio, que no se corre
  aquí para no tocar el lockfile compartido.
- `pendiente:` de «Añadir el `.npmrc`…»: `pnpm publish --dry-run --no-git-checks` en `core/` no
  se corre sin token configurado porque no dice nada útil sobre el canal real.
- `pendiente:` de «Convertir el guion de `docs/INSTALL.md`…»: el script **no** verifica que un
  primer arranque con `HOME` propio siembre los ficheros en `$HOME/.racso-harness/`. Hoy solo
  comprueba que el `HOME` real queda intacto (`:325`) y que los `.md` viajan en el tarball; que
  el arranque los escriba sigue sin cubrirse.

## P4.5 — Scroll del transcript y ruido del logger

Sección cerrada; el cuerpo narrativo de sus tres ítems vive en
[journal P4.5](../docs/journal/cli/p45-scroll-logger.md). Se conservan aquí como entradas
cerradas (son ítems del TODO, no prosa) y el resumen está en `## Historial`.

- [x] **Medir el transcript en líneas visuales, no en "las últimas 60 entradas"**
Cambió la ventana del transcript de "N entradas" a líneas visuales medidas contra el alto real del terminal, porque el scroll se volvía loco al scrollear mientras se generaba.
Done when: no se fijó uno; el hecho está en el journal.
Depends on: ninguno.
hecho: `cli/src/ui/tui/scroll.ts` — ver [journal P4.5](../docs/journal/cli/p45-scroll-logger.md)

- [x] **Rueda del ratón y arreglo del recorte del transcript**
Habilitó la rueda del ratón vía modo SGR y arregló tres bugs de recorte del render que hacían desaparecer o solaparse líneas.
Done when: no se fijó uno; el hecho está en el journal.
Depends on: ninguno.
hecho: `cli/src/ui/tui/viewport.ts` — ver [journal P4.5](../docs/journal/cli/p45-scroll-logger.md)

- [x] **Silenciar `logger.info`/`warn` del core salvo en modo debug**
Bajó el nivel por defecto del logger del core a `error` para que los `info`/`warn` no se leyeran como conversación, dejándolos visibles solo en `--debug`.
Done when: no se fijó uno; el hecho está en el journal.
Depends on: ninguno.
hecho: `core/src/utils/logger.ts#DEFAULT_LOG_LEVEL` — ver [journal P4.5](../docs/journal/cli/p45-scroll-logger.md)

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
Sustituyó aserciones que comparaban la salida contra la misma función que el adaptador usa por dentro por literales exactos, con barrido de revert.
Done when: `cliAdapter.spec.ts` no importa `formatSpawnOutcome` ni `formatTurnOutcome`,
sus casos comparan con `toBe` el literal completo y el barrido de revert del separador
deja el fichero en rojo.
Depends on: nada.
hecho: `cli/tests/ui/cliAdapter.spec.ts` — ver [journal P5 tests](../docs/journal/cli/p5-renderer-tests.md)

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
Repintó la conversación restaurada en los dos renderers, que hasta entonces seguían mostrando los mensajes de la sesión vieja.
Done when: tras `/resume` la pantalla muestra solo la conversación de la sesión reanudada,
en los dos renderers y sin intervención manual.
Depends on: nada.
hecho: `cli/src/MainLoop.ts#showConversation` — ver [journal P5 `/resume`](../docs/journal/cli/p5-resume.md)

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

Origen (nota original del usuario): «cuando un delegate termine si aun hay trabajo que
hacer la session debe seguir el trabajo que queda no esperar por mi». Está implementado
entero: `SessionManager` encola el resultado del hijo asentado como mensaje `system` y
expone `pendingSpawns()`, y `MainLoop.maybeContinue()` arranca ese turno sin prompt —
solo en TUI, respetando el borrador del usuario y con un tope de 5 continuaciones
automáticas por defecto—. Lo único pendiente es la prueba de humo end-to-end contra los
`.tgz` publicados, que es «Verificar la instalación publicada y decidir el canal
Packages» en §P4.

Los cuatro ítems de la sección están cerrados; su cuerpo narrativo vive en
[journal P6](../docs/journal/cli/p6-auto-continuation.md).

- [x] **Exponer si un hijo asentado dejó trabajo sin entregar**
Dio al CLI la señal que le faltaba para decidir si continuar solo: qué hijos asentados tienen su resultado sin entregar.
Done when: no se fijó uno; el hecho está en el journal.
Depends on: nada; el consumidor del CLI quedó cableado en la tarea siguiente.
hecho: `core/src/session/SessionManager.ts#pendingSpawns` — ver [journal P6](../docs/journal/cli/p6-auto-continuation.md)

- [x] **Arrancar un turno sin prompt cuando un hijo deja trabajo**
Encoló el turno de continuación por el mismo camino que un prompt, solo cuando el hijo deja trabajo y el usuario no está escribiendo.
Done when: no se fijó uno; el hecho está en el journal.
Depends on: exponer si un hijo asentado dejó trabajo sin entregar.
hecho: `cli/src/MainLoop.ts#maybeContinue` — ver [journal P6](../docs/journal/cli/p6-auto-continuation.md)

- [x] **Acotar las continuaciones automáticas**
Puso tope a la cadena automática (default 5, `0`/`false` deshabilitan) para que un hijo que deja trabajo cada vez no gaste tokens sin control.
Done when: no se fijó uno; el hecho está en el journal.
Depends on: arrancar un turno sin prompt cuando un hijo deja trabajo.
hecho: `core/src/configuration/index.ts` (`maxAutoContinuations`) — ver [journal P6](../docs/journal/cli/p6-auto-continuation.md)

- [x] **Contar el turno automático como continuación en el cierre del turno**
Hizo que el cierre del turno diga que la sesión sigue sola, para que el usuario no crea que el proceso quedó parado.
Done when: no se fijó uno; el hecho está en el journal.
Depends on: arrancar un turno sin prompt cuando un hijo deja trabajo.
hecho: `cli/src/ui/outcome.ts#CONTINUING_ALONE_NOTICE` — ver [journal P6](../docs/journal/cli/p6-auto-continuation.md)

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
Sólo se reabre si el gateway existe ([gateway/TODO.md](../gateway/TODO.md)) y aparece un
caso real —varios terminales contra las mismas sesiones, o correr el CLI en otra
máquina—. Para cerrarla hay que decidir qué se gana frente a ejecutar el core
in-process.

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

## Decisiones vigentes

- **Renderer por defecto `CliUiAdapter`, TUI tras `--tui`** — los dos implementan `UiAdapter` y `MainLoop` solo emite eventos, así que toda feature de UI se hace dos veces o en el contrato · §P0
- **ink 8 + React 19** (`jsx: react-jsx`, sin `import React`) — coste de +26 paquetes en producción, aceptado frente a reimplementar layout, scroll y repintado · §P0
- **Franja de hijos única, inferior y colapsable** — si no corre nada la franja no existe; la actividad del turno vive dentro del input, no en la franja · §P0
- **`maxAutoContinuations` por defecto 5** (`0` y `false` deshabilitan) — un hijo que deja trabajo no puede encadenar turnos infinitos · §P6
- **El contador de continuaciones se resetea con input del usuario** (`enqueueFromUser` pone `autoContinuations = 0`) — un prompt humano abre presupuesto nuevo · §P6
- **La continuación automática solo aplica en TUI** (`if (!this.isTui())` en `nextPrompt()`) — el modo líneas nunca arranca un turno que nadie pidió · §P6
- **La continuación no pisa el borrador del usuario** (`continuationDecision` recibe `hasUserDraft` y devuelve `DRAFT_WAITING_NOTICE`) — lo escrito a medias nunca se pierde · §P6
- **El scroll se mide en líneas visuales y respeta `follow`** — contenido nuevo no mueve la vista si el usuario está scrolleado; al empezar un turno vuelve al fondo · §P4.5
- **El nivel por defecto del logger del core es `error`** (`DEFAULT_LOG_LEVEL`) — `logger.info`/`warn` solo aparecen con `--debug`, y en `--tui` el sink del adapter descarta · §P4.5
- **Scope `@racso2609` con el token fuera del repo** — el `.npmrc` versionado solo declara el registry por scope; el PAT se configura con `pnpm config set` · §P4
- **`workspace:^` en la dependencia del core desde el cli** — el tarball publica un rango (`^1.0.0`), no la versión exacta, así un bump del core no obliga a republicar el cli · §P4

## Historial

- §P0 — TUI de pantalla completa: cerrada, [journal](../docs/journal/cli/p0-tui-stack.md)
- §P1 — feedback mientras el turno corre: cerrada, [journal](../docs/journal/cli/p1-turn-feedback.md)
- §P3 — información adicional en el UI: cerrada, [journal](../docs/journal/cli/p3-transcript.md)
- §P4 — empaquetado y publicación (F0): publicada `v1.0.0`; queda la verificación, [journal empaquetado](../docs/journal/cli/p4-packaging.md) y [journal publicación](../docs/journal/cli/p4-publish.md)
- §P4.5 — scroll del transcript y ruido del logger: cerrada, [journal](../docs/journal/cli/p45-scroll-logger.md)
- §P6 — continuación automática tras un hijo: cerrada, [journal](../docs/journal/cli/p6-auto-continuation.md)
- §P5 — `/resume` y los tests del renderer de líneas: cerrados, [journal `/resume`](../docs/journal/cli/p5-resume.md) y [journal tests](../docs/journal/cli/p5-renderer-tests.md)
