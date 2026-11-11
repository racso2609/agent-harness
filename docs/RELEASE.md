# Diseño de `scripts/release.mjs`

> **Estado: diseño, sin implementación.** Este documento describe el script que hay que escribir; no
> existe todavía. Verificado el 2026-11-11: `scripts/` sólo contiene `smoke-install.mjs`. El fichero a
> crear es **`scripts/release.mjs`**, con su lógica repartida en `scripts/release/` (ver el plan de
> implementación). Todo lo que aquí se afirma sobre el repo o el entorno va respaldado por el comando
> que lo comprueba; esas comprobaciones se hicieron antes de escribir el diseño y están listadas abajo.

## El problema en una frase

El procedimiento de publicación es correcto pero vive en prosa, así que se ejecuta de memoria. El
resultado, verificable hoy:

- **`v1.1.2` quedó como borrador** con los assets en URLs `untagged-…`, su tag apunta al commit
  **anterior** al bump (`bf92ae2`, cuyo padre es el merge) y el daño se **empujó** al remoto.
- **`v1.1.1` no tiene release**: está publicada en el registry pero no aparece en `gh release list`.
- **`v1.0.0` es un tag ligero** mientras el resto son anotados.

Un script que encarne el procedimiento y **verifique** el resultado convierte tres errores humanos en
tres fallos de máquina. Y una restricción manda sobre todo el diseño: **`pnpm publish` es irreversible**
(`E409`: no se puede publicar sobre una versión existente). El script no puede publicar por si acaso;
puede _detectar_, _saltar_, _reanudar_ y _parar_, nunca deshacer un push ni un publish.

### El modelo de versiones también estaba mal

Tratar `root`, `core` y `cli` como un solo producto con un solo número es falso en dos puntos
verificables: la raíz es `private: true` (no se publica, su `version` no la lee nadie), y `core` y `cli`
cambian cuando cambia _su_ código. Un script que exige lockstep obliga a publicar tarballs idénticos al
anterior solo para cuadrar números, que es exactamente el tipo de release que engaña al consumidor y
engorda el CHANGELOG con cambios que no existen.

## Estado verificado del entorno

| hecho                                                                                                                                                             | comando                                        | consecuencia para el diseño                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `v1.1.2` es `isDraft: true`, assets en `releases/download/untagged-35ba75f0…/`                                                                                    | `gh release view v1.1.2 --json isDraft,assets` | el chequeo de borrador es obligatorio; el de URL `untagged-` es un tell redundante y barato                                                   |
| tags remotos: `v1.1.2^{}` → `bf92ae2`, local `v1.1.2` → **lo mismo**                                                                                              | `git ls-remote --tags origin`                  | el tag malo se **empujó**; el daño no fue local, así que "verificar antes de empujar" no basta                                                |
| `v1.1.3^{}` → `e82be35` == `HEAD` == `origin/main`                                                                                                                | `git rev-parse`, `git rev-list --left-right`   | comparar refs a pelo **funcionó de casualidad** en v1.1.3; el script no debe depender de eso                                                  |
| `git rev-parse v1.1.3` → `74ef61c` (objeto tag) ≠ commit                                                                                                          | `git rev-parse`                                | todos los chequeos deben usar `^{commit}`; comparar `rev-parse <tag>` con `rev-parse HEAD` **siempre** falla en tags anotados                 |
| `git cat-file -t v1.0.0` → `commit`                                                                                                                               | idem                                           | inconsistencia de tags a corregir (fuera de este script)                                                                                      |
| `v1.1.1` **no tiene release** y no está en `gh release list`                                                                                                      | `gh release list`                              | la "última versión" no puede salir de los releases; sale del registry                                                                         |
| las tres `version` = `1.1.3`; árbol limpio; `main` = `origin/main`                                                                                                | `node -e`, `git status`                        | el punto de partida es sano: el script puede estrenarse sin deuda                                                                             |
| `gh` 2.95.0 con `--verify-tag`, `--draft`, `--target`                                                                                                             | `gh release create --help`                     | `--verify-tag` es la guarda clave: sin ella, un `--target <sha>` inventa el tag                                                               |
| `core/agents/*.md` y `cli/racso-logo.txt` **viven fuera de `src/`** y viajan                                                                                      | `git log -- core/agents`                       | un `revert` del bump de versión **no** puede revertir ficheros de contenido (`agents/`, `skills/`, `racso-logo.txt`)                          |
| raíz sin `devDependencies` de test; `cli/node_modules/.bin/vitest` existe                                                                                         | `ls cli/node_modules/.bin`                     | los tests del script van con `node:test` (builtin), no con vitest                                                                             |
| `gh api /user/packages/npm/@racso2609%2Fcore/versions` → **404**; `/repos/…/packages` → **404**                                                                   | `gh api`                                       | el probe de registry **no** puede ser `gh api` (ver D4)                                                                                       |
| `curl -H "Authorization: Bearer $(gh auth token)" https://npm.pkg.github.com/@racso2609%2Fcore` → **200** con `versions: 1.0.0…1.1.3` y `dist-tags.latest: 1.1.3` | `curl`                                         | el registry por HTTP con el token de `gh` sí responde y da la lista completa + `deprecated`. Es el probe correcto                             |
| `cli/package.json` dice `"@racso2609/core": "workspace:^"`, y el tarball empaquetado dice `"^1.1.3"`                                                              | `pnpm pack` + `tar -xzf`                       | `workspace:^` se resuelve en el tarball, contra la versión del core _en el workspace ahora mismo_. El rango se puede auditar **sin red** (G5) |
| el registry ya tiene `cli@1.1.3` con `dependencies["@racso2609/core"] === "^1.1.3"`                                                                               | mismo probe                                    | el rango publicado y el resuelto en local son comparables: la guarda dura de la dependencia es real, no teórica                               |
| `CHANGELOG.md` tiene **un** `## [X.Y.Z] - fecha` por versión                                                                                                      | `grep '^## '`                                  | el CHANGELOG no dice si una entrada tocó core, cli o los dos (ver preguntas abiertas)                                                         |
| releases `v1.0.0`, `v1.1.0`, `v1.1.3` adjuntan **los dos** `.tgz` (`racso2609-{core,cli}-X.Y.Z.tgz`)                                                              | `gh release view --json assets`                | el esquema de tags es `vX.Y.Z`. Romperlo tiene coste (ver D11)                                                                                |
| `npm view` no corre: `EBADDEVENGINES` (el repo pide pnpm)                                                                                                         | `npm view`                                     | confirma que el probe no puede pasar por `npm`/`pnpm view`; HTTP directo                                                                      |

De aquí sale una ley que el documento entero asume: **el script no puede "deshacer" un push o un
publish**; sólo puede _detectar_, _reanudar_ o _decir exactamente qué comando a mano cierra el hueco_.

## El modelo de versiones

### Una versión por paquete publicable, decidida por ese paquete

Un _release run_ selecciona un conjunto de paquetes a publicar (D3) y, para cada uno, una versión:

```
target = { core?: "1.1.4", cli?: "1.2.0" } // cada clave es independiente
```

La versión de un paquete se decide contra **su** última versión publicada, que sale del registry
(fuente de verdad, única e inequívoca), no del `package.json` del repo ni del último tag:

```js
// scripts/release/versions.mjs
/** @returns {{versions: string[], latest: string|null, deprecated: string[]}} */
export const registryVersions = (deps, pkgName) => …;
```

Porqué el registry y no los tags: `v1.1.1` no tiene release y `v1.1.2` es borrador con el tag mal
apuntado; los tags son una fuente con dos agujeros conocidos. El registry no ha fallado nunca y su
`dist-tags.latest` coincide con lo publicado en los dos paquetes.

### El criterio semántico se deriva de los cambios _de ese paquete_

`classifyChanges` no compara números: dice **si el paquete cambió**, que es lo que hace detectable un
bump vacío.

```js
// scripts/release/versions.mjs — puro
/**
 * @param {string[]} changedPaths // git diff --name-only <tagBase>..<sha>
 * @param {string} pkgDir // "core" | "cli"
 * @returns {{touched: boolean, paths: string[], semverHint: "major"|"minor"|"patch"|"none"}}
 */
export const classifyChanges = (changedPaths, pkgDir) => …;
```

- `touched` = hay algún path bajo `<pkgDir>/`.
- `semverHint` = un **hint**, no una guarda: `patch` si solo hay paths bajo `src/` o `dist/`; `minor` si
  toca `agents/`, `skills/`, `bin/` o `racso-logo.txt` (contenido que viaja y que la gente consume);
  `major` **nunca se infiere** — un cambio de ruptura no se detecta mirando rutas, y fingir que sí sería
  peor que no intentarlo.

`pkgDir` es `root` para lo que queda fuera de `core/` y `cli/`.

### La raíz no se publica, pero sí se reporta

