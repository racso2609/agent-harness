# Journal — CLI · P4 — Publicación (F0)

Índice: [TODO del repo](../../../TODO.md) · TODO vivo: [cli/TODO.md](../../../cli/TODO.md)
Estado: cerrado el 2026-11-05

El canal por el que el empaquetado de `p4-packaging.md` sale del workspace: los dos
`.tgz` auditados y publicados, el release `v1.0.0` con ambos adjuntos, la instalación
documentada en el README y el script de smoke test de instalación limpia.

**Lo cerrado de este fragmento está marcado `[x]` en `cli/TODO.md` §P4, y está hecho.** El
2026-11-05 el release `v1.0.0` existe con los dos `.tgz` y el `README.md` ya trae
`## Instalación`. Verificado antes de escribir esto: `gh release view v1.0.0 --json
assets -q '.assets[].name'` devuelve `racso2609-cli-1.0.0.tgz` y
`racso2609-core-1.0.0.tgz`, y `grep -n '## Instalación' README.md` devuelve
`9:## Instalación`.

**Lo que sigue realmente abierto:** (1) ejecutar `scripts/smoke-install.mjs` contra los
`.tgz` del release (exige build y red, y el `.tgz` sólo existe después de
`pnpm -r build && pnpm pack`); (2) el canal GitHub Packages **no es verificable sin
token**: la consulta al registry responde `401` sin un PAT con `read:packages`, así que
la publicación por registry queda declarada en el `.npmrc` y sin comprobar desde aquí.


### Construir y auditar los dos tarballs antes de publicar

      `dist` está en `.gitignore`, así que un tarball sin `pnpm -r build` sale vacío y el
      fallo llega al usuario como `ERR_MODULE_NOT_FOUND`.
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

### Publicar `@racso2609/core`

      Es la lib base de los otros dos paquetes: sin core en el registry no hay nada que
      consuman el cli ni el gateway.
      Done when: `pnpm publish --no-git-checks` en `core/` termina sin error y
      `npm view @racso2609/core version --registry=https://npm.pkg.github.com` con
      `GITHUB_TOKEN` en el entorno devuelve la versión publicada.
 Depends on: añadir el `.npmrc` de publicación, construir y auditar los dos tarballs
antes de publicar.


### Publicar `@racso2609/cli`

      Va después del core porque depende de él, y es el paquete que trae el binario
      `racso-harness`.
      Done when: `pnpm publish --no-git-checks` en `cli/` termina sin error y
      `npm view @racso2609/cli version --registry=https://npm.pkg.github.com` con
      `GITHUB_TOKEN` devuelve la versión publicada.
      Depends on: publicar `@racso2609/core`.

### Crear el release con los `.tgz` adjuntos

      Es el canal sin token: quien no quiera configurar `.npmrc` ni PAT instala desde el
      release con un `npm i https://github.com/...` y nada más.
      Done when: `gh release view v<versión> --repo racso2609/agent-harness` lista
      `racso2609-core-<versión>.tgz` y `racso2609-cli-<versión>.tgz`, y el tag coincide
      con la `version` publicada de los dos paquetes.
      Depends on: publicar `@racso2609/cli`.


### Documentar la instalación en el README con los dos canales

      El README explica el diseño pero no cómo se instala ni qué crea el primer arranque,
      y hay dos formas de instalar con requisitos distintos (token o no).
      Done when: el README tiene una sección de instalación con el canal de GitHub
      Releases (sin token), el de GitHub Packages (`.npmrc` con `read:packages`), la
      versión de Node requerida (`>=22` para el CLI, `>=20.11` para el SDK solo) y qué
      ficheros crea en `~/.racso-harness/`.
      Depends on: crear el release con los `.tgz` adjuntos.

Bloqueo actual: el empaquetado está listo, pero falta **publicar** `@racso2609/core` y
después `@racso2609/cli`, y **crear el release** con los `.tgz` adjuntos. Los dos pasos
exigen un `GITHUB_TOKEN` con `write:packages` configurado fuera del repo:
`pnpm config set "//npm.pkg.github.com/:_authToken" "$(gh auth token)"` (el `.npmrc`
versionado no lleva el token). Prueba previa a publicar:
`pnpm -r build && pnpm pack --pack-destination /tmp/rel` y después
`node scripts/smoke-install.mjs`.


### Convertir el guion de `docs/INSTALL.md` en un script de smoke test de instalación limpia

      Hoy no existe ningún script: el smoke test sólo está escrito como guion manual en
      `docs/INSTALL.md`, así que nadie lo ejecuta antes de publicar.
hecho: existe `scripts/smoke-install.mjs` en la raíz (sólo builtins de Node) y su cabecera
lo declara "clean-install smoke test (closing criterion of F0, docs/ARCHITECTURE.md)":
empaqueta, instala los `.tgz` con `npm` en un proyecto de usar y tirar y rechaza
manifiestos con `src/`, `tests/` o docs de repo. Se ejecuta desde la raíz:
`node scripts/smoke-install.mjs`.
pendiente: la ejecución real contra los `.tgz` recién empaquetados
(`pnpm -r build && pnpm pack --pack-destination /tmp/rel` y luego el script) no se hace
aquí: exige un build completo y acceso a red, y el `.tgz` no existe hasta entonces.
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
pendiente: el script **no** verifica que un primer arranque con `HOME` propio siembre los
ficheros en `$HOME/.racso-harness/`, que es lo que prometía este `Done when`. Hoy sólo
comprueba que el `HOME` real queda intacto (`:325`) y que los `.md` viajan en el tarball;
que el arranque los escriba sigue sin cubrirse.
Depends on: construir y auditar los dos tarballs antes de publicar.
