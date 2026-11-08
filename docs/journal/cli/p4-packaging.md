# Journal — CLI · P4 — Empaquetado (F0)

Índice: [TODO del repo](../../../TODO.md) · TODO vivo: [cli/TODO.md](../../../cli/TODO.md)
Estado: cerrado el 2026-11-04

Manifiestos listos para publicar: scope `@racso2609`, imports, `files`, `private`/`workspace:^`, `engines.node`, dependencias del core, `.npmrc` y el script de smoke test de instalación limpia.

### Renombrar el scope a `@racso2609` en los dos `package.json`
      GitHub Packages exige que el scope coincida con el dueño del paquete, y el dueño
      del repo es `racso2609`, no la inexistente org `racso`.
      hecho: `core/package.json:2` declara `"name": "@racso2609/core"` y
`cli/package.json:2` declara `"name": "@racso2609/cli"`; no queda ningún
`"name": "@racso/` en ninguno de los dos manifiestos.
Done when: `grep '"name"' core/package.json cli/package.json` devuelve
      `@racso2609/core` y `@racso2609/cli`, y no queda ningún `"name": "@racso/`.
      Depends on: nada.

### Renombrar los imports de `@racso/core` a `@racso2609/core` en el cli
Es **requisito** del rename de scope, no una opción: `grep -rln "@racso/core"
cli/src cli/tests cli/bin` devuelve 22 ficheros y `tsc && tsc-alias -f` no
reescribe imports de paquetes (sólo los alias `@/*`), así que hoy `cli/dist/main.js`
sigue emitiendo `import { setLoggerLevel } from "@racso/core"`. Con el paquete
llamado `@racso2609/core`, un `dist` sin renombrar importa un paquete que no existe
y el canal de Releases queda roto; hasta recompilar, el `dist` no es válido.
hecho (código): `grep -rn "@racso/core" cli/src cli/tests cli/bin | wc -l` devuelve `0`:
los ficheros que citaba esta tarea ya importan `@racso2609/core`.
pendiente: la mitad que recompila (`pnpm --filter @racso2609/cli build` y `grep -c` sobre
`cli/dist/main.js`) no se puede hacer aquí: `cli/dist/main.js` no existe sin build y un
`grep` sobre un fichero inexistente no prueba nada.
Done when: `grep -rn "@racso/core" cli/src cli/tests cli/bin` no devuelve nada y,
tras `pnpm --filter @racso2609/cli build`, `grep -c "@racso2609/core"
cli/dist/main.js` devuelve `1` o más.
Depends on: renombrar el scope a `@racso2609` en los dos `package.json`.

### Añadir `files` explícito a los dos paquetes
      Sin `files` el tarball del core mete 205 ficheros / 182 KB y el del cli 123 / 207 KB
      (`src/`, `tests/`, `TODO.md`, configs y los `.map` innecesarios).
      hecho: `core/package.json:16` declara `"files": ["dist", "agents", "skills"]` y
`cli/package.json:10` declara `"files": ["dist", "bin", "racso-logo.txt"]`.
pendiente: que el tarball deje fuera `src/`, `tests/` y `TODO.md` (el recuento de
`tar -tzf`) se verifica en la tarea de auditar los dos tarballs, que sigue abierta.
Done when: `core/package.json` declara `files: ["dist", "agents", "skills"]` y
      `cli/package.json` declara `files: ["dist", "bin", "racso-logo.txt"]`, con el logro
      verificado en la tarea de auditar los tarballs.
      Depends on: nada.

### Quitar `private: true` del cli y pasar la dependencia del core a `workspace:^`
      Con `private: true` `pnpm publish` aborta con `[EPRIVATE]`, y con `workspace:*` el
      tarball fija la versión exacta del core y obliga a republicar el cli en cada bump.
hecho: (a) `cli/package.json` no tiene campo `private` (cero ocurrencias); (d)
`cli/package.json:22` declara `"@racso2609/core": "workspace:^"`.
pendiente: (b) y (c) se leen sobre el `package.json` **dentro del tarball**, así que piden
`pnpm pack`: la expansión de `workspace:^` a `^1.0.0` y la ausencia de `"private"` sólo se
confirman en la tarea de auditar los dos tarballs. Aquí queda fijado el manifiesto.
Done when: (a) `grep -c '"private"' cli/package.json` devuelve `0`; (b) el
`package.json` del tarball (`pnpm pack` y extraer) no contiene `"private"`; (c) ese
mismo `package.json` deja `"@racso2609/core": "^1.0.0"` y ningún `workspace:`.
      Depends on: renombrar el scope a `@racso2609` en los dos `package.json`.