**La raíz no se versiona para publicar, y el script no la toca jamás.** `"private": true` significa que
`pnpm publish` en la raíz falla, así que ninguna guarda sobre su `version` protege nada; y su `version`
la lee exactamente un consumidor cero. Cambiarla es un cambio de fichero sin efecto observable, y hacerlo
por reflejo es lo que obliga a versiones de relleno.

Lo que sí hace el script: **reportarla como observación**, no como fallo.

```
· raíz: private, version 1.1.3 (no se publica; decorativa)
```

Con una excepción explícita y baratísima de detectar: si la raíz tiene `version` mayor que las dos
publicables, `check` da un **aviso** (`E_CHECK` con `severity: "warn"`, no bloqueante en `check`,
bloqueante en `publish` solo si `--strict-root`), porque un número más alto en la raíz que en los
paquetes sugiere que alguien creyó que la raíz se publicaba y el bump real se perdió. Es un `warn`, no un
`fail`: no hay consumidor roto.

### Las guardas que de verdad importan (G1–G5)

Todas puras salvo las que leen el registry, y esas lo reciben inyectado (D2).

**G1 — Regresión de versión (dura, por paquete).**

```js
export const assertVersionAdvances = (pkgName, target, registry, prevTarget) => Result;
```

Falla si `target` ∈ `registry.versions` (ya publicada) o si `semverLt(target, registry.latest)`. Igual o
menor ⇒ `E_CHECK`. **Nunca se publica sobre lo que existe.** Compara contra el mundo, no las tres
versiones entre sí: `assertVersionAdvances("core", "1.1.4", {cli: {latest: "1.2.0"}})` → `ok`.

**G2 — CHANGELOG (dura).**

```js
export const hasChangelogEntry = (changelogText, version) => Result; // "## [X.Y.Z] - " exacto
```

Igualdad de string sobre el heading; `Unreleased` no cuenta.

**G3 — El paquete cambió (dura, sólo informativa para la raíz).**

```js
export const assertTouched = (pkgName, changes) => Result;
```

Si `target` se va a publicar y `changes.touched === false` ⇒ `E_CHECK` con el mensaje `"core no ha
cambiado desde core@1.1.3; publicar 1.1.4 sería un tarball idéntico con otro número"`. Salvo
`--allow-empty-bump`, que existe solo para el caso legítimo de republicar por un fix de metadatos (un
`files:` o un `engines:`) y que imprime un aviso.

**G4 — Orden dentro de un paquete (blanda).** Si `classifyChanges(...).semverHint === "patch"` y
`semverDiff(registry.latest, target) === "minor"`, un `warn`: no se puede probar que falte un minor, pero
casi siempre es un despiste y el coste de preguntar es una línea.

**G5 — La dependencia del cli sobre el core (dura).** Tiene **dos** comprobaciones, no una, porque cada
una ve lo que la otra no:

1. **Local, sin red, sobre el tarball empacado** (`auditTarball`, D3). El manifiesto dentro del `.tgz` ya
   trae `"@racso2609/core": "^1.1.3"` —`workspace:^` se resuelve al empacar, verificado— así que el rango
   se lee de los **bytes que se van a publicar**, no del `package.json` fuente, donde `workspace:^` no
   significa nada fuera del monorepo. Se resuelve el rango contra el conjunto
   `S = registry.versions ∪ {versiones del target}` y se exige que `maxSatisfying(range, S) ≠ null`. Si
   no, `E_CHECK`: _"el tarball del cli declara `@racso2609/core@^1.2.0` y ni el registry ni este run
   publican 1.2.0"_.
2. **Dependencia fijada por mínimo** (`semverMinSatisfying`): si el rango se satisface **solo** por una
   versión que este mismo run va a publicar (no por ninguna del registry), el cli queda ordenado
   **después** del core en `planSteps` — que es la única forma de que el `pnpm publish` del cli no muera
   con `E404` al resolver una dependencia inexistente. Esta es la razón mecánica por la que el orden
   "core antes que cli" deja de ser una convención y pasa a ser un requisito derivado.

```js
// scripts/release/guardas.mjs — puro, sin red
/**
 * @param {string} range // "^1.1.3", ya resuelto en el tarball
 * @param {string[]} publishedVersions // del registry
 * @param {string[]} plannedVersions // las de este run para ese paquete
 * @returns {{ok: true, via: "registry"|"planned", version: string} | {ok:false, code, detail}}
 */
export const assertDependencySatisfiable = (range, publishedVersions, plannedVersions) => …;
```

Porqué los dos y no uno: la comprobación 1 es barata y offline pero ciega al _orden real_ de aparición en
el registry (puede decir "ok, lo satisface 1.2.0" cuando 1.2.0 aún no existe porque este run no lo
publica). La comprobación 2 es la que decide el orden. Juntas: "existe una versión que satisface el
rango, y para cuando el cli se publique, ya está en el registry". Ninguna consulta al registry por
separado — el mismo `registryVersions` alimenta las dos.

**Lo que deliberadamente NO es una guarda:** que el rango del cli apunte a la _última_ del core.
`cli@1.1.4` dependiendo de `core@^1.1.3` cuando el core va por 1.2.0 es **legal y deseable**: no obliga a
nadie a actualizar. Solo se comprueba que el rango se satisfaga.

### CHANGELOG: una entrada por versión publicada, no una por release

Las dos opciones, con su consecuencia:

|                                 | entrada por versión de paquete (`## [1.1.4]`, `## [1.2.0]`) | entrada por release (`## [2026-11-12]` con subapartados por paquete)                   |
| ------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| cómo queda hoy                  | ya es así (una `## [X.Y.Z]`)                                | habría que reescribir las 5 entradas existentes                                        |
| verificación                    | `hasChangelogEntry(text, version)`, exacta                  | hay que parsear subsecciones y atribuir cambios a paquetes                             |
| lector                          | legible como "qué versión hay que subir"                    | más veraz sobre "qué se publicó junto", menos útil para "qué me llevo si subo el core" |
| caso `core@1.1.4` + `cli@1.1.3` | dos entradas, cada una con lo suyo                          | una entrada con un subapartado vacío del cli, o con el cli "sin cambios"               |
| **problema real**               | si un mismo cambio toca los dos, ¿se duplica la prosa?      | la prosa se escribe una vez                                                            |

**Elegido: una entrada por versión de paquete.** Porqué gana pese a la duplicación de prosa:

- El CHANGELOG de este repo es **prosa larga y explicativa**; una entrada por release tendría que decidir
  qué párrafo pertenece a qué paquete _después_ de escribirlo, y esa atribución se hace mal en cuanto la
  entrada pasa de tres bullets. Una entrada por paquete fuerza a decidir la atribución **mientras se
  escribe**, que es cuando el autor la sabe.
- Convierte G2 en una comprobación de igualdad de string, testeable con literales, sin parser. Con
  entrada por release, `hasChangelogEntry` se vuelve un mini-parser de Markdown y el test deja de ser
  hermético y barato.
- Deja el fichero compatible con lo ya publicado: las 5 entradas existentes siguen siendo válidas tal
  cual, sin migración.
- La duplicación es explícita y aceptable: si un cambio afecta a los dos paquetes, aparece en las dos
  entradas, redactado para el lector de cada uno. El estado actual ya lo hace (las entradas de 1.1.x
  hablan de `progress.ts`, `draft.ts`, `mouse.ts` —todo `cli/`— sin distinguir).

**Regla operativa que esto impone:** si en un run se publican `core@1.1.4` **y** `cli@1.1.4`, hacen falta
**dos** entradas de CHANGELOG (`## [1.1.4]` es una sola, así que el caso degenerado es el mismo número —
lo resuelve `hasChangelogEntry`, una entrada sirve a los dos). Si los números difieren, dos entradas.
`check` lo enumera por versión de target y falla por cada una que falte.

## Decisiones, con su porqué

### D1 — Un solo script con subcomandos, no varios

`scripts/release.mjs` con subcomandos `check`, `bump`, `publish`, `tag`, `release`, `verify` (y `go` =
los cinco seguidos). Un solo fichero de entrada por estas razones concretas, no por gusto:

- El procedimiento tiene una **invariante compartida**: `src < tag < release`, siempre sobre el mismo
  commit resuelto. Si `verify` vive en otro script, esa invariante se duplica y deriva — exactamente el
  fallo que produjo v1.1.2 (el tag y el commit del bump divergieron porque nadie los comparó).
- Cada subcomando es un paso del `## Orden de publicación` de `docs/INSTALL.md`. Un subcomando por paso
  hace que el `README` pueda decir "paso 5 → `node scripts/release.mjs tag`" y que la prosa y el código
  no puedan separarse.
- Rechazado: `scripts/release/{check,publish,verify}.mjs` — tres ejecutables, tres parseadores de argv,
  tres formas de reportar, y el estado intermedio tendría que leerse en tres sitios.

