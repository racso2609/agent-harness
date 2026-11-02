# agent-harness

Mi propio **agent harness** ligero, del estilo de openclaw / picoclaw / zeroclaw.
Construido a mano, en TS, aprendiendo el esqueleto de los que ya existen.

> Proyecto de aprendizaje + herramienta personal. Objetivo: entender _de verdad_ cómo
> funciona un agente (loop, tools, contexto) construyendo el más mínimo que funcione.

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
