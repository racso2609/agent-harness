# agent-harness

Mi propio **agent harness** ligero, del estilo de openclaw / picoclaw / zeroclaw.
Construido a mano, en TS, aprendiendo el esqueleto de los que ya existen.

> Proyecto de aprendizaje + herramienta personal. Objetivo: entender _de verdad_ cómo
> funciona un agente (loop, tools, contexto) construyendo el más mínimo que funcione.

## Instalación

El repo publica dos paquetes, `1.0.0` (la versión del tag del release): `@racso2609/cli`,
el cliente de terminal, y `@racso2609/core`, el SDK que consume. Hay dos canales:
**tarball de GitHub Releases** (sin token ni cuenta) y **GitHub Packages** (con token).

### Requisitos

- **CLI — Node `>=22`**: `ink@8` y `terminal-image@5` declaran ese mínimo.
- **Core — Node `>=20.11`**: usa `import.meta.dirname` (siembra de `agents/` y `skills/`).

Los dos `package.json` declaran `engines.node`, así que la instalación avisa si no se
cumple: `npm` sigue adelante con un `EBADENGINE` y el fallo aparece después en runtime
(por debajo de 20.11, `import.meta.dirname` es `undefined`), mientras que `pnpm` falla
directamente. En la práctica: **Node 22 o superior** para todo.

### Canal sin token: tarball de GitHub Releases

No hace falta token, ni `.npmrc`, ni cuenta de GitHub. Se instalan **los dos tarballs en el
mismo comando**, el del core y el del CLI:

```sh
npm i -g https://github.com/racso2609/agent-harness/releases/download/v1.0.0/racso2609-core-1.0.0.tgz https://github.com/racso2609/agent-harness/releases/download/v1.0.0/racso2609-cli-1.0.0.tgz
racso-harness
```

Y como dependencia del proyecto, la misma línea sin `-g`:

```sh
npm i https://github.com/racso2609/agent-harness/releases/download/v1.0.0/racso2609-core-1.0.0.tgz https://github.com/racso2609/agent-harness/releases/download/v1.0.0/racso2609-cli-1.0.0.tgz
```

Hay que pasar **los dos**: el CLI declara `@racso2609/core@^1.0.0` como dependencia y
ninguno de los dos está en el registry público de npm. Con el tarball del CLI solo, npm
intenta resolver el core en npmjs y la instalación termina en
`E404 ... GET https://registry.npmjs.org/@racso2609%2fcore`.

> **El tarball del CLI no sirve solo.** `npm i -g .../racso2609-cli-1.0.0.tgz`, sin el del
> core en el mismo comando, falla con ese `E404`: no es una alternativa a la línea de
> arriba. El CLI se instala solo únicamente si el core está en GitHub Packages, y eso ya
> es el otro canal: exige el `.npmrc` con token y el scope resuelto (sección siguiente).

Los `.tgz` también se pueden descargar a mano desde la página de Releases (o con
`gh release download v1.0.0 --repo racso2609/agent-harness`) y luego instalar en local con
`npm i ./racso2609-core-1.0.0.tgz ./racso2609-cli-1.0.0.tgz`.

### Canal GitHub Packages (requiere token)

Instalar por este canal exige **dos ajustes** en el `~/.npmrc` de tu máquina, y **los dos** son
necesarios: el **mapeo de scope** (le dice a pnpm que `@racso2609` vive en GitHub Packages y no en
npmjs) y el **token** (GitHub Packages exige autenticación incluso para un repo público). El primero
no es sólo para publicar: sin él, instalar también falla.

En tu `~/.npmrc` (es el sitio correcto: pnpm y npm lo leen de tu máquina y **sí** expanden
`${GITHUB_TOKEN}` ahí; en un `.npmrc` versionado dentro de un repo pnpm ignora la credencial y el
`npm i` acaba en `401`):

```ini
@racso2609:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

`GITHUB_TOKEN` tiene que ser un PAT de GitHub con el scope **`read:packages`** (`gh auth
token` sirve el del `gh` ya logueado). Los equivalentes en una línea, también en tu `~/.npmrc`, uno
por ajuste:

```sh
pnpm config set @racso2609:registry https://npm.pkg.github.com
pnpm config set "//npm.pkg.github.com/:_authToken" "$(gh auth token)"
```

Y después:

```sh
npm i -g @racso2609/cli
```

GitHub Packages **exige token incluso cuando el repo es público**: con el mapeo puesto pero sin
token, el `add` termina en `401 Unauthorized - GET https://npm.pkg.github.com/@racso2609%2fcli`
(`authentication token not provided`).