La lógica interna sí se reparte en `scripts/release/*.mjs` (D2): "un solo script" se refiere al punto de
entrada, no a un fichero monolítico.

### D2 — _Check_ puro y _publish_ orquestado, separados por una interfaz `deps`

El núcleo del script son **funciones puras** que reciben un objeto `deps` y devuelven un resultado;
`publish` es el ejecutor que las consume.

```js
// scripts/release/guardas.mjs — puras, sin I/O
export const assertVersionAdvances = (pkgName, target, registry, prevTarget) => Result;
export const assertTouched = (pkgName, changes, { allowEmptyBump }) => Result;
export const assertDependencySatisfiable = (range, published, planned) => Result;
export const hasChangelogEntry = (changelogText, version) => Result;
export const classifyChanges = (changedPaths, pkgDir) => ({ touched, paths, semverHint });
export const auditTarball = ({ entries, manifest, constraints }) => Result; // forbidden entries, workspace:, private, name/version
export const parseConflicts = ({ local, remote, commit, pushed }) =>
  "none" | "tag-wrong-commit" | "tag-ok-remote-missing" | …;
export const planSteps = (state) => [{ id, argv, mutates, recovery }, …]; // orden + reanudación

// scripts/release/deps.mjs — el único sitio que toca el mundo
export const createNodeDeps = (opts) => ({ run, readFile, readJson, tmpdir, log });
```

Porqué: el objetivo declarado es que las guardas se prueben **sin red y sin git**. Con esta separación,
cada guarda es una función `(entrada) → {ok, code, detail}` que se testea con literales. Lo único que
cambia en test es `deps.run`, que pasa de `spawnSync` real a un doble que devuelve fixtures (salidas
reales capturadas hoy: `{"isDraft":true,…}`, la salida de `ls-remote`, etc.). `createNodeDeps` recibe
además `{cwd, env}` y un `fetch` inyectable, para que `pnpm`, `gh` y el probe del registry nunca usen el
entorno de red real en los tests.

Rechazado: inyectar sólo `run` y dejar todo lo demás inline — las guardas seguirían leyendo
`CHANGELOG.md` del repo real y los tests no serían herméticos.

### D3 — Los argv de `git`/`gh`/`pnpm` son **datos**, en una tabla `planSteps`

Cada paso es un objeto, no un `spawn` suelto:

```js
{
  id: "push-main",
  kind: "git",
  argv: ["push", "origin", "main"],
  mutates: true,
  retryable: true,
  recoveredBy: "se puede reintentar tal cual",
}
{
  id: "publish-core",
  kind: "pnpm",
  cwd: "core",
  argv: ["publish", "--no-git-checks"],
  mutates: true,
  doneWhen: "published.core",
  recoveredBy: "si salió bien, se salta",
}
```

Porqué: (a) los tests assertan sobre el argv **sin ejecutarlo** — un test puede afirmar "ningún paso
contiene `--target main`" y "el paso `gh-release-create` contiene `--verify-tag` y `--target <sha de 40
hex>`", que son literalmente los dos errores cometidos; (b) la reanudación se calcula recorriendo
`planSteps` contra el estado observado, sin `if` dispersos; (c) el mensaje de recuperación viaja con el
paso que puede fallar, no vive en un `catch` genérico.

### D4 — El estado intermedio se **observa**, no se guarda en un fichero

No hay `release-state.json`. Antes de cada paso, `publish` ejecuta _probes_ y decide. Los probes del run
se reparten en dos capas, porque el modelo de versiones es por paquete pero el commit, el tag y el
release son del run:

```js
// scripts/release/probe.mjs — por paquete
export const probePackage = (deps, pkgName) => ({
  publishedVersions: ["1.1.0", …], // registryVersions, vía fetch + token de gh
  latest: "1.1.3",
});

// scripts/release/probe.mjs — globales del run
export const probeRun = (deps, { tag, commit }) => ({
  mainPushed: isAncestor(deps, commit, "origin/main"),
  tagLocal: tagCommit(deps, tag) ?? null, // ya resuelto a commit
  tagRemote: tagCommit(deps, tag, { remote: true }) ?? null,
  release: { state: "missing" | "draft" | "published", tagName, assets, targetCommitish },
});
```

Sin la separación por paquete, un `--all` no puede saltarse el core ya publicado **sin** saltarse también
el cli pendiente.

Porqué observar y no guardar: un fichero de estado miente en cuanto alguien hace un paso a mano o
re-apunta el tag (que es justo lo que pasó con `v1.1.2`: el estado local y el remoto **coinciden**, pero
los dos están mal). Observar el mundo real es la única fuente que distingue "el core está publicado y el
cli no" de "se publicó todo". Coste: unos milisegundos de HTTP por paso; aceptable en un comando que se
corre una vez por release.

El probe del registry se resuelve con `fetch` al registry de GitHub Packages (`https://npm.pkg.github.com/@racso2609%2F<name>`)
enviando el token que da `gh auth token`:

- `gh api /user/packages/...` **no funciona**: 404 verificado, en las dos rutas probadas.
- `npm view` / `pnpm view` tampoco: `npm view` aborta con `EBADDEVENGINES` dentro del repo, y `pnpm view`
  depende del `~/.npmrc` del usuario y devuelve 404 sin token, ambigüedad que `docs/INSTALL.md` ya dedica
  una tabla entera a diagnosticar.
- HTTP directo con el token de `gh` (que `docs/INSTALL.md` ya documenta con `write:packages`) da 200, la
  lista completa de versiones, `dist-tags.latest` y `deprecated`.

Se hace **una** llamada por paquete y por run, cacheada en el objeto `deps` del run. En `check` ese probe
es **informativo**, nunca bloqueante (ver R4).

### D5 — Idempotencia: cada paso es _skip-if-done_, y el límite son las **dos** publicaciones

`publish` recorre el plan y, por paso:

- **skip** si el probe dice que ya está hecho (la versión de ese paquete ya está en el registry, `main` ya
  contiene el commit, tag correcto en el remoto, release publicado);
- **fail con instrucción** si el estado es inconsistente y no puede arreglarlo solo.

La **unidad de reanudación es el `(paquete, versión)` publicado, no el run**:

| estado al arrancar                            | `--all` hace                                                                                                                                                                                                             | `--core` hace                                                                    | `--cli` hace                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| ninguno publicado                             | publica core, luego cli; push; tag; release; verify                                                                                                                                                                      | publica core; push; tag `v<core>`; release con 1 asset; verify                   | falla G5 si el cli necesita un core que no está; si no, publica cli… |
| `core@X` publicado, `cli@Y` no                | **reanuda**: salta core, publica cli, sigue                                                                                                                                                                              | `release X: ya estaba publicada y verificada. Nada que hacer.` → exit 0 con nota | publica cli, sigue                                                   |
| los dos publicados                            | si todo lo demás está hecho: exit 0 con nota                                                                                                                                                                             | exit 0 con nota                                                                  | ídem                                                                 |
| `core@X` publicado, cli **falla** en este run | no deshace el core; imprime `node scripts/release.mjs publish --cli <Y>` como reanudación exacta                                                                                                                         | n/a                                                                              | n/a                                                                  |
| push OK, tag falla                            | no deshace el push; el commit en `origin/main` sin tag es un estado benigno y **reparable**: `node scripts/release.mjs tag --core X.Y.Z` retoma en el último paso idempotente                                            | ídem                                                                             | ídem                                                                 |
| release creado en borrador                    | **nunca** por construcción (`--draft` no se pasa jamás → `assertNoDraftFlag` lo asserta sobre el plan); si lo encuentra, `verify` falla y `release --publish-draft` lo publica con `gh release edit <tag> --draft=false` | ídem                                                                             | ídem                                                                 |

Porqué el límite está en las publicaciones: `pnpm publish` es la **única** operación irreversible del
procedimiento (`E409`). Push, tag y release son los tres reversibles (`--force-with-lease`,
`git push --delete` + re-tag, `gh release delete`). Por eso el script **nunca** publica antes de haber
validado todo, y **reanuda** en vez de revertir.

### D6 — El snapshot de los `.tgz` es **el mismo** para publicar y para adjuntar

Los tarballs se generan una sola vez (`core/` y `cli/` → `pnpm pack --pack-destination <tmp>`), se auditan
(D2, `auditTarball`), y **esos bytes** son los que se publican (`pnpm publish` en el directorio del
paquete, que ya se empaqueta de nuevo — ver R1) y los que se adjuntan al release. El snapshot se guarda en
`<tmp>/racso-release-<tag>/` —indexado por **tag**, no por versión de paquete, para que dos runs con tags
distintos no se pisen— y su ruta se imprime, para que un `release` ejecutado en otra invocación pueda
reusarlo.