### Añadir `engines.node` a los dos paquetes
      Sin `engines` nada impide instalar en un Node que no soporta las dependencias, y el
      fallo aparece en runtime en vez de en la instalación.
      hecho: `core/package.json:17` declara `"engines": { "node": ">=20.11" }` y
`cli/package.json:11` declara `"engines": { "node": ">=22" }`.
pendiente: que `pnpm pack` conserve el campo en el `package.json` del tarball se comprueba
en la tarea de auditar los tarballs, que sigue abierta.
Done when: `core/package.json` declara `engines.node: ">=20.11"` (por
      `import.meta.dirname`) y `cli/package.json` declara `">=22"` (por `ink@8` y
      `terminal-image@5`), y `pnpm pack` de cada paquete deja ese campo en el
      `package.json` del tarball.
      Depends on: nada.

### Sacar `terminal-image` y `tsconfig-paths` de las dependencias de producción del core
      `grep -rn terminal-image core/src` no devuelve nada (sólo lo importa
      `cli/src/terminal/stdin.ts`), y `tsconfig-paths` no se importa en ningún sitio del
      core porque los alias `@/*` los resuelve `tsc-alias -f` en build-time; el SDK no
      debe arrastrar `jimp` ni un loader de paths que no usa.
      hecho: las `dependencies` del core son hoy `dotenv`, `pino` y `pino-pretty`
(`node -e` sobre `core/package.json`), sin `terminal-image` ni `tsconfig-paths`;
`terminal-image` sigue en el cli, que es quien lo importa desde `cli/src/terminal/stdin.ts`.
pendiente: `pnpm-lock.yaml` todavía resuelve `terminal-image@5.0.1`; que el core deje de
arrastrar `jimp` se confirma con un `pnpm install` en limpio, que no se corre desde aquí
para no tocar el lockfile compartido.
Done when: `terminal-image` sale de `dependencies` del core (a `devDependencies` o
      fuera) y `tsconfig-paths` deja de estar en `dependencies`, de modo que
      `pnpm --filter @racso2609/core build && pnpm --filter @racso2609/core test` sigue en
      verde y el `pnpm-lock.yaml` deja de resolver `jimp` para el core.
      Depends on: nada.

### Añadir el `.npmrc` de publicación con el token fuera del repo
      Sin registry por scope, `pnpm publish` va a `registry.npmjs.org`; el token nunca
      puede quedar en claro en el fichero.
hecho: el `.npmrc` de la raíz declara `@racso2609:registry=https://npm.pkg.github.com` y
documenta en comentarios cómo configurar el token una vez por máquina, fuera del repo.
corrección del Done when: el criterio original pedía una línea
`//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}` **dentro del fichero versionado**, y el
repo decidió lo contrario: pnpm no expande variables de entorno en un `.npmrc`
versionado (para no filtrar el secreto a un registry atacable), así que esa línea no
autenticaría nada y sólo dejaría el placeholder en git. Criterio real: registry por scope
en el `.npmrc` versionado **más** el token fuera del repo con
`pnpm config set "//npm.pkg.github.com/:_authToken" "$(gh auth token)"`.
pendiente: `pnpm publish --dry-run --no-git-checks` en `core/` (el destino anunciado) no
se corre aquí: sin token configurado no dice nada útil sobre el canal real.
Done when: el `.npmrc` de la raíz declara
`@racso2609:registry=https://npm.pkg.github.com`, no contiene ningún token ni la variable
`GITHUB_TOKEN`, la configuración del PAT queda documentada en ese mismo `.npmrc` como
`pnpm config set` fuera del repo, y `pnpm publish --dry-run --no-git-checks` en `core/`
anuncia el destino `https://npm.pkg.github.com`.
Depends on: renombrar el scope a `@racso2609` en los dos `package.json`.