#### Si falla: los dos `404` no son el mismo `404`

El síntoma se parece (un `404`) pero la causa y el arreglo son distintos. Lo que hay que mirar es
**contra qué host** fue la petición, en el mensaje de error:

| mensaje                                                                                                                                                           | causa                                                                                        | arreglo                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `404 ... GET https://registry.npmjs.org/@racso2609%2fcli` (`ERR_PNPM_FETCH_404`, `is not in the npm registry`)                                                    | **falta el mapeo de scope**: pnpm está buscando el paquete en npmjs público, donde no existe | `pnpm config set @racso2609:registry https://npm.pkg.github.com`                                                   |
| `404 ... GET https://npm.pkg.github.com/@racso2609%2fcli` (`npm package "cli" does not exist under owner "racso2609"`)                                            | el paquete no está publicado con ese nombre: falta el publish o el scope es otro             | revisar que `cli/package.json` diga `@racso2609/cli` y que `pnpm publish` haya ido a GitHub Packages               |
| `401 ... GET https://npm.pkg.github.com/@racso2609%2fcli` (`authentication token not provided`, o `pnpm` avisa `No authorization header was set for the request`) | **falta el token** en el `~/.npmrc`                                                          | `pnpm config set "//npm.pkg.github.com/:_authToken" "$(gh auth token)"`                                            |
| `401 ... cannot be authenticated with the token provided`                                                                                                         | el token está, pero es inválido o **no tiene `read:packages`**                               | genera un PAT con `read:packages` (`gh auth refresh -s read:packages`) y vuelve a ponerlo con el comando de arriba |

Comprobación rápida de cuál de los dos ajustes falta, **desde fuera del repo**:

```sh
pnpm config get @racso2609:registry    # undefined ⇒ falta el mapeo
pnpm config get "//npm.pkg.github.com/:_authToken"   # undefined ⇒ falta el token
```

> **El `.npmrc` del repo no sirve para instalar globalmente.** Sólo aplica cuando ejecutas dentro del
> repo: `pnpm` lee el `.npmrc` del proyecto en el que estás, no el de un repo que tengas en otra
> carpeta. Por eso `pnpm i -g @racso2609/cli` desde `~` o `/tmp` puede dar el `404` de npmjs aunque
> dentro del repo `pnpm config get @racso2609:registry` devuelva GitHub Packages: fuera del repo ese
> valor no lo aporta el proyecto y sale `undefined` (salvo que ya lo tengas en tu config de
> usuario). Lo que arregla la instalación global es tener los dos ajustes en **tu** `~/.npmrc`.

Nota para **publicar** desde el repo (no para instalar): el `.npmrc` versionado del repo lleva
**sólo** `@racso2609:registry=https://npm.pkg.github.com`; el token no va ahí. pnpm 11 ignora las
credenciales que vienen de un `.npmrc` de proyecto (lo avisa con `[WARN] Ignored project-level auth
setting`), porque el fichero podría apuntar a un registry atacable y el secreto se filtraría; con la
línea del token en el repo, `pnpm publish` daría `401`. El token va en tu `~/.npmrc`
(`pnpm config set "//npm.pkg.github.com/:_authToken" "$(gh auth token)"`). Pasos completos en
[`docs/INSTALL.md`](docs/INSTALL.md).

### Uso del core como librería

```sh
npm i @racso2609/core
```

(o el tarball de Releases, `npm i ./racso2609-core-1.0.0.tgz`). Mínimo real:

```ts
import { createHarness } from "@racso2609/core";

const harness = createHarness();
await harness.initialize();
```

`createHarness` acepta un objeto opcional de dependencias (logger, handler de
aprobaciones, `Config`, `SessionStore`); sin argumentos usa los valores por defecto. La
superficie completa está en [`core/CONTRACT.md`](core/CONTRACT.md).

### Primer arranque

Arrancar el CLI crea `~/.racso-harness/` (`$HOME/.racso-harness`):

- `config.json` — la configuración. En el primer arranque sin config, el CLI pide el
  setup del provider (id, base URL, key y modelo) y escribe el fichero al terminar.
- `agents/` — se siembra con los `.md` de `core/agents/` la primera vez; no toca un
  directorio que ya tenga definiciones.