Porqué: los assets del release y lo que hay en el registry tienen que ser la misma cosa. v1.1.2 prueba el
daño de que no lo fueran (assets subidos a un borrador, tag a otro commit).

### D7 — Salida: stdout = progreso e informe; stderr = errores y diagnósticos; códigos por **clase de fallo**

- **stdout**: una línea por paso, con prefijo estable y parseable, igual que `smoke-install.mjs` usa
  ` ok …` / ` FAIL …`:

```
release: agent-harness core 1.1.4 (tag v1.1.4, main @ 1a2b3c4)
ok garantías: árbol limpio, main al día, versiones por paquete, changelog, tag libre
ok build 12s · ok lint 4s · ok test 31s
ok tarballs: core 135 · sin src/tests/TODO · core resuelto a ^1.1.4
· publish core → @racso2609/core@1.1.4
ok publish core
· publish cli — no
FAIL publish core … (stderr el detalle)
```

Al final, un bloque `release: FALLÓ en "publish-core"` con el comando de recuperación copiable, y en el
release una línea de assets: `assets: core-1.1.4.tgz (cli sin cambios desde cli@1.1.3)`.

- **stderr**: la salida de los comandos hijos cuando fallan (`spawnSync`; se imprime **sólo** en fallo,
  como hace `smoke-install.mjs` con `install.stderr`), y los mensajes de invitación a manos humanas en
  modo `--dry-run`.
- **códigos de salida**:

| código | nombre     | significado                                                                  |
| ------ | ---------- | ---------------------------------------------------------------------------- |
| `0`    | —          | ok, o "ya estaba hecho"                                                      |
| `1`    | `E_CHECK`  | fallo de una guarda; no se tocó nada                                         |
| `2`    | `E_USAGE`  | uso incorrecto de argv (sin selector, versión inválida, comando desconocido) |
| `3`    | `E_EXEC`   | fallo de un comando hijo                                                     |
| `4`    | `E_STATE`  | estado intermedio inconsistente que necesita mano humana                     |
| `5`    | `E_VERIFY` | verificación final fallida — **ya se publicó** y hay algo que reparar        |

Que `E_VERIFY` sea distinto de `E_CHECK` importa: en el primer caso ya se publicó. `E_USAGE` no necesita
código propio: reutiliza el `2`.

- **`--json`** en `check` y `verify` para que un futuro CI consuma sin parsear prosa. Barato: `Result` ya
  es estructurado.

### D8 — `verify` compara **objetos resueltos a commit**, siempre

```js
const sha = (rev) => deps.run("git", ["rev-parse", "--verify", `${rev}^{commit}`]).stdout.trim();
```

Comprobaciones, todas sobre `^{commit}` y contra el sha **del bump** (fijado al empezar, no recalculado):

1. `sha("HEAD") === bumpSha` y `sha("origin/main") === bumpSha`;
2. `sha("v X.Y.Z") === bumpSha` (local) y lo mismo con `git ls-remote --tags origin` → la entrada
   `refs/tags/vX.Y.Z^{}` debe existir y ser `bumpSha`; si sólo aparece `refs/tags/vX.Y.Z` sin `^{}`, es
   **tag ligero** → fallo con el aviso de la inconsistencia de `v1.0.0`;
3. `gh release view v X.Y.Z --json isDraft,tagName,assets,targetCommitish` → `isDraft === false`,
   `tagName === "vX.Y.Z"`, `targetCommitish === bumpSha`, **exactamente `assetsOf(target)`** presentes con
   `size > 0` (uno o dos `.tgz`, según lo que publique el run), y sus URLs **no** contienen `untagged-`
   (el tell de v1.1.2);
4. el `package.json` del tarball dentro del release lleva `version` igual a la de ese paquete en el run
   (bajando el `.tgz` del release a tmp y re-leyendo su manifiesto — es el único chequeo que prueba que
   **el asset publicado** es el bueno, no el que teníamos en disco). Se aplica **sólo a los paquetes
   publicados en este run**; el paquete no publicado se verifica contra el registry (`latest`), no contra
   el release.

Porqué el punto 4: v1.1.2 tenía **assets** en el borrador con URLs huérfanas. El release de hoy podría
tener los `.tgz` correctos; nada garantiza que el de mañana los tenga sin bajarlos y mirarlos.

### D9 — `bump` es un paso **explícito y separado**, por paquete, con revert quirúrgico

`bump --core 1.1.4 --cli 1.2.0` — la versión es **por paquete y opcional por paquete**; el subcomando toma
los mismos selectores que `publish` (D3). Sin selector ⇒ `E_USAGE` (exit 2).

- Edita `core/package.json` y/o `cli/package.json` con `JSON.stringify(x, null, 2) + "\n"` (el repo está
  formateado con prettier a 2 espacios, se preserva) **y no toca `package.json` de la raíz**. Si el
  operador quiere mover la raíz, es un edit manual y el script no tiene opinión.
- Corre `pnpm install --lockfile-only` **una vez**, si el lock lleva las versiones del workspace (hoy las
  lista, así que sí).
- Rehúsa con `E_CHECK` si: G1 falla (versión ya publicada o en retroceso), G2 falla (falta la entrada de
  **esa** versión), G3 falla (el paquete no cambió).
- **No commitea**: imprime los ficheros a `git add`. El commit `chore(release): core X, cli Y` lo hace el
  operador, o `go`, que lo hace por él si el árbol sólo tiene esos cambios.

Porqué separado: el commit del bump es el commit que el tag **debe** apuntar, y el error de v1.1.2 fue
exactamente que el tag apuntaba a su padre. Hacer el bump visible y en su propia invocación deja ese
commit en pantalla antes de que nada se publique.

Y una guarda derivada del estado actual del repo: los `.tgz` llevan ficheros de contenido que viven fuera
de `src/` (`core/agents/*.md`, `core/skills/*.md`, `cli/racso-logo.txt`). La recuperación de v1.1.2 sale
del árbol de trabajo, así que `revert <commit-del-bump>` **no** los revierte. Con versiones
independientes esto gana peso: un run puede tocar solo `core/agents/`, declararlo un `minor` (G4) y el
revert quirúrgico es lo único que restaura el árbol. `bump` documenta esto y `planSteps` incluye el aviso:
si hubo que reparar, el revert es

```sh
git revert <bump-sha> -- $(git diff --name-only <bump-sha>^ <bump-sha> | grep -E 'package\.json$|pnpm-lock\.yaml$')
```

nunca un revert pelado.

### D10 — El flag de selección: sin selector, se falla

```
node scripts/release.mjs <cmd> --core [X.Y.Z] [--cli [X.Y.Z]] …   # selectores mutuamente excluyentes con --all
node scripts/release.mjs <cmd> --cli 1.2.0
node scripts/release.mjs <cmd> --all --core 1.1.4 --cli 1.2.0     # --all exige que cada paquete tenga versión
```

- Selectores: `--core`, `--cli`, `--all`. **Sin selector ⇒ exit 2** (`E_USAGE`) con `"di qué publicas:
--core, --cli o --all"`. **Default: fallar.** Un script de publicación que adivina el paquete es un
  script que algún día publica el que no era; el coste de la bandera es una palabra y el coste del default
  implícito es una release irreparable.
- La versión viaja **pegada al selector**: `--core 1.1.4`, `--cli 1.2.0`. No existe un `--version X.Y.Z`
  global: es justo el formato que forzaba el lockstep. `--core` sin versión es legal sólo en `verify` y en
  `publish` (donde la versión se lee del `package.json` del paquete, que es la que `bump` dejó
  commiteada); en `bump` es `E_USAGE`.
- `--tag` permite forzar el nombre del tag (resolución de colisión); `--strict-root` bloquea si la raíz
  tiene un número mayor (el aviso de arriba).

```js
// scripts/release/args.mjs
export const parseArgs = (argv) => ({
  command, // check|bump|publish|tag|release|verify|go
  target: { core: "1.1.4", cli: "1.2.0" }, // cada clave opcional
  selection: "core" | "cli" | "all",
  dryRun,
  json,
  yes,
  allowEmptyBump,
  tag,
});
```

**Qué valida `check` de lo seleccionado.** Dos excepciones deliberadas a "sólo lo seleccionado":

| comprobación                                  | sobre qué corre                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| árbol limpio, rama `main`, `main` al día (R9) | todo el repo (no es por paquete)                                                                                                                                                                                                                                                 |
| build / lint / test (R10)                     | **todo el workspace** (`pnpm -r`), no sólo el seleccionado: el cli importa del core, y un core que compila y un cli que no es un release roto. El coste de correr el test del no-seleccionado es segundos; el coste de no correrlo es publicar el core contra un consumidor roto |
| G1, G2, G3, G4                                | **sólo** el paquete seleccionado — sobre el no seleccionado no hay nada que decidir                                                                                                                                                                                              |
| G5 (dependencia)                              | el cli **siempre que** el core se publique o el cli se publique; si `--core` y el core no cambia su versión, G5 sobre el cli no aporta nada y se salta                                                                                                                           |
| tarball audit (D6)                            | **sólo** los seleccionados (empacar el otro es tiempo y ruido)                                                                                                                                                                                                                   |

