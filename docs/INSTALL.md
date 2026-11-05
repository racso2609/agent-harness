# Instalación y publicación

Documento de decisión y plan. No describe el estado actual del repo: describe los cambios que hay que
aplicar para que `@racso2609/core` y `@racso2609/cli` se puedan instalar desde fuera del workspace. Todo lo
verificado con el repo o con el entorno va marcado con el fichero o el comando que lo respalda; lo que
no se pudo verificar está al final, bajo `## Notas de verificación`.

## Veredicto

Se publica en **GitHub Packages** con scope `@racso2609` y, además, se adjuntan los `.tgz` en
**GitHub Releases** como canal sin token.

- **GitHub Packages** es el canal "de paquete": `@racso2609/core` y `@racso2609/cli` resolubles con
  `pnpm add` / `npm i`. Exige que el scope coincida con el dueño del paquete: `gh api orgs/racso` →
  `404` ("Not Found"), así que la organización `racso` no existe y el scope `@racso` es inválido;
  el dueño real del repo es `racso2609` (`git remote -v` → `git@github.com:racso2609/agent-harness.git`).
- **GitHub Releases** es el canal sin fricción: los mismos `.tgz` colgados de un release se instalan
  con un `npm i https://github.com/.../racso2609-core-1.0.0.tgz` y **no requieren token**, ni `.npmrc`, ni
  cuenta de GitHub. GitHub Packages **sí exige token incluso para un paquete de un repo público**
  (`curl -s -o /dev/null -w "%{http_code}" https://npm.pkg.github.com/@racso2609/core` → `404` sin
  auth; el repo es público: `gh api repos/racso2609/agent-harness --jq .private` → `false`).
- El registry de GitHub Packages responde `404` hoy porque no hay nada publicado todavía: es lo
  esperado antes del primer `publish`, no un error a depurar.

Decisiones de empaquetado (cada una con su razón):

1. **`files` explícito en los dos paquetes.** Hoy ningún `package.json` lo declara y `pnpm pack` mete
   el árbol entero: `core/` → **205 ficheros / 181 KiB** (`src/`, `tests/`, `TODO.md`,
   `scripts/omniroute.ts`, `eslint.config.ts`, `vitest.config.js`, `tsconfig.json`, `CONTRACT.md`,
   prefijos `@/` sin reescribir); `cli/` → **123 ficheros / 210 KiB**. Con `files` la estimación es
   **135 ficheros / 82 KB** en el core y **61 ficheros / 80 KB** en el cli, medidos con `pnpm pack`
   sobre una copia con el `files` propuesto (ver `## Notas de verificación`).
2. **Quitar `private: true` del cli.** Hoy `cli/package.json` lo declara y `pnpm publish` aborta con
   `[EPRIVATE] This package has been marked as private` (reproducido en `/tmp`); `npm publish` lo
   ignora y publicaría igual, que es peor: publicar por accidente.
3. **`workspace:*` → `workspace:^` en la dependencia del core en el cli** (el paquete del core, hoy
con scope `@racso` y tras la decisión 6 `@racso2609/core`). `pnpm pack` reescribe
 `workspace:*` a la versión **exacta** (`"@racso2609/core": "1.0.0"`, comprobado en el `package.json`
   del tarball) y `workspace:^` a **`^1.0.0`**. Con `*` cualquier publicación del core deja al cli
   apuntando a una versión concreta y obliga a republicar el cli para cada bump del core.
4. **`engines.node` en los dos paquetes.** Ninguno lo declara hoy, así que nada impide instalar en un
   Node que no soporta las dependencias: `ink@8` y `terminal-image@5` declaran `"node": ">=22"`
   (`node_modules/.pnpm/ink@8.0.0*/node_modules/ink/package.json` y
   `node_modules/.pnpm/terminal-image@5.0.1/.../package.json`), y el core usa `import.meta.dirname`
   (p. ej. `core/src/agents/seed.ts`), que requiere `>=20.11`. Sin `engines`, el fallo aparece en
   runtime (o en el `devEngines` del consumidor), no en la instalación.