- `skills/` — igual, desde `core/skills/`.
- `sessions/` — se crea al persistir la primera sesión.

Cada ubicación se puede relocalizar por entorno:

| variable                          | efecto                 |
| --------------------------------- | ---------------------- |
| `RACSO_HARNESS_CONFIG_LOCATION`   | ruta del `config.json` |
| `RACSO_HARNESS_SESSIONS_LOCATION` | directorio de sesiones |
| `RACSO_HARNESS_AGENTS_LOCATION`   | directorio de agentes  |
| `RACSO_HARNESS_SKILLS_LOCATION`   | directorio de skills   |

### Verificar la instalación

```sh
racso-harness --version # imprime la versión del paquete, p. ej. 1.0.0
```

Si contribuyes al repo, el smoke test comprueba el artefacto empaquetado de punta a punta:
empaqueta los dos paquetes, los instala con `npm` en un proyecto temporal y arranca el CLI
y el SDK desde fuera del workspace. Corre con un `HOME` aislado, así que **no toca** tu
`~/.racso-harness/` real:

```sh
node scripts/smoke-install.mjs
```

O en un contenedor limpio (Node 22, sin nada del host):

```sh
docker build -f docker/smoke.Dockerfile -t racso-smoke . && docker run --rm racso-smoke
```

### Las dos implementaciones

`@racso2609/cli` es el **cliente de terminal**: dueño de la TUI, los slash commands, los
flujos interactivos (provider/modelo/agente/sesión, setup, aprobaciones) y el render. El
**gateway** (canales, cron, subagentes) será un paquete aparte que consume el mismo core,
no una variante del CLI. Frontera e hitos en
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); el plan de publicación (registry, tarballs,
scopes y `.npmrc`) en [`docs/INSTALL.md`](docs/INSTALL.md).

## Qué es un "agent harness"

Un agente no es magia: es un bucle que habla con un LLM, ejecuta herramientas cuando
el modelo lo pide, y vuelve a meter los resultados en la conversación hasta llegar a
una respuesta final. Eso es todo. El "harness" es el andamio que lo hace correr de
forma fiable, con contexto acotado y sin bucles infinitos.

## El núcleo mínimo (lo que hay que construir)

Cuatro piezas y ya tienes un agente de verdad:

1. **Provider** — cliente HTTP a un endpoint OpenAI-compatible, con streaming y
   soporte de `tools` / `tool_calls`.
2. **Loop ReAct** — messages → LLM → si hay `tool_calls`, ejecútalos, añade los
   resultados y repite. Con límite de iteraciones (anti-bucle).
3. **Tool registry** — nombre + JSON schema + `Execute(ctx, args)`. Empezar con una
   sola tool: `shell`.
4. **Context budget** — política de qué recortar/resumir cuando revientas la ventana.