`check --all` valida los dos, y es lo que corre antes de `go --all`. Y `check --core <X>` es un run válido
y completo: valida G1–G5, el tarball del core y las invariantes del repo, y **no** dice nada del cli salvo
que su rango siga siendo satisfacible (G5, lo único que el bump del core puede romper). Se puede publicar
sólo uno y `check` lo cubre sin fingir que mira los dos.

### D11 — Modelo de tags: un tag por publicación conjunta, nombrado con la mayor versión

Lo ya publicado: tags `v1.0.0`…`v1.1.3`, releases con **los dos** `.tgz`, `v1.1.1` sin release, `v1.1.2`
en borrador. Las tres escuelas posibles:

**(a) Un tag/release por paquete** — `core@1.1.4`, `cli@1.2.0`, `/releases/tag/core%401.1.4`.
Ventaja: el tag dice exactamente qué se publicó y `verify` no necesita inferir nada; es el esquema que npm
recomienda para monorepos. Coste: **renombrar el esquema** en un repo con 5 tags y 4 releases de otro
tipo; los enlaces existentes siguen vivos pero desde ahora hay dos formatos; `gh release create
core@1.1.4` crea un tag con `@` que en URL se escapa. Y cuando publicas sólo `core`, el cli no tiene
release nuevo: el consumidor del cli que mira `/releases` no ve nada, aunque no haya cambiado. Los tags
viejos son intocables, así que conviven dos convenciones para siempre.

**(b) Un tag/release por publicación conjunta** — `v1.1.4` con lo que lleve dentro (el estado actual).
Ventaja: **cero migración**, el esquema no cambia, los enlaces y el `--latest` siguen funcionando, y "una
release" = "un momento del repo" es lo que ya entiende quien lo usa. Coste: el número del tag es ambiguo
si los dos paquetes llevan versiones distintas, y hay que decidir una regla de nombrado explícita.

**(c) Híbrido**: tag por paquete _y_ un release de repo que agrupa.

**Elegido: (b), con una regla de nombrado explícita.** Porqué:

1. La migración de (a) se paga en un repo cuyo consumidor real es `pnpm add racso-harness` /
   `@racso2609/core`; el release de GitHub es **documentación**, no el canal de distribución. Cambiar el
   esquema de documentación para arreglar un problema de publicación es gastar blast radius en el sitio
   equivocado.
2. El requisito que (a) resuelve —"saber qué versión se publicó"— se resuelve con el **título y las
   notas**, que son texto libre: `v1.1.4 — core 1.1.4, cli 1.2.0`. No hace falta que el tag cargue esa
   información para que el lector la tenga.
3. (c) crea dos releases por publicación y con ello dos sitios donde `verify` tiene que comprobar el mismo
   hecho; el fallo de v1.1.2 fue precisamente un hecho checkeado en un sitio y no en otro.

La regla de nombrado:

```js
// scripts/release/tags.mjs — puro
/** El tag es "v" + la mayor de las versiones que este run publica. */
export const releaseTagName = (target) => "v" + maxSemver(Object.values(target));
```

- Sólo `core@1.1.4` ⇒ tag **`v1.1.4`**, aunque el cli siga en 1.1.3.
- Sólo `cli@1.2.0` ⇒ tag **`v1.2.0`**.
- `core@1.1.4` + `cli@1.2.0` ⇒ tag **`v1.2.0`** (la mayor).
- Colisión: si `v1.2.0` ya existe como tag (porque la publicó el otro paquete), `releaseTagName` **falla**
  con `E_STATE` y nombra el conflicto; el operador resuelve con `--tag v1.2.0-cli` o bumpea. Es el precio
  de (b) y es una línea, no un parser.

**Qué `.tgz` lleva el release cuando sólo se publica el core.** Tres opciones y su consecuencia:

| opción                                     | consecuencia                                                                                                                                                                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sólo el `.tgz` del core                    | el release deja de ser "la foto del repo en ese commit"; quien quiera el cli de ese momento baja el de otro release. **Barato y honesto.**                                                                                                                 |
| los dos, reempaquetando el cli sin cambios | el cli del release es un tarball nuevo con la versión vieja, que **no es** el que publicó nadie; si el `pnpm pack` no es reproducible byte a byte, los assets de dos releases dicen llevar `cli@1.1.3` y difieren. Riesgo puro a cambio de simetría visual |
| ninguno                                    | pierdes el asset que D6 y R11 se molestan en generar                                                                                                                                                                                                       |

**Elegido: sólo los `.tgz` de los paquetes que este run publica** (`assetsOf(target)`). Consecuencia que
`verify` refleja (D8, chequeo 3): el conjunto exacto de assets esperado no es "los dos siempre". Se
documenta en el release con una línea: `assets: core-1.1.4.tgz (cli sin cambios desde cli@1.1.3)`.

Esto también resuelve el caso de un run `--cli`: publica `cli@1.2.0` y el release `v1.2.0` no adjunta el
core, así que nadie puede bajar del release `v1.2.0` un `core@1.2.0` que no existe.

---

## Riesgos R1–R13 y qué hace el script en cada uno

| #   | riesgo                                                                                                                                        | probabilidad            | el script hace                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `pnpm publish` **re-empaqueta** desde el directorio, así que los bytes publicados no son necesariamente los del `.tgz` auditado y adjuntado   | media                   | lo acepta y lo acota: `publish` corre **justo después** de `pack` y **antes** de cualquier paso que toque ficheros; `verify` comprueba que el `package.json` del tarball del release sea el correcto y que el registry tenga la versión. Documentado como límite conocido en el comentario de cabecera del script (mismo estilo que `smoke-install.mjs` explicando por qué existe la comprobación negativa) |
| R2  | core publicado, cli falla (token caducado a mitad, `E409` porque el cli ya estaba)                                                            | baja-media              | no toca el core; `probePackage` en el reintento ve la versión del core ya publicada y **salta** el paso; imprime `node scripts/release.mjs publish --cli <Y>` como recuperación y sale con `E_EXEC`. Nunca "publica el cli primero para compensar"                                                                                                                                                          |
| R3  | push OK, tag falla                                                                                                                            | baja                    | el estado es benigno; el script sale con `E_EXEC` y sugiere `node scripts/release.mjs tag --core X.Y.Z`, que crea el tag anotado con `-a` sobre el sha **explícito** y lo empuja con `--` protegido; `tag` es idempotente (tag local correcto → sólo empuja; tag local ausente → crea; tag local con commit distinto → `E_STATE`, sin `-f`)                                                                 |
| R4  | falta el token de `gh`/registry, o `pnpm publish` apunta a npmjs público                                                                      | media                   | `check` valida la **presencia** del token (`gh auth token` no vacío) y que `@racso2609:registry` resuelva al registry correcto; la _existencia_ de la versión en el registry se consulta sólo si hay token, y si no se puede consultar se **avisa** y se asume "no publicado" (fallar ahí convertiría un `check` sin red en un rojo falso). `publish` sí falla duro si el token falta                       |
| R5  | el release sale borrador (el bug de v1.1.2)                                                                                                   | **nunca por el script** | ningún `argv` del plan contiene `--draft`; `assertNoDraftFlag` lo comprueba en un test; `gh release create` lleva `--verify-tag` (sin él, `--target` **inventa** el tag) y `--target <sha>` de 40 hex, nunca `main` ni una rama; además el `targetCommitish` del release se compara en `verify` contra el sha del bump                                                                                      |
| R6  | tag apuntando al commit anterior al bump                                                                                                      | **detectado**           | `verify` compara `^{commit}` del tag local **y** del remoto contra `bumpSha`; el mensaje nombra la causa ("el tag apunta a `<sha>`; el commit del bump es `<sha2>`") y la reparación (`git push --delete origin vX.Y.Z`, re-tag, `gh release delete`)                                                                                                                                                       |
| R7  | tag ligero (como `v1.0.0`)                                                                                                                    | media                   | `git ls-remote` con `^{}` ausente → `E_VERIFY` con texto que nombra la inconsistencia; el `tag` del script siempre usa `git tag -a vX.Y.Z <sha> -m "…"`                                                                                                                                                                                                                                                     |
| R8  | segunda ejecución sobre la misma versión                                                                                                      | alta                    | `check` da `E_CHECK` desde el registry **por paquete** (G1) antes de llegar a publicar, y también desde el tag existente (local o remoto); `publish` en modo reanudación no duplica nada porque cada paso es skip-if-done; un `publish` con todo publicado y correcto sale `0` con "ya estaba publicada y verificada" — no un `E409` crudo de pnpm                                                          |
| R9  | árbol sucio con cambios de otra rama (hay 6 ramas vivas en el repo)                                                                           | alta                    | `check` exige árbol limpio **y** rama `main` **y** `main` sin commits atrasados respecto a `origin/main` (`git fetch --dry-run` previo) — no basta "no hay nada sin empujar", porque un `main` local _atrasado_ genera assets de un commit que no es el que la gente verá                                                                                                                                   |
| R10 | tests de vitest que fallan intermitentemente                                                                                                  | media                   | `check` corre `pnpm -r lint && pnpm -r test` una vez; si falla, no hay reintento automático (un test flaky reintentado es un test que se ignora). El operador lo ve y decide                                                                                                                                                                                                                                |
| R11 | falta el `.tgz` al invocar `release` por separado (invocación posterior, `tmp` borrado)                                                       | media                   | `release` busca `<tmp>/racso-release-<tag>/` y, si no está, **re-empaqueta y re-audita** (mismo `auditTarball`) antes de adjuntar; nunca adjunta una ruta inexistente                                                                                                                                                                                                                                       |
| R12 | publicar `core@1.1.4` cuando el cli en `main` declara `workspace:^` y alguien instalará el cli de `main` sin republicarlo                     | baja                    | G5 se aplica sobre lo **publicado** y el cli publicado sigue apuntando a un rango satisfecho; el `main` del monorepo no es consumible por nadie                                                                                                                                                                                                                                                             |
| R13 | el tag de la publicación conjunta marca la mayor, así que `v1.2.0` puede contener `core@1.1.4` y quien lea "v1.2.0 = core 1.2.0" se equivoque | media                   | el título del release lo dice (`v1.2.0 — core 1.1.4, cli 1.2.0`) y la guarda de colisión de tags (D11) impide que dos runs distintos compartan tag                                                                                                                                                                                                                                                          |