5. **Publicar siempre con `pnpm`, nunca con `npm`.** `pnpm pack` reescribe `workspace:*`/`workspace:^`;
   `npm pack` **conserva `"workspace:*"` literal** en el `package.json` del tarball, y ese tarball no
   se puede instalar. Además `npm` no funciona dentro del repo: `npm pkg get name` aborta con
   `EBADDEVENGINES` porque la raíz declara `devEngines.packageManager = pnpm` (`package.json`).
   Dentro del repo, siempre `pnpm`; `npm` sólo fuera del repo (instalación del usuario).
6. **Scope renombrado a `@racso2609`.** El paquete del core con su scope actual no se puede publicar
en GitHub Packages: el registry exige `@<dueño>/<paquete>` y el dueño del repo es `racso2609`.

## Cambios por fichero

| fichero                                           | cambio exacto                                                                                                                                                                                                                                  | por qué                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/package.json` | `"name": "@racso2609/core"` (hoy, con scope `@racso`) | GitHub Packages exige scope = dueño del repo; `orgs/racso` no existe (404). |
| `core/package.json`                               | añadir `"files": ["dist", "agents", "skills"]`                                                                                                                                                                                                 | Sin `files` el tarball incluye `src/`, `tests/`, `TODO.md`, `CONTRACT.md` ×2, configs y 42 `.map`. `agents/` y `skills/` **deben** viajar: `core/src/agents/seed.ts` y `core/src/skills/seed.ts` las leen con `bundledAgentsDir()`/`bundledSkillsDir()` = `path.join(import.meta.dirname, "..", "..", "agents"\|"skills")`, que en `dist/agents/seed.js` resuelve a la raíz del paquete.                                                                                                                              |
| `core/package.json`                               | añadir `"engines": { "node": ">=20.11" }`                                                                                                                                                                                                      | `import.meta.dirname` (semillas y build) exige `>=20.11`; el core solo no necesita `22` porque `terminal-image` sale de sus dependencias (fila siguiente).                                                                                                                                                                                                                                                                                                                                                            |
| `core/package.json`                               | **mover** `terminal-image` de `dependencies` a `devDependencies` (o borrarlo)                                                                                                                                                                  | `grep -rn "terminal-image" core/src` no devuelve nada: lo único que lo usa es `cli/src/terminal/stdin.ts:3` (`import terminalImage from "terminal-image"`) para `printImage`, y el cli ya lo declara en sus propias `dependencies`. Mantenerlo en el core obliga a todo consumidor del SDK a instalar `jimp`, `term-img` y `@sindresorhus/gifkit` para nada. Efecto en tamaño: sale del árbol de dependencias del core; en el cli no cambia nada porque ya está declarado allí.                                       |
| `core/package.json`                               | **borrar** `tsconfig-paths` de `dependencies`                                                                                                                                                                                                  | No hay ningún `import` de `tsconfig-paths` en `core/src`, `core/tests`, `core/scripts`, `core/vitest.config.js` ni `core/eslint.config.ts` (`grep -rn tsconfig-paths core/src core/tests core/scripts ...` → vacío). La resolución de `@/*` ya la hace `tsc-alias -f` en build-time (`build: "tsc && tsc-alias -f"`, `core/tsconfig.json` → `paths: { "@/*": ["./src/*"] }`), así que en runtime no hace falta loader ni `tsconfig-paths`. Efecto en tamaño: una dependencia de producción menos en el SDK instalado. |
| `cli/package.json` | `"name": "@racso2609/cli"` (hoy, con scope `@racso`) | Mismo motivo de scope que el core. |
| `cli/package.json`                                | **quitar** `"private": true`                                                                                                                                                                                                                   | Con `private: true` `pnpm publish` aborta con `[EPRIVATE]`; además `private: true` es lo que hace que `npm publish` publique sin avisar.                                                                                                                                                                                                                                                                                                                                                                              |
| `cli/package.json`                                | añadir `"files": ["dist", "bin", "racso-logo.txt"]`                                                                                                                                                                                            | Sin `files` el tarball son 123 ficheros (incluye `src/`, `tests/`, `TODO.md`, configs). `bin/run.mjs` es el entrypoint declarado en `bin`, y `racso-logo.txt` lo lee `cli/src/terminal/stdin.ts:265` con `path.join(import.meta.dirname, "..", "..", "racso-logo.txt")`, que desde `dist/terminal/stdin.js` cae en la raíz del paquete.                                                                                                                                                                               |
| `cli/package.json`                                | añadir `"engines": { "node": ">=22" }`                                                                                                                                                                                                         | `ink@8` y `terminal-image@5` declaran `>=22`; el cli no puede prometer menos.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `cli/package.json` | `"@racso2609/core": "workspace:^"` (hoy el core con scope `@racso` y `workspace:*`) | `pnpm pack` reescribe `workspace:^` a `^1.0.0`, así un bump del core no obliga a republicar el cli. |
| `.npmrc` (raíz del repo, para publicar)           | `@racso2609:registry=https://npm.pkg.github.com`<br>`//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}` | Sin registry por scope, `pnpm publish` va a `registry.npmjs.org` (`📦 @racso/cli@1.0.0 → https://registry.npmjs.org/`, salida real de `pnpm publish --dry-run`). El token va en variable de entorno, **nunca en claro** en el fichero: el `${GITHUB_TOKEN}` lo expande pnpm/npm desde el entorno.                                                                                                                                                                                                                     |
| `cli/src/**`, `cli/tests/**`, `cli/bin/**` (22 ficheros) | `@racso/core` → `@racso2609/core` en imports y mocks, y recompilar (hoy `cli/dist/main.js` emite `import { setLoggerLevel } from "@racso/core"`) | **Requisito del rename de scope**, no una opción: `grep -rln "@racso/core" cli/src cli/tests cli/bin` → 22 ficheros, y `tsc && tsc-alias -f` no reescribe imports de paquetes (sólo los alias `@/*`). Con el paquete llamado `@racso2609/core`, un `dist` sin recompilar importa un paquete que no existe y el canal de Releases queda roto: **el `dist` deja de ser válido hasta recompilar**. |
| `.npmrc` del usuario (consumo de GitHub Packages) | `@racso2609:registry=https://npm.pkg.github.com`<br>`//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}`                                                                                                                                         | GitHub Packages exige auth incluso para paquetes de un repo público; sin este `.npmrc` el `add` termina en 404. `GITHUB_TOKEN` debe ser un PAT con `read:packages` (`gh auth token` sirve el del `gh`).                                                                                                                                                                                                                                                                                                               |

JSON propuesto, completo para los dos `package.json` (sólo los campos que cambian; el resto queda igual):

```jsonc
// core/package.json
{
  "name": "@racso2609/core",
  "files": ["dist", "agents", "skills"],
  "engines": { "node": ">=20.11" },
  "dependencies": {
    "dotenv": "^18.0.9",
    "pino": "^10.4.0",
    "pino-pretty": "^13.2.0",
  },
}
```

```jsonc
// cli/package.json
{
  "name": "@racso2609/cli",
  // "private": true,  ← fuera
  "files": ["dist", "bin", "racso-logo.txt"],
  "engines": { "node": ">=22" },
  "dependencies": {
    "@racso2609/core": "workspace:^",
    "ink": "^8.0.0",
    "react": "^19.3.1",
    "terminal-image": "^5.0.1",
  },
}
```

Lo que **no** cambia y conviene no tocar: `main`/`types`/`exports` del core apuntan a `dist`
(`./dist/index.js`, `./dist/index.d.ts`), `bin.racso-harness` = `./bin/run.mjs` y `main` del cli =
`./dist/main.js`; `tsc` emite con `declaration: true` y `sourceMap: true` (`core/tsconfig.json`), y
`build: "tsc && tsc-alias -f"` deja `dist` sin `@/` (en el `.tgz` actual `cli/dist/main.js` ya importa
`"./terminal/stdin.js"`, no `@/terminal/stdin`).

## Orden de publicación

Desde la raíz del repo. `npm` no funciona aquí (`EBADDEVENGINES`), todo con `pnpm`.

1. **Construir.** El tarball sólo lleva `dist`, y `dist` está en `.gitignore` (`core/.gitignore`,
   `cli/.gitignore`): si no se construye, el paquete sale vacío.
   ```bash
   pnpm -r build
   ```
2. **Comprobar el tarball antes de publicar** (local, sin red):
   ```bash
   rm -rf /tmp/rel && mkdir -p /tmp/rel
   cd core && pnpm pack --pack-destination /tmp/rel && cd ..
   cd cli  && pnpm pack --pack-destination /tmp/rel && cd ..
   tar -tzf /tmp/rel/racso2609-core-1.0.0.tgz | sort
   tar -tzf /tmp/rel/racso2609-cli-1.0.0.tgz  | sort
   ```
   Esperado, con el `files` propuesto: core **135** entradas — `package/package.json`,
   `package/dist/**` (126, 42 de ellas `.map`), `package/agents/*.md` (6) y `package/skills/*.md` (2);
   cli **61** entradas — `package/package.json`, `package/dist/**` (58, 29 `.map`),
   `package/bin/run.mjs`, `package/racso-logo.txt`. Si aparece `package/src/`, `package/tests/` o
   `package/TODO.md`, el `files` no está aplicado y el resto del orden sobra.
   Además, dentro del tarball del cli: `tar -xzf /tmp/rel/racso2609-cli-1.0.0.tgz -O package/package.json`
   debe mostrar `"@racso2609/core": "^1.0.0"` (no `workspace:*`) y **ningún** `"private": true`.
3. **Antes de publicar: `.npmrc` y rename de imports del cli.** Las dos cosas son requisitos del
rename de scope, no opcionales (fila correspondiente en `## Cambios por fichero`):
```bash
printf '@racso2609:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}\n' > .npmrc
grep -rl '@racso/core' cli/src cli/tests cli/bin | xargs sed -i '' 's|@racso/core|@racso2609/core|g'
pnpm --filter @racso2609/cli build
```
Sin el rename + recompilación, el `dist` del cli sigue importando `@racso/core` (hoy
`cli/dist/main.js` → `import { setLoggerLevel } from "@racso/core"`) y el canal de Releases queda roto.
Tras este paso, el paso 2 debe mostrar `"@racso2609/core": "^1.0.0"` en el `package.json` del tarball
del cli.
4. **Publicar, en orden: primero el core, después el cli** (el cli depende de él).
   ```bash
   export GITHUB_TOKEN=$(gh auth token)
   cd core && pnpm publish --no-git-checks && cd ..
   cd cli  && pnpm publish --no-git-checks && cd ..
   ```
   `pnpm publish` publica en `https://npm.pkg.github.com` gracias al `.npmrc` de la raíz
   (`publishConfig.registry` también valdría, pero el `.npmrc` es lo que este plan propone).
   Prueba en seco, útil la primera vez: `pnpm publish --dry-run --no-git-checks` en cada paquete.
   Republicar la misma versión falla con `E409`/`Cannot publish over the previously published
versions`; hay que subir `version` antes.
4. **Crear el release con los `.tgz` adjuntos** (canal sin token):
   ```bash
   gh release create v1.0.0 \
     /tmp/rel/racso2609-core-1.0.0.tgz \
     /tmp/rel/racso2609-cli-1.0.0.tgz \
     --repo racso2609/agent-harness \
     --target main \
     --title "v1.0.0" \
     --notes "@racso2609/core@1.0.0 + @racso2609/cli@1.0.0"
   ```
   Tag y versión de los paquetes deben coincidir con lo que se publicó; si no, los `.tgz` del release
   y lo del registry divergen.

## Smoke test

Hoy no existe: nada en el repo instala los paquetes fuera del workspace. Guion mínimo, en un directorio
temporal, sin tocar el repo:

```bash
mkdir -p /tmp/racso-smoke && cd /tmp/racso-smoke
npm init -y

# 1) El SDK se importa desde fuera del workspace.
npm i /tmp/rel/racso2609-core-1.0.0.tgz
node -e 'import("@racso2609/core").then((m) => console.log(typeof m.createHarness))'
#    → function

# 2) El CLI instala binario, dependencia del core y arranca.
npm i /tmp/rel/racso2609-cli-1.0.0.tgz /tmp/rel/racso2609-core-1.0.0.tgz
ls -l node_modules/.bin/racso-harness
node node_modules/@racso2609/cli/bin/run.mjs --version   # ver nota abajo sobre --version

# 3) Primer arranque con HOME propio, para no pisar el real.
HOME=/tmp/racso-smoke-home node -e '
  import("@racso2609/core").then((m) => {
    new m.Config().writeConfig();
    const h = m.createHarness();
    console.log("harness:", typeof h);
  });'
find /tmp/racso-smoke-home/.racso-harness -maxdepth 2
#    → config.json, agents/*.md, skills/*.md (y sessions/ en cuanto se persiste una sesión)
```

Aislamiento: `HOME=/tmp/...` desvía `harnessHome()` (`core/src/utils/env.ts` → `$HOME/.racso-harness`),
o directamente las variables de relocalización de la sección siguiente. `npm i` de dos tarballs
**a la vez** falla antes de publicar (npm va al registry a resolver `@racso2609/core@1.0.0`); tras el
`publish` funciona, y mientras tanto se instalan por separado, como arriba.

### Qué falla y cómo se ve

| rotura                                                                                         | síntoma observable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Asset ausente** (`agents/` o `skills/` fuera del tarball; falta `files` o falta la carpeta)  | No hay error: `core/src/agents/seed.ts` y `core/src/skills/seed.ts` hacen `readdirSync` dentro de un `try` y devuelven `[]`, así que el primer arranque **no siembra**. Se ve como un `~/.racso-harness/agents/` vacío o inexistente tras arrancar, y el CLI funciona con el agente por defecto embebido (`core/src/agents/defaults.ts`) sin los ejemplos. Igual con `cli/racso-logo.txt` fuera: `printLogo()` revienta con `ENOENT .../racso-logo.txt` en `cli/src/terminal/stdin.ts:265` y el proceso muere antes de la TUI/loop. |
| **`dist` incompleto** (se empaquetó sin `pnpm -r build`, o `dist` viejo con ficheros borrados) | `Cannot find module .../dist/index.js` al importar el SDK, `ERR_MODULE_NOT_FOUND` para un `./x.js` interno desde `dist/main.js`, o `bin/run.mjs` lanzando `spawn` sobre un `dist/main.js` inexistente (el shim no comprueba la existencia: `node:internal/modules/cjs/loader` → `Error: Cannot find module`).                                                                                                                                                                                                                       |
| **`bin` sin permiso de ejecución**                                                             | `zsh: permission denied: node_modules/.bin/racso-harness` (o `EACCES` en `npx racso-harness`). `npm pack` normaliza el modo a `-rwxr-xr-x` (comprobado con `tar -tvzf` sobre un tarball generado desde una copia), así que sólo aparece si se adjunta a mano un `.tgz` manipulado; `chmod +x cli/bin/run.mjs` antes de empaquetar lo previene.                                                                                                                                                                                      |
| **Node por debajo del mínimo**                                                                 | Con `engines`, `npm i` avisa `EBADENGINE` (`required: {"node":">=22"}`, `current: {"node":"v20.x"}`) y sigue; `pnpm` aborta. Sin `engines` el fallo llega tarde: `import.meta.dirname` es `undefined` en `<20.11` (`path.join(undefined, ...)` → `TypeError` en la siembra) y `ink@8`/`terminal-image@5` pueden no cargar.                                                                                                                                                                                                          |
| **`workspace:*` sin reescribir** (se empaquetó o publicó con `npm` en vez de `pnpm`)           | La instalación no resuelve: `npm error code EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:"` al instalar el tarball, o directamente `404`/`ETARGET` porque el `package.json` publicado pide `workspace:*`. Comprobación previa: `tar -xzf *.tgz -O package/package.json \| grep workspace` no debe devolver nada.                                                                                                                                                                                                            |

Nota sobre `--version`: hoy `cli/src/flags.ts` sólo entiende `--tui`, `--debug` y `-v` (alias de
debug), y `cli/src/main.ts` no imprime versión: `racso-harness --version` **arranca el loop normal**
en vez de imprimir `1.0.0`. Mientras no exista el flag, el smoke test usa
`node -e 'console.log(require("./node_modules/@racso2609/cli/package.json").version)'` o
`--help`→no soportado tampoco. Es trabajo de código, fuera de este documento.

## Instalación para el usuario

**Node requerido: `>=22`** para el CLI (`ink@8`, `terminal-image@5`); `>=20.11` basta para el SDK solo,
pero la combinación práctica es Node 22 o superior.

### (a) Sin token: tarball de GitHub Releases

```bash
# CLI + SDK
npm install --global \
  https://github.com/racso2609/agent-harness/releases/download/v1.0.0/racso2609-cli-1.0.0.tgz \
  https://github.com/racso2609/agent-harness/releases/download/v1.0.0/racso2609-core-1.0.0.tgz
racso-harness

# o como dependencia local del proyecto
npm install \
  https://github.com/racso2609/agent-harness/releases/download/v1.0.0/racso2609-cli-1.0.0.tgz \
  https://github.com/racso2609/agent-harness/releases/download/v1.0.0/racso2609-core-1.0.0.tgz
```

Los dos tarballs van juntos: el cli declara `@racso2609/core@^1.0.0` como dependencia y el registry
público no lo tiene. Descarga manual: `gh release download v1.0.0 --repo racso2609/agent-harness`
(o la página de Releases) y luego `npm i ./racso2609-core-1.0.0.tgz ./racso2609-cli-1.0.0.tgz`.

### (b) GitHub Packages (requiere token)

`.npmrc` del proyecto (o `~/.npmrc`):

```ini
@racso2609:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

`GITHUB_TOKEN` = un PAT de GitHub con `read:packages`. Después:

```bash
npm install @racso2609/cli @racso2609/core
# o
pnpm add @racso2609/cli @racso2609/core
npx racso-harness
```

Sin `.npmrc`, el `add` termina en `404 Not Found - GET https://npm.pkg.github.com/@racso2609%2fcore`.

### Primer arranque

Crea `~/.racso-harness/` (`harnessHome()` en `core/src/utils/env.ts` → `$HOME/.racso-harness`):

- `agents/` — se rellena con los `.md` de `core/agents/` la primera vez (`AgentLoader.seed()` →
  `ensureAgentsDir`, `core/src/agents/seed.ts`); no toca un directorio que ya tenga definiciones.
- `skills/` — igual, desde `core/skills/` (`ensureSkillsDir`, `core/src/skills/seed.ts`).
- `sessions/` — se crea al persistir la primera sesión (`save()` de `core/src/session/SessionStore.ts`).
- `config.json` — `DEFAULT_CONFIG_LOCATION` (`core/src/configuration/index.ts`); se escribe en el setup
  o al cambiar de proveedor/modelo (`configureProvider`, `setModel` → `writeConfig()`), no en un
  arranque sin cambios.

Relocalización por entorno (`core/src/utils/env.ts`):

| variable                          | efecto                                                  |
| --------------------------------- | ------------------------------------------------------- |
| `RACSO_HARNESS_CONFIG_LOCATION`   | ruta del `config.json`                                  |
| `RACSO_HARNESS_SESSIONS_LOCATION` | directorio de sesiones                                  |
| `RACSO_HARNESS_AGENTS_LOCATION`   | directorio de agentes (`config.agents.dir` por defecto) |
| `RACSO_HARNESS_SKILLS_LOCATION`   | directorio de skills (`config.skills.dirs` por defecto) |

## Preguntas abiertas

Ya resuelto, no reabrir: `@racso` queda descartado porque la organización no existe (`gh api orgs/racso`
→ 404) y el scope es `@racso2609`; el token de `gh` ya tiene `write:packages` y `delete:packages`
(`gh auth status`), así que no hace falta ampliar scopes para publicar; el destino es GitHub Packages
**y** Releases.

Lo que sí necesita decisión humana:

1. **¿Primera versión `1.0.0` o salto de versión?** `core/package.json` y `cli/package.json` ya dicen
   `1.0.0` y no hay nada publicado; si el primer release va como `1.0.0`, cualquier cambio posterior
   obliga a `1.0.1`. Hay que decidir versión antes de `pnpm publish` y de `gh release create` (el tag
   debe coincidir).
2. **¿Los `.map` viajan en los tarballs?** Con `files` siguen dentro (`sourceMap: true` en
   `core/tsconfig.json`): 42 de 135 entradas en el core y 29 de 61 en el cli (≈40 % del tamaño de cada
   `.tgz`). Quitarlos requiere `experimental` de pnpm o un paso que los borre tras `tsc`; el plan los
   deja dentro salvo que se decida lo contrario.

## Notas de verificación

Correcciones sobre los datos de partida, tras leer el repo y medir:

- **`cli/package.json` no es 117 ficheros**: `tar -tzf` de un `pnpm pack` real da **123** entradas
  (29 de ellas `.map`). El "117 → 32" del borrador no cuadra con ninguna medición posible de ese
  tarball; con el `files` propuesto salen **61 entradas (32 sin `.map`)**.
- **El `files` propuesto no baja la cuenta del core a 94**: son **135 entradas (93 sin `.map`)**,
  porque los 126 ficheros de `dist` (42 `.map`) **deben** viajar. Tamaños medidos: core 83 771 bytes,
  cli 81 764 bytes (un `.tgz` de 82 KB no son 64 KB). El "94 ficheros / 64 KB" del borrador
  probablemente se midió con un `files` sin `dist`.
- **`tsc-alias -f` no reescribe los imports de `@racso/core`**: sólo resuelve los alias de `paths` de
  su propio `tsconfig.json` (`@/*`). `cli/dist/main.js` conserva `import { setLoggerLevel } from
"@racso/core"`. Por eso el rename de imports del cli es **requisito** del rename de scope
(fila de `## Cambios por fichero`, paso 3 de `## Orden de publicación`): sin él el canal de
Releases queda roto. (Verificado además ejecutando `pnpm build` en `cli/` y leyendo `cli/dist/main.js`; los
  `dist` son artefactos ignorados por git y no se versionaron.)
- **`cli/racso-logo.txt` se lee en `cli/src/terminal/stdin.ts:265`**, no en la línea 353 que citaba el
  borrador. La ruta resuelta sí es la raíz del paquete, como decía el borrador.
- **`--version` no existe**: `cli/src/flags.ts` sólo parsea `--tui`, `--debug` y `-v` (debug), y
  `cli/src/main.ts` no imprime versión. El `racso-harness --version` del smoke test está escrito como
  objetivo, con la nota correspondiente.
- **`Config` expone `writeConfig()`, no `save()`** (`core/src/configuration/index.ts`); el smoke test
  usa `writeConfig()`. `harnessHome` **no** se exporta desde `index.ts` del core, así que se comprueba
  por el árbol de ficheros, no por API.
- **El árbol de `~/.racso-harness/` tras un primer arranque limpio**: verificado con el tarball del
  core instalado fuera del repo y `HOME` propio → se crean `agents/*.md` (6 ficheros) y `skills/*.md`
  (2) al inicializar el harness; `config.json` **no** aparece en un arranque sin configurar y sin
  cambios (`writeConfig()` sólo se llama desde setup/`configureProvider`/`removeProvider`/`setModel`).
- **`npm i` de dos tarballs a la vez falla antes de publicar**: comprobado, npm va al registry a buscar
  `@racso2609/core@1.0.0` y devuelve 404 (también con `overrides`, tanto en npm como en `pnpm`). Por eso
  el smoke test instala el core primero.
- **`gh` está logueado como `racso2609`** con scopes `admin:public_key, delete:packages, gist,
read:org, repo, write:packages` (`gh auth status`); el orden alfabético de la salida difiere del
  borrador, los scopes son los mismos. `gh api orgs/racso` devuelve `{"message":"Not Found"}` (HTTP
  404). Repo público, rama por defecto `main`, remote SSH.
- **Entorno**: Node `v26.12.1`, pnpm `11.28.10`, npm `11.20.0`. `npm pkg get name` dentro del repo
  aborta con `EBADDEVENGINES` (`current: npm 11.20.0`, `required: pnpm ^11.8.0`).
- **`npm` fuera del repo falla en esta máquina** por un caché con ficheros de root
  (`sudo chown -R 501:20 "/Users/racso/.npm"`); los smoke tests se hicieron con
  `npm_config_cache=/tmp/npmcache`. El usuario final no tiene este problema, pero conviene saberlo si
  se reproduce el guion aquí.
- **`core/package.json` y `cli/package.json` ya tienen cambios sin commitear** (`scripts.format` y
  `format:check`) que no vienen de este documento; este plan no modifica ningún `package.json`.