Todo lo demás (canales, cron, MCP, memoria, subagentes) es encima de eso. Las
skills ya están dentro: ver [Skills](#skills-recetas-en-markdown).

## Estructura del repositorio

Monorepo pnpm con dos workspaces hermanos:

- **`core/`** (`@racso/core`) — el dominio como **SDK sin interacción**. Expone
  `createHarness(deps): IHarness`. No lee stdin, no pinta prompts, no imprime
  imágenes: logger, aprobaciones y render se inyectan. El contrato completo está
  en [`core/CONTRACT.md`](core/CONTRACT.md).
- **`cli/`** (`@racso/cli`) — el cliente de terminal. Es dueño del `MainLoop`,
  los slash commands, los flujos interactivos (elegir provider/modelo/agente/
  sesión, setup, aprobaciones), el logo y el render de imágenes. Consume el core
  solo a través de `@racso/core`.

```
core/   @racso/core  → createHarness, IHarness, Config, SessionStore, providers, tools, agents
cli/    @racso/cli   → MainLoop, CommandRepository, flows/, terminal/, render/, ui/
```

Regla de frontera: `core` nunca importa `cli` ni nada de terminal; `cli` nunca
importa rutas internas del core, solo su API pública.

Comandos desde la raíz:

```sh
pnpm -r build   # tsc en ambos workspaces
pnpm -r lint    # eslint en ambos workspaces
pnpm -r test    # vitest en ambos workspaces
```

## MVP real — orden de hitos

Orden pensado para tener algo funcional cuanto antes y no perderse:

1. **CLI que llama a un endpoint y printea el streaming.** Sin tools. (Día 1.)
2. **Añadir una tool (`shell`) + loop de `tool_calls`.** ~200 líneas y ya tienes un
   agente. (Día 2-3.)
3. **Persistencia de sesión** — historial en JSONL append-only.
4. **Presupuesto de contexto** — truncar cola / resumir.
5. **Registry genérico de tools** — schemas + validación de argumentos.
6. **Un canal (Telegram)** por bus de eventos, desacoplado del loop.
7. **Cron / recordatorios.**
8. ~~**Skills** (SKILL.md + discovery)~~ ✅ hecho — ver [Skills](#skills-recetas-en-markdown); queda **MCP**.
9. **Multi-proveedor** — openai-compat + anthropic messages.

## Dónde investigar

### Referencia local (lectura del loop), en `~/work/picoclaw-integration`

Orden de lectura para entender el esqueleto del agente:

- `pkg/agent/agent.go` — orquestador del turno.
- `pkg/agent/pipeline_llm.go` + `pipeline_execute.go` + `pipeline_streaming.go` —
  **aquí vive el ReAct loop real** (LLM → tool_calls → ejecutar → repetir).
- `pkg/agent/context.go` (+ `context_budget`) — gestión/recorte del contexto.
- `pkg/providers/openai_compat/` — abstracción del proveedor (un endpoint
  OpenAI-compatible cubre ~90% de los modelos).
- `pkg/tools/registry.go` + `toolloop.go` — registro y dispatch de tools.
- `pkg/bus/` — bus de eventos: los canales publican, no hablan directo con el agente.
- `pkg/channels/telegram/` — adapter de canal más limpio para copiar el modelo mental.
- `pkg/cron/`, `pkg/skills/`, `pkg/mcp/` — extensibilidad (fase final).

Comparar el mismo loop en **openclaw** y **zeroclaw** enseña qué es esencial y qué es
ceremonia de cada uno.

### Referencias externas

- **smolagents (HuggingFace)** — el harness más pequeño y legible que existe, el loop
  en un solo archivo: https://github.com/huggingface/smolagents
- **Anthropic — "Building effective agents"** — el ensayo de arquitectura de referencia:
  https://www.anthropic.com/engineering/building-effective-agents
- **OpenAI — Function calling / Tools** — el contrato de tool calling bien explicado:
  https://platform.openai.com/docs/guides/function-calling
- **Papers (para el _porqué_):**
  - ReAct: https://arxiv.org/abs/2210.03629
  - Reflexion (reintentar si falla): https://arxiv.org/abs/2303.11366
- **Contraste (qué NO hacer de primeras):** LangGraph, OpenHands, SWE-agent —
  orquestación pesada; mirar solo para decidir qué evitar en un harness ligero.

## Agentes (personalidades en markdown)

Un **agente** empaqueta personalidad + provider/modelo + tools permitidos +
política de approval. Se define con un `.md` en `~/.racso-harness/agents`
(override con `RACSO_HARNESS_AGENTS_LOCATION`). El frontmatter es opcional; el
cuerpo del markdown es el system prompt del agente.

```md
---
name: Reviewer
description: Revisa código sin tocar archivos
provider: openai
model: deepseek-v4.1-flash-1017
tools: [readFile, listDir]
approval: deny
maxIterations: 6
---

Eres un revisor de código senior. Analizas y propones diffs, no modificas archivos.
```

Reglas de precedencia:

- Si falta `provider`/`model`, se hereda de `config.json`.
- Sin `tools`, el agente hereda todos los tools habilitados; `[]` los desactiva.
- `approval` de un agente **solo puede endurecer** el global (`auto → ask → deny`).
- `maxIterations` de un agente **solo puede bajar** el global.
- Archivo inválido: warning y se ignora; nunca rompe el arranque.
- Sin archivos: agente `default` embebido, comportamiento previo intacto.

En runtime: `/agent` lista los agentes disponibles y `/agent <id>` cambia el
agente activo conservando la conversación. Ejemplos listos en `core/agents/`.

### `code-reviewer`

Revisor de solo lectura (sin `writeFile`, `approval: deny`). Revisa cambios
pendientes locales, comiteados sin revisar o un PR (`git diff`, `gh pr diff`),
y reporta hallazgos con `file:line`:

- Bugs, riesgos de seguridad, inconsistencias con las convenciones y blast
  radius, priorizados como bloqueantes o advisory.
- Mejoras concretas (DRY/KISS/YAGNI, workarounds = `critical`).
- **Auditoría de tests**: detecta tests tautológicos/siempre-verdes,
  over-mocked, sin asserts, asserts debilitados, escritos "para pasar" o que
  prueban implementación, y flaky. Para cada uno dice qué afirma probar, qué
  prueba de verdad, y cómo hacerlo significativo; además propone los tests
  faltantes. Nunca modifica archivos.

```md
---
name: Code Reviewer
description: Revisa cambios (diff local o PR) sin editar nada; propone mejoras y audita que los tests sean significativos.
tools: [readFile, listDir, shell]
approval: deny
maxIterations: 10
---
```

## Providers (instancias vs tipo de backend)

`providers` es un **mapa de instancias**: la clave es un id libre que eliges tú
(`cheap`, `openrouter`, `work`, ...). El campo `type` declara qué backend
interpreta `url`/`apikey`; hoy solo existe el tipo `openai`, compatible con
cualquier endpoint OpenAI-compatible. Así puedes tener varias instancias del
mismo tipo (cheaperinference, OpenRouter, un proxy local...) sin estar atado a
una sola.

```jsonc
"providers": {
  "cheap": {
    "type": "openai",
    "url": "https://api.cheaperinference.com/v1",
    "apikey": "ci_...",
    "model": "deepseek-v4.1-flash-1017"
  },
  "openrouter": {
    "type": "openai",
    "url": "https://openrouter.ai/api/v1",
    "apikey": "sk-or-..."
  }
},
"defaultProvider": "cheap"
```

- Un provider sin `type` se interpreta como `openai` (las configs antiguas con
  `providers.openai` siguen funcionando sin migración).
- `providers.<id>.model` es el modelo preferido de esa instancia; se usa como
  fallback cuando el modelo activo no existe en la instancia destino (p.ej. al
  cambiar con `/provider`).
- La sesión persistida guarda el **id de instancia**, y un agente puede fijar el
  suyo con `provider: <id>` en el frontmatter.

En runtime: `/provider ls` lista las instancias (id, tipo, modelo, default y la
activa con `*`); `/provider add` registra una nueva; `/provider rm [id]` la
elimina (no borra sesiones); `/provider <id>` cambia la instancia activa.

## Sesiones persistidas

Cada sesión se guarda como JSON en `~/.racso-harness/sessions` (override con
`RACSO_HARNESS_SESSIONS_LOCATION`) con su historial, provider/modelo, agente,
usage y coste.

- `/sessions` (alias `/session`) — lista las sesiones por actividad reciente con
  título, provider/modelo, agente y número de mensajes. La activa se marca con `*`.
- `/resume <id|prefijo|índice>` (alias `/switch`) — cambia a esa sesión,
  persistiendo antes la actual. Acepta el id completo, un prefijo único o el
  número de la lista. Sin argumento abre un selector interactivo.
- Al arrancar: `--session <id>` (o `--resume`) retoma una sesión concreta.

## Skills (recetas en markdown)

Una _skill_ es una receta reutilizable: un `SKILL.md` con instrucciones que el
modelo carga **solo cuando la tarea encaja**. No se meten todas en el prompt:
se indexan por nombre y el cuerpo se pide bajo demanda.

### Formato

```markdown
---
name: Deploy Checklist
description: Cómo publicar un release sin romper nada.
tags: [ops, release]
---

1. Corre los smoke tests en staging.
2. Etiqueta el commit.
3. ...
```

`:name` y `description` son obligatorios; `tags` es opcional. El **id** sale
del nombre del directorio (o del fichero).

### Dónde se buscan

En `~/.racso-harness/skills` (override con `RACSO_HARNESS_SKILLS_LOCATION`),
admitiendo dos layouts:

```
~/.racso-harness/skills/deploy/SKILL.md
~/.racso-harness/skills/deploy.md
```

Se pueden añadir más directorios con `skills.dirs` en la config, con `skills`
opcional (si no existe se usan los defaults). Gana el primer directorio en
caso de ids repetidos; dentro de un mismo directorio gana `SKILL.md`.

En una instalación limpia el primer directorio se siembra con los ejemplos que
vienen en el paquete (hoy `frontend-design.md`), igual que ocurre con los
agentes. Solo se copian si el directorio no existe o está vacío: **nunca se
pisa** una skill tuya.

```json
{
  "skills": {
    "enabled": true,
    "dirs": ["/ruta/a/mis-skills"],
    "maxIndexChars": 160,
    "maxBodyChars": 16000
  }
}
```

### Cómo llega al modelo

1. Al arrancar, el índice (`- <id> — <descripción>`, una línea por skill) se
   añade al final del system prompt, bajo `## Skills`. Sin skills, el system
   prompt es **idéntico** al de antes: no hay coste.
2. El modelo llama a la tool `use_skill(id)` cuando la tarea encaja.
3. Solo entonces el cuerpo entra en la conversación, como resultado de la
   tool. El system prompt nunca contiene bodies.

### Allowlist de tools

`use_skill` se ofrece **solo a los agentes que no declaran `tools:`**. Un
agente con lista propia recibe exactamente esa lista, así que para darle
skills se añade `use_skill` a su frontmatter. Es intencionado: la decisión
queda escrita en el agente y no se mete nada por detrás. `senior-architect`,
`code-reviewer` y `coder` ya la declaran.

### Comandos

- `/skills` — lista id, nombre, tags y descripción.
- `/skill <id>` — imprime la skill directamente en la terminal, **sin llamar
  al modelo** y sin tocar el historial. Útil para depurar una definición.
- `/skill reload` — re-escanea los directorios y refresca el system prompt
  sin reiniciar la sesión.

### Límites

- Una skill inválida (sin descripción o sin body) se avisa con un warning y se
  ignora; el arranque nunca falla por una skill rota.
- `maxBodyChars` (16k por defecto) recorta bodies desmesurados; el recorte duro
  de 32k de las tools sigue aplicando por encima.
- El índice crece con el número de skills: por eso cada descripción se recorta a
  `maxIndexChars`.

## Renderers, teclas y logs

El CLI trae dos renderers sobre el mismo contrato: modo líneas (por defecto) y la
TUI de pantalla completa (`--tui`). La lógica del turno es idéntica en ambos.

### Teclas de la TUI

| Tecla                 | Qué hace                                                      |
| --------------------- | ------------------------------------------------------------- |
| `pageUp` / `pageDown` | Una página de historial (deja una línea de contexto)          |
| `ctrl+u` / `ctrl+d`   | Media página                                                  |
| `↑` / `↓`             | Una línea                                                     |
| rueda / trackpad      | Tres líneas por muesca                                        |
| `home` / `end`        | Tope / fondo del historial                                    |
| `ctrl+r` / `ctrl+t`   | Colapsar o expandir todo el razonamiento / la salida de tools |
| `ctrl+c`              | Salir                                                         |

El historial se mide en líneas reales a la altura del terminal: si estás desplazado
hacia arriba, la respuesta que se está generando **no** mueve la vista; al volver al
fondo el seguimiento se re-engancha solo. La rueda y el trackpad scrollean tres líneas
por muesca: ink 8 no reporta eventos de ratón, así que la TUI activa el modo SGR y lee
las muescas de stdin por su cuenta. Eso hace que el ratón quede capturado por la app:
para seleccionar texto hay que mantener `Shift` (u `Option`, según el terminal).

### Logs

Los logs del core (`logger.info`, `logger.warn`) **no** se muestran salvo que se pida
explícitamente: por defecto solo pasan `error` y `fatal`. En la TUI nunca se pintan
dentro del transcript, para no mezclarse con la conversación.

| Cómo               | Efecto                                                                            |
| ------------------ | --------------------------------------------------------------------------------- |
| `--debug` (o `-v`) | Fija el nivel en `debug` al arrancar                                              |
| `LOG_LEVEL=debug`  | Igual, por entorno (`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`) |
| `LOG_LEVEL=silent` | Silencia todo, `error` incluido                                                   |

## Trampas conocidas (de picoclaw) — a evitar desde el principio

- **Tool calls como texto plano:** algunos modelos (p.ej. DeepSeek) escupen el markup
  en vez de `tool_calls` nativos y el turno muere en silencio. Normalizar el marcador
  _antes_ de parsear.
- **Sin context budget** un turno largo mata la sesión. Tenerlo presente desde el Día 1.
- **Subprocesos con stdout redirigido a fichero = bloqueo** (log "colgado" que sí
  trabaja). Si el harness lanza procesos, usar heartbeat en fichero, no tamaño de log.
- **Reinicialización de MCP:** no usar `sync.Once` para el init, o recargar config lo
  mata para siempre.
- **Lenguaje:** TS dan ecosistema y velocidad de prototipo.

---

_Este README es el punto de partida. El código se escribe a mano, hito a hito._