---

## Firmas de las guardas puras y casos de test obligatorios

`scripts/release/guardas.mjs` (puro, sin I/O, sin red):

```js
// versiones
export const semverLt = (a, b) => boolean;
export const semverDiff = (from, to) => "major" | "minor" | "patch" | "none" | "bump";
export const maxSemver = (versions) => string;
export const releaseTagName = (target) => Result; // D11, falla si la colisión de tag existe
export const classifyChanges = (changedPaths, pkgDir) => ({ touched, paths, semverHint });
// las guardas de versión y dependencia
export const assertVersionAdvances = (pkgName, target, registry, prevTarget) => Result;
export const assertTouched = (pkgName, changes, { allowEmptyBump }) => Result;
export const assertDependencySatisfiable = (range, publishedVersions, plannedVersions) => Result;
// tarball, tags y plan
export const hasChangelogEntry = (changelogText, version) => Result;
export const auditTarball = ({ entries, manifest, constraints }) => Result;
export const parseConflicts = ({ local, remote, commit, pushed }) => "none" | "tag-wrong-commit" | …;
export const assertNoDraftFlag = (steps) => Result;
```

**Casos de test obligatorios** (`guardas.test.mjs`, `node:test`, ningún test importa `child_process` ni
hace red):

_Versiones y registry:_

1. `assertVersionAdvances("core","1.1.4",{versions:["1.1.0","1.1.1","1.1.2","1.1.3"],latest:"1.1.3"})` →
   `ok`. Fixture: el registry real de hoy.
2. **versión ya publicada**: `assertVersionAdvances("core","1.1.3", <fixture de hoy>)` → `fail E_CHECK` con
   `"core@1.1.3 ya está en el registry"`.
3. **versión menor que la publicada**: `assertVersionAdvances("cli","1.1.2",{latest:"1.1.3"})` →
   `fail E_CHECK` con `"1.1.2 es menor que la publicada 1.1.3"`.
4. `assertVersionAdvances` **no** mira otros paquetes: `("core","1.1.4",{cli latest:"1.2.0"})` → `ok`. Es
   la regresión del lockstep, escrita como test.

_Dependencia (G5):_

5. **dependencia no satisfecha**: `assertDependencySatisfiable("^1.2.0", ["1.1.3"], [])` → `fail E_CHECK`,
   mensaje que nombra el rango y la ausencia.
6. `assertDependencySatisfiable("^1.2.0", ["1.1.3"], ["1.2.0"])` → `ok, via:"planned"` (y el plan ordena el
   core antes). Fixture real: el manifiesto dentro de `racso2609-cli-1.1.3.tgz` (`"^1.1.3"`) — prueba de
   que `workspace:^` llega resuelto al tarball.
7. `assertDependencySatisfiable("^1.1.3", ["1.1.0","1.1.3"], [])` → `ok, via:"registry"`.
8. `assertDependencySatisfiable("workspace:^", …)` → `fail E_CHECK`: un `workspace:` en el tarball
   significa que el empacado no resolvió y el paquete publicado es **ininstalable** fuera del monorepo.
   Es la única comprobación que atrapa ese fallo y es un literal.

_Tags y CHANGELOG:_

9. `releaseTagName({core:"1.1.4"})` → `"v1.1.4"`; `({cli:"1.2.0"})` → `"v1.2.0"`;
   `({core:"1.1.4",cli:"1.2.0"})` → `"v1.2.0"`.
10. `hasChangelogEntry(changelog, "1.1.3")` → ok, `"1.1.2"` → ok, `"1.1.9"` → fail, `"Unreleased"` → fail.
    Y sobre un CHANGELOG donde sólo existe `## [1.1.4]`, pidiendo `core@1.1.4`+`cli@1.2.0`: ok para 1.1.4,
    fail para 1.2.0.

_Cambios y bump vacío:_

11. `classifyChanges(["core/src/x.ts"], "core")` → `{touched:true, semverHint:"patch"}`;
    `classifyChanges(["core/agents/a.md"], "core")` → `{semverHint:"minor"}`;
    `classifyChanges(["cli/src/y.ts"], "core")` → `{touched:false}`.
12. `assertTouched("core", {touched:false}, {allowEmptyBump:false})` → `fail E_CHECK`; con
    `allowEmptyBump:true` → ok con aviso.

_Tarballs, conflictos y plan:_

13. `auditTarball` falla si aparece `package/src/` o si el manifiesto es `private`; acepta las entradas
    reales de 135 (core) y 61 (cli) ficheros, y `"@racso2609/core": "workspace:^"` en el manifiesto
    fuente frente a `"^1.1.3"` en el del tarball.
14. `parseConflicts` con `(local bf92ae2, commit e82be35)` → `"tag-wrong-commit"`.
15. `assertNoDraftFlag` sobre toda la tabla de `planSteps` de los tres casos (A, B, C): ningún argv
    contiene `--draft`, ni `--tag`, ni `--target main`.

---

## `planSteps`: firma, orden y las tres tablas de argv

```js
// scripts/release/plan.mjs — devuelve datos, no ejecuta (D3)
/**
 * @param {{target: {core?:string, cli?:string}, sha: string, tag: string,
 *          published: {core: boolean, cli: boolean},
 *          tarballs: {core?: string, cli?: string}}} s
 * @returns {Array<{id, kind, cwd, argv, mutates, doneWhen, recoveredBy}>}
 */
export const planSteps = (s) => …;
```

Reglas de orden que los tests assertan: `pack` antes de `publish` (R1); `publish core` antes de
`publish cli` **cuando G5 diga que el cli necesita el core de este run**; `push` antes de `tag` y `tag`
antes de `release` (D8, R5, R6); un solo `tag` y un solo `release` por run.

**Caso A — `publish --core 1.1.4`** (el cli no se toca, `cli@1.1.3` ya publicado):

| #   | id             | kind     | cwd    | argv                                      | mutates | doneWhen            |
| --- | -------------- | -------- | ------ | ----------------------------------------- | ------- | ------------------- |
| 1   | `build`        | pnpm     | root   | `["-r","build"]`                          | no      | —                   |
| 2   | `lint`         | pnpm     | root   | `["-r","lint"]`                           | no      | —                   |
| 3   | `test`         | pnpm     | root   | `["-r","test","--","--run"]`              | no      | —                   |
| 4   | `pack-core`    | pnpm     | `core` | `["pack","--pack-destination",TMP]`       | no      | —                   |
| 5   | `audit-core`   | internal | —      | `auditTarball(core)`                      | no      | —                   |
| 6   | `publish-core` | pnpm     | `core` | `["publish","--no-git-checks"]`           | **sí**  | `published.core`    |
| 7   | `push-main`    | git      | root   | `["push","origin","main"]`                | sí      | `mainPushed`        |
| 8   | `tag`          | git      | root   | `["tag","-a","v1.1.4",SHA,"-m","v1.1.4"]` | sí      | `tagLocal === sha`  |
| 9   | `push-tag`     | git      | root   | `["push","origin","refs/tags/v1.1.4"]`    | sí      | `tagRemote === sha` |
| 10  | `release`      | gh       | root   | ver abajo                                 | sí      | release publicado   |

