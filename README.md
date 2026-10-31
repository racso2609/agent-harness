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

Todo lo demás (canales, cron, skills, MCP, memoria, subagentes) es encima de eso.

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
8. **Skills** (SKILL.md + discovery) y **MCP**.
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
agente activo conservando la conversación. Ejemplos listos en `backend/agents/`.

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