```
["release","create","v1.1.4","<TMP>/racso-release-v1.1.4/racso2609-core-1.1.4.tgz",
 "--repo","racso2609/agent-harness","--verify-tag","--target","<SHA 40 hex>",
 "--title","v1.1.4 — core 1.1.4","--notes-file","<TMP>/notes.md","--latest"]
```

**Un solo `.tgz` en el paso 10** (D11). `TMP` = `os.tmpdir()/racso-release-<tag>`, derivado del tag y no
de la versión del paquete, para que dos runs con tags distintos no se pisen.

**Caso B — `publish --cli 1.2.0`** (core intacto en 1.1.3, rango del tarball `^1.1.3`, satisfecho por el
registry ⇒ G5 `via: "registry"`):

| #   | id                    | kind     | cwd   | argv                                                                                                                                  | mutates |
| --- | --------------------- | -------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1–3 | `build`,`lint`,`test` | pnpm     | root  | igual que A                                                                                                                           | no      |
| 4   | `pack-cli`            | pnpm     | `cli` | `["pack","--pack-destination",TMP]`                                                                                                   | no      |
| 5   | `audit-cli`           | internal | —     | `auditTarball(cli, {published: ["…","1.1.3"]})`                                                                                       | no      |
| 6   | `publish-cli`         | pnpm     | `cli` | `["publish","--no-git-checks"]`                                                                                                       | **sí**  |
| 7   | `push-main`           | git      | root  | `["push","origin","main"]`                                                                                                            | sí      |
| 8   | `tag`                 | git      | root  | `["tag","-a","v1.2.0",SHA,"-m","v1.2.0"]`                                                                                             | sí      |
| 9   | `push-tag`            | git      | root  | `["push","origin","refs/tags/v1.2.0"]`                                                                                                | sí      |
| 10  | `release`             | gh       | root  | `… "v1.2.0" "<TMP>/racso-release-v1.2.0/racso2609-cli-1.2.0.tgz" … --title "v1.2.0 — cli 1.2.0" --target <SHA> --verify-tag --latest` | sí      |

**Caso C — `publish --all --core 1.1.4 --cli 1.2.0`**: A ∥ B con las ramas `pack`/`audit`/`publish` por
paquete, en orden `pack-core`, `pack-cli`, `audit-core`, `audit-cli`, **`publish-core`**,
**`publish-cli`**, y un único `push-main`, un único `tag v1.2.0` y un único `release` con **los dos**
`.tgz` (`racso2609-core-1.1.4.tgz`, `racso2609-cli-1.2.0.tgz`). Si G5 dice `via: "planned"`, el orden
core→cli es **obligatorio** y `planSteps` lo garantiza; si dice `via: "registry"`, el orden se mantiene
igual por simplicidad (no hay razón para invertirlo) pero el test lo señala como _no requerido_ en vez de
dejarlo implícito.

**Caso C′ — `--all` con `core@1.1.3` ya publicado y `cli@1.2.0` pendiente**: el plan es el de C **menos**
los pasos cuyo `doneWhen` ya está satisfecho (el `publish` del core y, si procede, el `pack`/`audit` del
paquete ya publicado). Es el caso de reanudación de D5, y el doble de `run` no registra ningún `publish`
en `core/`.

**Sobre `--no-git-checks`**: se mantiene porque el orden ya garantiza `build` antes de `publish` y el árbol
limpio lo garantiza `check`; quitarlo convertiría un fallo de orden en un fallo de `pnpm` al final del
camino.

---

## Plan de implementación

Cada tarea es un commit atómico. Los nombres son los definitivos. Orden: T1 → T2 → T3 → T4 → T5 → T6 → T7.

### T1 — Esqueleto de CLI y utilidades de reporting

- **Ficheros**: `scripts/release.mjs`; `scripts/release/args.mjs`, `scripts/release/report.mjs`.
- `args.mjs`: `parseArgs(argv)` → `{command, target, selection, dryRun, json, yes, allowEmptyBump, tag}`
  con validación estricta: comando desconocido → exit 2, versión no semver → exit 2, **sin selector →
  exit 2** (`E_USAGE`, ver D10). `--help` documenta los selectores y los subcomandos.
- `report.mjs`: `Result` (`ok(value)`, `fail(code, message, {detail})`), `Reporter` con
  `pass/step/fail/summary` que escribe a stdout y errores a stderr, y `--json` que serializa la lista de
  resultados. Códigos de salida de D7 (no se añade `E_USAGE` como código nuevo: es el `2`).
- **Es la tarea que fija la interfaz** que todas las demás consumen.
- **done when**: `node scripts/release.mjs --help` lista los subcomandos y sale con 0;
  `node scripts/release.mjs bogus` sale con 2; `node scripts/release.mjs check` sin selector sale con 2.

### T2 — Guardas puras y sus tests (sin red, sin git)

- **Ficheros**: `scripts/release/guardas.mjs`, `scripts/release/guardas.test.mjs`.
- Funciones: las de la sección de firmas — `semverLt`, `semverDiff`, `maxSemver`, `releaseTagName`,
  `classifyChanges`, `assertVersionAdvances`, `assertTouched`, `assertDependencySatisfiable`,
  `hasChangelogEntry`, `auditTarball`, `parseConflicts`, `assertNoDraftFlag`.
- Tests 1–15 de los casos obligatorios, con fixtures capturados hoy: los pegotes de `gh release view`, la
  salida de `ls-remote --tags`, entradas de tarball de 135 y 61 ficheros, manifiestos con y sin `private`,
  `"@racso2609/core": "workspace:^"` frente a `"^1.1.3"`, el CHANGELOG real de `v1.1.3`, el JSON del
  registry (vía `fetch` con el token de `gh`) de los dos paquetes y el manifiesto extraído de
  `racso2609-cli-1.1.3.tgz`.
- **done when**: `node --test scripts/` verde y ningún test importa `child_process`.

### T3 — `deps` y `check`

- **Ficheros**: `scripts/release/deps.mjs`, `scripts/release/probe.mjs`, `scripts/release/check.mjs`,
  `scripts/release/check.test.mjs`.
- `createNodeDeps({cwd, env, fetch})` → `{run(cmd, argv, opts) → {status, stdout, stderr}, readJson,
readFile, tmpdir, log}`; `createFakeDeps(reglas)` en el test, con `reglas` como mapa
  `"git rev-parse --verify v1.1.4^{commit}" → {status:1, stderr:"…"}` y un `fetch` doble para el registry.
- `probe.mjs`: `registryVersions(deps, pkgName)` (una llamada por paquete y run, cacheada en `deps`),
  `probePackage` y `probeRun` (D4). El token se obtiene con `deps.run("gh", ["auth","token"])` y se envía
  en la cabecera del `fetch` a `https://npm.pkg.github.com/@racso2609%2F<name>`.
- `check.mjs` compone las guardas puras con los probes según la tabla de D10: árbol limpio, rama `main`,
  sin atraso respecto a `origin/main`, G1–G4 por paquete seleccionado, G5 sobre el cli, build/lint/test de
  todo el workspace, tarballs de los seleccionados. R4 se mantiene: sin token, aviso y no rojo.
- **done when**: los 12 casos de `check.test.mjs` pasan con `createFakeDeps` y
  `node scripts/release.mjs check --core 1.1.4` sale 0 sobre un clon temporal con `1.1.4` inexistente;
  sobre `--core 1.1.3` debe fallar por versión ya publicada (G1).

### T4 — `planSteps`, `probePublish` y `publish`

- **Ficheros**: `scripts/release/plan.mjs`, `scripts/release/publish.mjs`, `scripts/release/plan.test.mjs`.
- `planSteps({target, sha, tag, published, tarballs})` devuelve el orden de las tablas A/B/C con
  `{id, kind, cwd, argv, mutates, doneWhen, recoveredBy}`; `publish` recorre el plan con los probes.
- **Tests**: (a) ningún `argv` contiene `--draft`, ni `--tag`, ni `--target main`; (b) `gh release create`
  contiene `--verify-tag` **y** `--target <40 hex>`; (c) `publish-core` aparece **antes** que
  `publish-cli`; (d) `push` antes de `tag`, y `tag` antes de `release`; (e) con `published.core: true`,
  `published.cli: false` sólo se ejecutan los pasos del cli (el doble de `run` registra los comandos y se
  asserta sobre esa lista); (f) un `run` que falla en el cli detiene el bucle y el mensaje final nombra
  `publish-cli`; (g) `--core` genera un plan con **un solo** `.tgz` en `release`; (h) `--cli` con G5
  `via:"planned"` ordena `publish-core` antes que `publish-cli`; (i) `--all` con `published.core: true`
  salta el paso del core y el doble de `run` no registra ningún `publish` en `core/`.
- **done when**: `publish --core 1.1.4 --dry-run` imprime todos los argv en orden con el sha real de
  `HEAD` (`e82be35…`) y **no** ejecuta nada mutante (sólo corre los pasos de lectura).

### T5 — `bump`, `tag`, `release`

- **Ficheros**: `scripts/release/bump.mjs`, `scripts/release/tag.mjs`, `scripts/release/release.mjs` + un
  `.test.mjs` por cada uno.
- `bump`: por paquete, valida G1+G2+G3+G4 de cada seleccionado, edita `core/package.json` y/o
  `cli/package.json` con `JSON.stringify(x, null, 2) + "\n"` (prettier a 2 espacios, se preserva), corre
  `pnpm install --lockfile-only` y **no** toca la raíz (D9). Rehúsa con `E_CHECK` si
  `semverDiff(prev, next)` da `"none"`, si el tag existe o si falta la entrada del CHANGELOG (con
  instrucción de añadirla).
- `tag`: usa `releaseTagName(target)`; `git tag -a vX.Y.Z <sha> -m "vX.Y.Z"` con el sha pasado
  explícitamente; rechaza `--target` y `main`; rechaza re-tag (`E_STATE`, sin `-f`).
- `release`: `gh release create vX.Y.Z <assetsOf(target)> --repo racso2609/agent-harness --verify-tag
--target <sha> --title "v<tag> — core X, cli Y" --notes-file <tmp> --latest`; en modo reanudación, si el
  release existe como borrador, `gh release edit vX.Y.Z --draft=false`.
- **Tests**: argv exactos por regex sobre la tabla; `tag` nunca emite `-f`; `bump --core 1.1.3` sobre
  `1.1.3` → `E_CHECK`; el commit del bump no incluye la raíz.

### T6 — `verify` y el cableado `go`

- **Ficheros**: `scripts/release/verify.mjs`, `scripts/release/verify.test.mjs`, `scripts/release.mjs`
  (dispatch).
- `verify` con los cuatro chequeos de D8 (assets = `assetsOf(target)`; el chequeo 4 sólo sobre los
  paquetes publicados en este run); `go` = `check --<sel> → build → pack+audit → publish → push → tag →
release → verify`.
- **Tests**: el caso canónico del bug — `gh release view` devuelve `{"isDraft":true,…}` ⇒ `E_VERIFY` y el
  mensaje contiene `untagged-` y `--draft=false`; tag local `bf92ae2` vs `commit e82be35` ⇒ `E_VERIFY` que
  nombra ambos shas; `ls-remote` con `refs/tags/vX.Y.Z` sin `^{}` ⇒ tag ligero.
- **done when**: `node --test scripts/` verde; `node scripts/release.mjs verify --core 1.1.3 --cli 1.1.3`
  pasa sobre el repo real (el release de 1.1.3 es correcto y no es borrador) y `verify --core 1.1.2`
  **falla** nombrando el borrador — es la prueba de fuego del script contra el bug real.

### T7 — Scripts de `package.json` y enlace desde `docs/INSTALL.md`

- **Ficheros**: `package.json` (raíz), `docs/INSTALL.md` (sección `## Orden de publicación`).
- Añadir `"release:check": "node scripts/release.mjs check"`, `"release": "node scripts/release.mjs go"`,
  `"test:scripts": "node --test scripts/"`. En `INSTALL.md`, cada paso numerado cita su subcomando y una
  línea al principio del apartado: _"esto es lo que ejecuta `scripts/release.mjs go`; los comandos de
  abajo son lo que el script corre por ti"_, más _"los paquetes se publican por separado; `core` y `cli`
  pueden llevar versiones distintas y el tag es la mayor de las dos"_ — la prosa deja de ser la única
  fuente y pasa a ser el manual del script.
- **done when**: `pnpm release:check` sale 0/falla igual que `node scripts/release.mjs check`;
  `pnpm test:scripts` verde.

---

## Lo que queda fuera, y por qué

- **CI (`.github/workflows/`)**: hoy no hay ninguno. Publicar desde CI exige resolver el conflicto entre
  _quién tiene el token con `write:packages`_ y _quién tiene el bump commiteado en `main`_, y eso es una
  decisión de flujo (PR + tag en merge, o bot). Añadir CI ahora duplicaría el procedimiento antes de haber
  estabilizado el script. Cuando exista, `check --json` y `verify --json` son su interfaz, ya previstos en
  D7.
- **Generar el CHANGELOG automáticamente**: el CHANGELOG de este repo es prosa larga y explicativa por
  entrada (mira `[1.1.3]`), no una lista de commits. Un generador produciría entradas peores que las
  humanas. El script sólo **verifica** que la entrada existe.
- **Firma (sigstore / GPG del tag)**: sin decisión sobre claves y sin consumidores que verifiquen, es
  ceremonia. `git tag -a` es lo mínimo y lo que ya usan `v1.1.0`–`v1.1.3`.
- **Arreglar el historial** (`v1.0.0` ligero → anotado; el `v1.1.2` como borrador y su tag mal apuntado):
  es una operación **destructiva sobre refs publicadas**. El script sólo la **reporta** en `verify` y
  sugiere los comandos. Hacerla a mano, una vez, con el script delante. Con versiones independientes sigue
  siendo un hecho a reparar a mano, y su versión **está en el registry** para los dos paquetes, así que G1
  nunca la reutilizará: correcto por construcción.
- **Ejecutar `smoke:install` dentro de la release**: instala con `npm` fuera del workspace y tarda; meterlo
  en el camino crítico hace que una release tarde minutos en una operación de red ajena al procedimiento.
  Queda como paso manual documentado (y `smoke:install` ya existe y pasa); encadenarlo es una tarea
  futura, no de este script.
- **Rollback automático**: el script no deshace publicaciones ni refs. Sólo reanuda o para. Ver D5.

---

## Preguntas abiertas

1. **¿`bump` commitea?** Recomendación: **no** commitea (deja el commit del bump en pantalla antes de que
   nada se publique); `go` sí commitearía con un mensaje fijo `chore(release): core X, cli Y`. Si el flujo
   preferido es que **todo** lo haga el script, `go` debe incluir el commit y la pregunta desaparece. La
   decisión hay que tomarla antes de T5, porque el mensaje del commit lleva qué paquetes.
2. **Atribución en el CHANGELOG cuando los números difieren.** D11 elige una entrada por versión de
   paquete, pero el fichero no tiene marca de "a qué paquete pertenece esta entrada" más allá del texto.
   ¿Se añade una línea `Paquetes: core, cli` bajo el heading (barato de parsear, y `hasChangelogEntry`
   podría verificarla), o se confía en la prosa? Recomendación: **confiar en la prosa ahora**, porque un
   campo parseable abre la puerta a "esta entrada no menciona el cli" y eso es una guarda que se rompe con
   el primer cambio compartido.
3. **¿Se permite un rango de core en el cli que ya no se podrá satisfacer?** Caso: `cli@1.2.0` declara
   `^1.1.3`, el core va por `1.1.4`. G5 dice ok (1.1.3 existe). ¿Debe el script _avisar_ de que el cli no
   se beneficia del fix del core? Recomendación: aviso, nunca fallo — es una decisión de producto, no de
   integridad.
4. **Semver automático.** G4 sólo avisa. ¿Quieres un `bump --from-git` que proponga `patch`/`minor` a
   partir de `classifyChanges`, o el número lo decide siempre el humano? Recomendación: **humano**, con el
   hint en pantalla; automatizar el número en un repo cuya regla de `minor` es "tocar `agents/`" inventa
   una política que nadie ha discutido.
5. **El tag cuando los dos paquetes publican el mismo número** (`core@1.1.4` + `cli@1.1.4`):
   `releaseTagName` da `v1.1.4`, sin conflicto con el esquema actual. ¿Hay algún caso en el que quieras
   forzar un prefijo (`v1.1.4-core`) para distinguirlo de un tag lockstep histórico? Recomendación: no; el
   título del release ya lo dice y añadir sufijos rompe `--latest` y los enlaces.
6. **¿Los `.tgz` del release tienen que ser byte-idénticos a los del registry?** R1 lo hace imposible
   garantizarlo sin descargar lo publicado. Con `--core` solo, la tentación de reempaquetar el cli "para
   que el release lleve los dos" es exactamente lo que D11 rechaza; si algún día alguien la pide, la
   respuesta barata es descargar el `.tgz` del registry y adjuntarlo **sin reempaquetar**. Merece
   decidirse ahora, porque cambia el paso 10 de las tablas de `planSteps`.
