# Capa de memoria persistente

Documento de decisión y plan. No describe el estado actual del repo: describe lo que hay que construir
para que el harness tenga memoria entre sesiones sin acoplarse a un producto concreto. Todo lo que se
afirma del código va con `fichero:símbolo` o `fichero:línea`; lo verificado empíricamente contra Engram
3.6.2 va marcado como tal; lo que quedó sin verificar está en `## Notas de verificación`.

## 1. Problema

Hoy la única "memoria" del harness es **intra-sesión y destructiva**:

- `core/src/session/history.ts:37` (`compactHistory`) parte el historial en mensajes `system` y
  conversación, y cuando la conversación supera `compactThreshold` (`history.ts:3`,
  `DEFAULT_COMPACT_THRESHOLD = 4`; en config el default real es `350`,
  `core/src/configuration/index.ts:125`) pliega los turnos viejos en **un solo mensaje `system`** con
  el prefijo `[Memoria previa compactada]` (`history.ts:61-64`).
- El contenido de ese bloque lo produce `summarizeHistory` (`history.ts:13`), que **trunca cada mensaje
  a 500 caracteres** (`history.ts:20`) y corta el total al 20 % de la ventana de contexto
  (`history.ts:14`). Es un resumen de texto, no un almacén: no se puede consultar, no sobrevive a la
  sesión y no se puede recuperar por tema.
- `estimateHistoryTokens` (`history.ts:7`) estima por `caracteres / 4` y sólo se usa como fallback en
  `SessionManager.status()` (`core/src/session/SessionManager.ts:1005`).
- La persistencia es **un JSON por sesión** (`core/src/session/SessionStore.ts:10` `SessionRecord`,
  `:50` `save`), con `writeFileSync` completo, sin lock ni `tmp+rename` (hueco 8 de
  `docs/ARCHITECTURE.md:49`). Una sesión nueva no ve nada de las anteriores: `load()`
  (`SessionManager.ts:261`) sólo rellena `this.history` con `record.history`.

Consecuencias concretas, no teóricas:

1. **Cada sesión empieza amnésica.** El usuario repite el contexto del proyecto en cada `/new`.
2. **La compactación pierde información para siempre.** Lo que `summarizeHistory` recorta a 500 chars
   no está en ningún otro sitio.
3. **Los hijos (`spawn`) no comparten nada.** `SessionManager.ts:627` crea un `SessionManagerImpl`
   nuevo con `initialize({ agent })`; el único canal es el `context` que el padre pasa a mano
   (`SessionManager.ts:635`) y el resultado que vuelve (`formatSpawnResult`, `SessionManager.ts:690`).
4. **No hay memoria de proyecto.** El `workspaceRoot()` (`SessionManager.ts:910`) se anuncia en el
   system prompt (`core/src/agents/defaults.ts:29`) pero no se recuerda nada de lo aprendido ahí.

El hueco está abierto y sin decisión en `core/TODO.md:108-111`:

```
8. memory
- define how the memory will work
- select memory provider (postgress, enmgram, etc)
```

Y el punto 6 del mismo TODO (`core/TODO.md:113`, `mcp connections`) sigue sin hacer: **el harness no
tiene cliente MCP**. Eso condiciona el diseño (ver §3.4 y §7, F-M5). Aviso de lectura: la numeración
de `core/TODO.md` es inconsistente — la memoria es el **8** (`:108`), MCP el **6** (`:113`) y después
reaparece un `8. skills` (`:117`) —, así que esos números no indican orden real ni prioridad: cita por
línea, no por número.

### Restricciones que mandan

| # | Restricción | Consecuencia de diseño |
|---|---|---|
| R1 | La memoria es un **conector plug-and-play** (MCP, HTTP o local), no un acoplamiento a un producto | El seam es una interfaz propia; Engram/mem0/Zep son *implementaciones*, nunca el modelo de datos |
| R2 | `core/package.json` es un paquete **publicado**; hoy sólo tiene `dotenv`, `pino`, `pino-pretty` | Cero dependencias nuevas obligatorias. Todo lo pesado va detrás de `import()` dinámico o de un binario externo |
| R3 | No hay cliente MCP | MCP es una **fase posterior**, no el camino del MVP |
| R4 | Dos procesos (CLI corto + gateway de larga vida) que comparten estado **sólo por disco** (`docs/ARCHITECTURE.md:7-36`) | La memoria no puede ser un singleton en memoria del proceso; el backend tiene que ser un fichero o un servicio externo, nunca estado en RAM |
| R5 | Baseline 446 tests en verde y el prompt del sistema es **byte-idéntico** sin skills (`agents/defaults.ts:31-34`) | La memoria arranca **apagada por defecto**; con `memory.enabled = false` el comportamiento no cambia ni un byte |

## 2. Modelo de memoria

### 2.1 Tipos

| Tipo | Qué guarda | Dónde vive | MVP |
|---|---|---|---|
| **Working / sesión** | El historial vivo del turno | `SessionRecord.history` (`SessionStore.ts:26`) | Ya existe. **No se toca** |
| **Episódica** | Qué pasó: "arreglamos el login tocando `auth/token.ts`" | Backend de memoria, `scope: project` | **Sí** |
| **Semántica / hechos** | Qué es verdad: "el build usa `pnpm -r build`", "Node 26 trae `node:sqlite` con FTS5" | Backend de memoria, `scope: project` o `user` | **Sí** |
| **Decisiones** | Qué se decidió y por qué, con revisiones | Backend, `topicKey` para upsert | **Sí** (es el caso de mayor valor: es lo que un humano no recuerda) |
| **Perfil** | Preferencias del usuario: idioma, estilo, "no escribas código" | Backend, `scope: user` | **Sí**, pero sólo lectura en el MVP |
| **Procedimental** | Cómo se hace algo, paso a paso | **Ya resuelto por skills** (`core/src/skills/Skill.ts:12`, cuerpo cargado por `use_skill`) | **No**. Duplicarlo sería dos fuentes de verdad |

El tipo procedimental se descarta a propósito: `core/src/skills/` ya es exactamente eso (índice en el
system prompt + carga perezosa con `use_skill`, `core/src/tools/useSkill.ts:6`). La memoria **no**
reimplementa skills; si un procedimiento hay que recordarlo, se escribe un `SKILL.md`.

### 2.2 Scopes

| Scope | Clave | Ejemplo | MVP |
|---|---|---|---|
| `user` | — (global del `$HOME`) | "el usuario escribe en español", "prefiere respuestas cortas" | Sí |
| `project` | `basename(workspaceRoot())` o `memory.project` | "este repo usa pnpm workspaces", "el login se arregló en `auth/token.ts`" | **Sí, es el scope central** |
| `session` | `sessionId` | "en esta sesión estamos migrando a v2" | No: eso ya es el historial |

`project` es el scope que resuelve el problema real (§1.1) y el que encaja con el modelo de dos
procesos: CLI y gateway sobre el mismo `workspaceRoot()` ven la misma memoria sin hablarse.

### 2.3 Qué entra en el MVP y qué no

**Entra:** `search` (léxico), `context` (bloque listo para inyectar), `capture` (escribir una
observación), `forget` (borrar), scopes `user`/`project`, tipos `episode`/`fact`/`decision`/`preference`,
un provider local sin proceso externo, un provider HTTP, y una tool `recall` para búsqueda bajo demanda.

**No entra (y por qué):**

- **Vectores / embeddings.** Añaden un modelo (descarga, ~100 MB), un proveedor de embeddings (otra API
  key) y una dependencia nativa. El MVP léxico resuelve "¿qué decidimos sobre el login?" cuando el
  usuario y el agente escriben en el mismo idioma. Se deja la puerta abierta (§7, F-M7) pero no se paga
  ahora.
- **RAG sobre el workspace** (indexar los ficheros del repo). Es otro problema (`core/TODO.md:115`,
  `RAG integration??`) y otro presupuesto de tokens. Mezclarlo con memoria haría el seam ambiguo.
- **Resolución de conflictos** (`memory_relations` de Engram, `mem_judge`). Requiere un modelo juzgando;
  es un producto encima de la memoria, no la memoria.
- **Sincronización entre máquinas.** El backend HTTP la da gratis si el usuario la quiere; el local no
  la promete.
- **Borrado duro / GDPR.** El MVP expone `forget`; que el backend lo haga *soft* o *hard* es asunto suyo
  y se documenta por provider (ver §5, el caso Engram).

## 3. El seam `MemoryProvider`

### 3.1 Principio

La interfaz **no menciona transporte, ni SQL, ni HTTP, ni MCP**. Sólo cuatro verbos de dominio
(`search`, `context`, `capture`, `forget`) más `health`/`capabilities`/`close`. Una implementación HTTP,
una MCP y una local caben porque las tres saben hacer esas cuatro cosas; lo que cambia es el adaptador,
no el contrato.

`context()` devuelve **texto markdown ya listo para inyectar** en vez de una lista de hits. Es
deliberado: es la única forma de que un backend que ya sabe componer contexto (Engram lo hace con
`GET /context`) no quede degradado a "dame hits y recompongo yo peor". Los backends que no lo tengan
nativo reutilizan el helper `composeContext()`.

### 3.2 La interfaz

`core/src/memory/Memory.ts` (nuevo):

```ts
export type MemoryScope = "user" | "project" | "session";

// `procedure` queda fuera a propósito: eso son skills (core/src/skills/Skill.ts).
export type MemoryKind = "fact" | "decision" | "episode" | "preference";

export interface MemoryQuery {
  text: string;
  scope?: MemoryScope;
  project?: string;
  sessionId?: string;
  kinds?: MemoryKind[];
  limit?: number;
}

export interface MemoryHit {
  id: string;
  kind: MemoryKind;
  scope: MemoryScope;
  title: string;
  // Ya recortado por el provider a `memory.maxHitChars`: el llamante no
  // vuelve a truncar ni confía en que quepa.
  content: string;
  score?: number;
  createdAt?: string;
  project?: string;
}

export interface MemoryObservation {
  kind: MemoryKind;
  scope: MemoryScope;
  title: string;
  content: string;
  project?: string;
  sessionId?: string;
  // Clave de upsert para hechos que evolucionan ("cómo se arregla el login"):
  // el backend reemplaza la revisión anterior en vez de acumular duplicados.
  topicKey?: string;
  metadata?: Record<string, string>;
}

export interface MemoryContextOptions {
  project?: string;
  sessionId?: string;
  scope?: MemoryScope;
  // Tope duro del bloque devuelto, en caracteres. El provider DEBE respetarlo.
  maxChars: number;
}

export interface MemoryCapabilities {
  search: boolean;
  context: boolean;
  capture: boolean;
  forget: boolean;
  // false en backends puramente léxicos (FTS5). El harness lo usa para avisar
  // al usuario de que una búsqueda semántica no va a funcionar, no para
  // cambiar el flujo.
  semantic: boolean;
  scopes: MemoryScope[];
}

export interface MemoryProvider {
  // Identificador estable para logs y para `memory.provider` en config.
  readonly id: string;
  capabilities(): MemoryCapabilities;
  // Nunca lanza: un backend caído es `{ ok: false }`, no una excepción.
  health(): Promise<{ ok: boolean; detail?: string }>;
  search(query: MemoryQuery): Promise<MemoryHit[]>;
  context(options: MemoryContextOptions): Promise<string>;
  capture(observation: MemoryObservation): Promise<{ id: string }>;
  forget(id: string): Promise<boolean>;
  close(): Promise<void>;
}
```

Reglas del contrato, que todo provider debe cumplir y que se testean una vez por provider:

1. **Ningún método lanza por un fallo del backend.** `search` devuelve `[]`, `context` devuelve `""`,
   `capture` devuelve `{ id: "" }`, `forget` devuelve `false`. El harness *además* envuelve cada llamada
   en un timeout (`memory.timeoutMs`, default 5000) y un `try/catch`, así que un provider mal escrito no
   puede tumbar un turno. Es la regla más importante del documento: **la memoria nunca rompe un turno**.
2. **`context()` respeta `maxChars`.** Si el backend no puede, trunca.
3. **`capture()` es idempotente por `topicKey`** cuando se da. Sin `topicKey`, cada llamada crea una
   observación nueva.

**Alcance del timeout.** El harness garantiza que *la espera* está acotada (`Promise.race` con
`memory.timeoutMs`), de modo que el turno continúa aunque el backend no responda. **No** garantiza
matar el trabajo del provider: una promesa que nunca resuelve sigue viva hasta que resuelva o el
proceso muera. Interrumpirla de verdad exige `node:worker_threads`, y esa decisión se toma en F-M2.

### 3.3 Bloque `memory` en `HarnessConfig`

Sigue el patrón exacto de `SkillsConfig` (`core/src/configuration/index.ts:50-61`) y de
`applyDefaults` (`:124`). En `core/src/configuration/index.ts`:

```ts
interface MemoryConfig {
  // Interruptor maestro. Apagado por defecto: con false el prompt y el
  // historial son byte-idénticos a los de hoy (R5).
  enabled?: boolean;
  // "none" | "local" | "http" | "mcp". Selecciona la implementación.
  provider?: string;
  // Scope por defecto de lo que se escribe y se busca.
  project?: string;
  // --- http ---
  url?: string;
  apikey?: string;
  // --- mcp ---
  command?: string;
  args?: string[];
  // --- local ---
  path?: string;
  // --- inyección ---
  injectOnStart?: boolean;
  maxContextChars?: number;
  maxHitChars?: number;
  // --- captura ---
  captureOnCompact?: boolean;
  // --- tool ---
  recallTool?: boolean;
  // --- red ---
  timeoutMs?: number;
}
```

Y en `applyDefaults` (`configuration/index.ts:124`), en el mismo estilo `??=`:

```ts
config.memory ??= {};
config.memory.enabled ??= false;
config.memory.provider ??= "local";
config.memory.injectOnStart ??= true;
config.memory.maxContextChars ??= 2000;
config.memory.maxHitChars ??= 1200;
config.memory.captureOnCompact ??= true;
config.memory.recallTool ??= true;
config.memory.timeoutMs ??= 5000;
config.memory.path ??= path.join(harnessHome(), "memory.db");
```

`enabled: false` por defecto es una decisión con consecuencia concreta: los 446 tests actuales y el
prompt byte-idéntico (`agents/defaults.ts:31-34`) siguen valiendo sin tocar un solo test, y un
consumidor del SDK que no configure nada no paga ni una llamada.

`project` se resuelve, si no está, a `path.basename(workspaceRoot())` — el mismo directorio que se
anuncia en el prompt (`SessionManager.ts:910`), para que CLI y gateway coincidan sin configuración
extra.

### 3.4 Relación con `compactHistory`: **complementa, no sustituye**

Decisión: `compactHistory` (`history.ts:37`) **se queda como está**, con su bloque
`[Memoria previa compactada]` intacto. Tres razones, cada una con consecuencia:

1. **Son problemas distintos.** `compactHistory` gestiona el *presupuesto de tokens del turno*; la
   memoria gestiona el *conocimiento entre sesiones*. Sustituir uno por otro dejaría al turno sin
   control de ventana cuando el backend esté caído.
2. **Ocho tests fijan la cadena exacta** `[Memoria previa compactada]`
   (`core/tests/session/history.spec.ts:35,59,87,105,129,150,177` y
   `core/tests/session/SessionManager.spec.ts:130`). Cambiarla es churn sin ganancia.
3. **El bloque compactado es el payload natural de `capture`.** Es exactamente el momento en que la
   información está a punto de perderse: si no se escribe ahí, no se escribe nunca. Esto hace la
   captura gratis (no hay una segunda llamada al modelo para resumir).

Cómo conviven, en concreto:

- **Inyección (lectura).** Al arrancar la sesión (`initialize`, `SessionManager.ts:220`; y `load`,
  `:262`) se pide `memory.context({ project, maxChars })` y, si devuelve algo, se inserta **un mensaje
  `system` propio** justo después de la persona, con prefijo fijo `[Memoria del proyecto]`. **No** se
  mete dentro de `composeSystemPrompt` (`agents/defaults.ts:20`): así esa función sigue siendo pura y su
  test de byte-identidad no se toca.
- **Idempotencia al reanudar.** `load()` reinyecta sobre un historial que ya trae el bloque de la
  ejecución anterior. Se añade `stripMemoryBlocks(history)` (filtra los `system` que empiezan por el
  prefijo) y se llama antes de inyectar. Mismo patrón que ya usa `applySystemPrompt(replace)`
  (`SessionManager.ts:1137`) para no duplicar la persona.
- **Captura (escritura).** En `compactSession()` (`SessionManager.ts:701`), tras compactar, se llama a
  `capture()` con el texto plegado. Para no romper `compactHistory`, se añade
  `compactHistoryWithSummary()` en `history.ts` que devuelve `{ history, summary, title }`, y `compactHistory`
  pasa a ser un wrapper de una línea que devuelve `.history`. `summary` y `title` salen ambos de
 `olderMessages` —los mensajes que se pliegan, no los que se conservan—, que es la única fuente
 coherente para los dos. Cero tests tocados.
- **Bajo demanda.** Tool `recall` (§3.5), análoga a `use_skill`: el índice/contexto va en el prompt, el
  detalle se pide cuando hace falta.

### 3.5 Tool `recall`

`core/src/tools/recall.ts`, calcada de `core/src/tools/useSkill.ts:6`:

```ts
class RecallTool implements Tool {
  name = "recall";
  description = "Search long-term memory (previous sessions, project decisions) by free text. Call it when the task may depend on something decided or learned before.";
  parameters = { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"], additionalProperties: false };
  execute(ctx, args) { /* ctx.recallMemory(query, limit) */ }
}
```

`ToolContext` (`core/src/tools/Tool.ts:18`) gana **un getter, no el provider**:

```ts
// Texto ya formateado con los hits, o "" cuando no hay memoria disponible.
// Getter y no provider: ToolContext es interfaz pública (mismo criterio que
// getSkillBody, Tool.ts:31).
recallMemory?: (query: string, limit?: number) => Promise<string>;
```

Registro en `createToolRegistry` (`core/src/tools/index.ts:24`) con **la misma regla de allowlist que
`use_skill`** (`tools/index.ts:31-34`): sólo se ofrece si el agente no declara `tools:`. Un agente con
lista recibe exactamente su lista; para darle memoria se añade `recall` a su frontmatter. Preserva el
test de allowlist de `SessionManager.spec.ts`.

### 3.6 Superficie pública

`IHarness` (`core/src/contract.ts:64`) gana, en el bloque `--- memory ---`:

```ts
// Estado del backend de memoria. `ok: false` no es un error del harness.
memoryStatus(): Promise<{ provider: string; ok: boolean; detail?: string }>;
// Búsqueda directa, sin pasar por el modelo (para el CLI y el gateway).
searchMemory(query: string, limit?: number): Promise<MemoryHit[]>;
```

Y `core/src/index.ts` exporta `MemoryProvider`, `MemoryHit`, `MemoryObservation`, `MemoryQuery`,
`MemoryCapabilities`, `MemoryConfig` y las factorías. Nada más: el resto es interno.

## 4. Matriz comparativa

Criterios, en el orden en que importan para este repo:

- **Distribución**: ¿entra con `npm i @racso2609/core` o exige instalar algo aparte?
- **Vectores**: ¿hay recall semántico o sólo léxico?
- **Proceso extra**: ¿hace falta un daemon corriendo?
- **Deps al consumidor**: qué arrastra al `node_modules` de quien usa el SDK (R2).
- **Encaje con dos procesos por disco** (R4).
- **Esfuerzo**: para tener el MVP funcionando.
- **Lock-in**: cuánto cuesta salir.

| Opción | Distribución | Vectores | Proceso extra | Deps al consumidor | Encaje 2 procesos/disco | Esfuerzo | Lock-in |
|---|---|---|---|---|---|---|---|
| **Engram 3.6.2** | Binario Go (brew/tap), **no npm** | **No** (FTS5 puro; columnas `embedding*` reservadas y sin usar) | Sí, `engram serve` en `:7437` | **0** (es un binario) | **Bueno**: SQLite en `~/.engram/engram.db`, HTTP por red local | Bajo (API REST ya probada) | Medio: modelo `observations`/`sessions`/`topic_key` propio, pero exportable |
| **mem0ai 3.3.1** (Apache-2.0) | npm | Sí (pluggable Qdrant/pgvector/sqlite-vec) | No (librería) | **Alto**: arrastra `openai` + `axios` | Malo: estado en proceso + necesita un vector store aparte | Medio | Alto: su modelo de `memories` y su extractor LLM |
| **honcho-ai 0.2.0** (Apache-2.0) | npm | Sí (servicio) | Sí (servicio Honcho) | Medio | Malo: es un SaaS/servicio con su propio modelo de "peers" | Medio | Alto |
| **@getzep/zep-cloud 4.1.0** | npm (cliente) | Sí | Sí (cloud) | Medio | Malo: cloud obligatorio, datos fuera | Bajo | **Muy alto** |
| **SQLite propio (`node:sqlite` + FTS5)** | **Cero**: viene en Node 26 | No en MVP (sí después con `sqlite-vec`) | **No** | **0** | **Óptimo**: un `.db` en `~/.racso-harness/`, WAL, mismo disco que `sessions/` | Medio (esquema + FTS + tests) | **Nulo**: el esquema es nuestro |
| **LanceDB / Orama / Chroma** | npm | Sí | No | Alto (`@lancedb/lancedb` nativo, `chromadb` gordo; `@orama/orama` 0 deps) | Regular: índice en proceso, ficheros propios | Medio | Medio |
| **Qdrant / pgvector** | Servicio | Sí | **Sí** (contenedor + Postgres) | Cliente npm | Malo: un tercer servicio que el usuario tiene que operar | Alto | Bajo (SQL estándar) |
| **markdown + grep** | Cero | No | No | 0 | Bueno | **Muy bajo** | Nulo |

Lectura de la matriz:

- **Todo lo que trae vectores hoy cuesta una dependencia pesada o un servicio.** Con R2 (paquete
  publicado, 3 deps) eso es un no rotundo para el default.
- **`node:sqlite` con FTS5 es el único punto donde "léxico, cero deps, sin proceso, en el mismo disco"
  coinciden.** Verificado en local: Node 26.12.1 crea una tabla `fts5` virtual y consulta con `MATCH`.
- **Engram es el mejor "batteries included" para quien ya lo tenga**, y el peor default para un SDK
  publicado, porque exige `brew install`.
- **markdown+grep** se descarta como backend pero se queda como *fallback de emergencia*: es lo que hay
  si el usuario no quiere ni SQLite.

## 5. Veredicto sobre Engram

### A favor (con evidencia)

1. **Cero dependencias npm.** Es un binario Go, MIT, 7.8k estrellas, v3.6.2 (2026-11-04). Para R2 es
   imbatible: el consumidor del SDK no ve nada nuevo en su `node_modules`.
2. **Habla los dos transportes que el usuario pidió.** HTTP (`:7437`, `ENGRAM_PORT`) y MCP stdio
   (`engram mcp`, 27 tools, `initialize` responde `serverInfo {name:"engram",version:"3.6.2"}`).
3. **`GET /context?project=X&compact=true&max_bytes=2000` devuelve markdown listo para inyectar**
   (`## Memory from Previous Sessions` + `### Recent Sessions` + `### Recent Observations`). Esto es
   exactamente la forma de `MemoryProvider.context()`: el adaptador es casi un `fetch` y un `return`.
4. **`topic_key` con `revision_count`** resuelve el caso "decisión que evoluciona" sin que inventemos
   nada: es el upsert que pide `MemoryObservation.topicKey`.
5. **Modelo de datos sensato y exportable**: `observations` (type/title/content/topic_key/scope/project),
   `sessions`, `user_prompts`, `memory_relations`. Nada exótico.
6. **`expected_project` en las mutaciones** es una aserción de ownership barata que evita que dos
   proyectos se pisen.

### En contra (con evidencia)

1. **Hueco léxico confirmado, y es grave.** Es FTS5 puro, sin embeddings: las columnas `embedding`,
   `embedding_model`, `embedding_created_at` existen en el schema pero **están reservadas y sin usar**
   (verificado en `internal/store/store.go`: no hay cosine ni búsqueda vectorial). Pruebas reales:
   - buscar `"cómo arreglamos el login"` (español) contra una observación en inglés → `[]`;
   - buscar `"authentication token"` contra una observación sobre SQLite → `[]`.

   Consecuencia: **si el usuario escribe en español y el agente capturó en inglés (o al revés), la
   memoria es invisible.** No es un detalle de calidad: es la diferencia entre "recuerda" y "no
   recuerda". Y el harness es explícitamente multi-idioma (toda la doc está en español, los prompts en
   inglés).
2. **El borrado es soft y bloquea el borrado de la sesión.** `DELETE /observations/1?expected_project=X`
   → `{"hard_delete":false,"status":"deleted"}`, y después `DELETE /sessions/probe-1` sigue devolviendo
   `409 session still has observations`. Consecuencia: no hay forma de cumplir un "bórralo de verdad"
   sin tocar el SQLite a mano. Para `forget()` es un contrato incumplido en silencio.
3. **Exige instalar un binario.** `brew install gentleman-programming/tap/engram`. Para un paquete
   publicado en npm eso no es una dependencia, es un **prerrequisito de sistema** que hay que
   documentar, detectar y degradar. Un `npm i @racso2609/core` no puede asumirlo.
4. **27 tools MCP** es una superficie enorme para mapear a 4 verbos. La mayoría (`mem_judge`,
   `mem_consolidate`, `mem_merge_projects`, `mem_compare`…) son producto, no memoria.
5. **Un proceso más que operar.** `engram serve` tiene que estar vivo; si no, la memoria desaparece
   (silenciosamente, si el adaptador está bien hecho).

### Cuándo Engram es la respuesta correcta

- El usuario **ya lo tiene instalado** o quiere memoria compartida entre varias herramientas/agentes
  (Claude Code, Cursor, el harness) con una UI y un `engram.db` común.
- El trabajo es **monolingüe** y con términos técnicos exactos (`SQLite`, `pnpm`, `SessionStore`), donde
  FTS5 acierta.
- Se quiere memoria **entre máquinas** (su cloud opcional sobre Postgres).
- Se acepta que el borrado es lógico.

### Cuándo Engram **no** es la respuesta

- Como **default** de un SDK publicado (punto 3 de arriba).
- Como **única** memoria cuando el usuario trabaja en español y el agente captura en inglés (punto 1).
- Cuando haga falta **borrado real** (punto 2).
- Cuando no se quiera operar ningún proceso.

**Conclusión:** Engram es un **excelente provider HTTP**, no la capa de memoria. Encaja en el seam como
una implementación de primera clase, documentada y opcional. No puede ser el default ni el modelo.

## 6. Recomendación

### Principal: **seam propio + `LocalMemoryProvider` (node:sqlite FTS5) como default + Engram como provider HTTP**

En este orden, y con este reparto de responsabilidades:

1. **El seam `MemoryProvider` (§3) es lo único que el core conoce.** Ni Engram ni SQLite aparecen en
   `SessionManager`, en `contract.ts` ni en el prompt.
2. **`LocalMemoryProvider` es el default** (`memory.provider = "local"`): `node:sqlite` con FTS5, un
   fichero `~/.racso-harness/memory.db`, cero dependencias npm, cero procesos, mismo disco que
   `sessions/` (R4). Es el único que cumple R2 y R4 a la vez.
3. **`HttpMemoryProvider` + adaptador Engram** es la primera alternativa real y se entrega en la misma
   tanda de fases: es lo que convierte "plug-and-play" en verdad y lo que permite decir "si ya usas
   Engram, apunta `memory.url` y listo".
4. **`McpMemoryProvider` se difiere** a F-M5 porque depende del cliente MCP, que no existe
   (`core/TODO.md:113`). El seam ya lo admite sin cambios: es un adaptador más.

### Alternativas

- **A1 — Engram como único backend.** Menos código (un adaptador y ya), pero incumple R2 (binario
  obligatorio), tiene el hueco léxico confirmado y no borra de verdad. Sólo válido si el usuario decide
  que Engram es un requisito de instalación del harness. **Rechazada como default, aceptada como
  provider.**
- **A2 — `@orama/orama` como backend local.** Apache-2.0, 0 dependencias, híbrido BM25+vector: daría
  recall semántico sin proceso. **Rechazada por ahora** por dos motivos concretos: (a) mete una
  dependencia npm en un paquete publicado, que es justo lo que R2 quiere evitar; (b) su índice vive en
  memoria y se serializa a un fichero propio, lo que encaja peor con dos procesos escribiendo (R4) que
  un SQLite con WAL. Queda como plan B si FTS5 se queda corto y no se quiere `sqlite-vec`.

### Descartes con motivo

| Opción | Motivo del descarte |
|---|---|
| **mem0ai** | Arrastra `openai` + `axios` al consumidor (R2) y necesita un vector store aparte; su extractor LLM impone su modelo de memoria (lock-in alto) |
| **honcho-ai** | Servicio con su propio modelo de "peers/sessions"; no encaja con dos procesos por disco (R4) |
| **@getzep/zep-cloud** | Cloud obligatorio: los datos del usuario salen de su máquina. Inaceptable como default |
| **Qdrant / pgvector** | Un tercer servicio que el usuario tiene que operar (contenedor + Postgres) para una función que debe ser invisible |
| **LanceDB / Chroma** | Dependencia nativa pesada para el MVP; el vector no es el problema que hay que resolver primero |
| **markdown + grep** | Sin índice, sin scopes, sin `topicKey`; escala mal y no da `context()` barato. Se queda como fallback documentado, no como provider |
| **Vectores en el MVP** | Añaden modelo + API key + dependencia nativa antes de haber validado que la memoria léxica sirve. F-M7 |

## 7. Plan por fases

Estilo de `docs/ARCHITECTURE.md:97-105`: cada fase tiene entrega, criterio de cierre verificable y
dependencia. **Ninguna fase toca `compactHistory` ni el prompt byte-idéntico.**

### F-M0 — Tipos, config y provider nulo

**Entrega.** `core/src/memory/Memory.ts` (interfaz y tipos de §3.2), `core/src/memory/NoopMemoryProvider.ts`
(`id: "none"`, todo vacío, `capabilities()` con `false` en todo), `core/src/memory/index.ts` (exports),
`MemoryConfig` + defaults en `core/src/configuration/index.ts` (§3.3), exports en `core/src/index.ts`.
`MemoryConfig` se **exporta** desde `core/src/configuration/index.ts` y desde `core/src/index.ts`,
siguiendo el precedente de `SkillsConfig` (`core/src/index.ts:12`: el módulo publica el tipo aunque
`HarnessConfig` (`configuration/index.ts:103`) y `applyDefaults` (`:124`) sean internos). No se exporta
`applyDefaults`: el patrón del repo es leer los defaults a través de `new Config()`.

**Cierre.**
- `pnpm --filter @racso2609/core test` en verde con los 446 actuales **sin modificarlos**.
- Test nuevo `core/tests/configuration/memory.spec.ts` con el patrón real de `config.spec.ts:11-14`
  (`applyDefaults` no se exporta, `configuration/index.ts:124`): `vi.stubEnv("RACSO_HARNESS_CONFIG_LOCATION",
  <fichero>)`, luego `new Config()` y aserciones sobre `config.config.memory` — `enabled === false`,
  `provider === "local"`, `maxContextChars === 2000`, `timeoutMs === 5000`.
- Test de regresión: una sesión con `memory.enabled = false` produce un `history[0].content`
  byte-idéntico al de hoy (mismo patrón que el test de byte-identidad de skills).
- El test de regresión de byte-identidad **se traslada a F-M2**: es allí donde existe la inyección y
  donde el test puede discriminar de verdad, con una aserción sobre `history[0]` de una sesión real. En
  F-M0 no hay ruta de memoria activa que pudiera tocar el prompt, así que un test aquí sería un
  duplicado del de `skills.spec.ts:178` que pasaría aunque la memoria estuviera mal configurada.

**Depende de:** nada. **Bloquea a:** todas.

### F-M1 — `LocalMemoryProvider` sobre `node:sqlite` + FTS5

**Entrega.** `core/src/memory/LocalMemoryProvider.ts` y `core/src/memory/schema.ts`. Esquema:
`observations(id, kind, scope, project, session_id, title, content, topic_key, created_at, updated_at,
revision_count)` + `observations_fts` (`fts5(title, content, content='observations',
content_rowid='id')`) con triggers de sincronización. `PRAGMA journal_mode=WAL` y
`PRAGMA busy_timeout=5000` al abrir (R4: dos procesos). `topicKey` → `INSERT … ON CONFLICT(topic_key)
DO UPDATE SET revision_count = revision_count + 1`. `memoryHome()` en `core/src/utils/env.ts` junto a
`agentsHome()`/`skillsHome()` (`env.ts:12-18`), con `RACSO_HARNESS_MEMORY_LOCATION`.

**Cierre.** `core/tests/memory/LocalMemoryProvider.spec.ts`:
- `capture` 3 observaciones y `search` por un término presente devuelve la correcta y sólo esa;
- `search` por un término ausente devuelve `[]` (no lanza);
- dos instancias sobre el mismo fichero: la segunda ve lo que escribió la primera (prueba de R4);
- `capture` dos veces con el mismo `topicKey` deja **una** fila con `revision_count === 2`;
- `forget` de un id existente devuelve `true` y la búsqueda posterior ya no lo encuentra;
- `context({ maxChars: 200 })` devuelve un string de longitud ≤ 200.

**Depende de:** F-M0. **Riesgo abierto:** `core/package.json:17` declara `engines: node >=20.11` y
`node:sqlite` no está en 20. Ver §8, riesgo 6.

### F-M2 — Inyección del contexto + tool `recall`

**Entrega.** En `SessionManager`: `memoryProvider` (creado por una factoría
`createMemoryProvider(config)` en `core/src/memory/index.ts`), `injectMemoryContext()` llamado desde
`initialize()` (`SessionManager.ts:220`) y `load()` (`:262`), `stripMemoryBlocks()` en
`core/src/memory/context.ts` con `MEMORY_BLOCK_PREFIX = "[Memoria del proyecto]"`, y
`recallMemory()` en `toolContext()` (`SessionManager.ts:914`). **Punto único de inyección:** el bloque
se inyecta sólo en `load()` (sesiones reanudadas — `SessionManager.ts:302`, el camino que usa
`initialize()` con `const resumed = options.sessionId && (await this.load(...))`, `:251`) y en la rama
`if (!resumed)` de `initialize()`, justo **después** de `applySystemPrompt()` (`:253-256`), para sesiones
nuevas. `injectMemoryContext()` no se llama en ningún otro sitio, y en ambos caminos `stripMemoryBlocks()`
se ejecuta **antes** de inyectar, de modo que la operación es idempotente. Tool `core/src/tools/recall.ts`,
registrada en `createToolRegistry` (`tools/index.ts:24`) con la regla de allowlist de `use_skill`
(`tools/index.ts:31`). `ToolContext.recallMemory` en `core/src/tools/Tool.ts:18`.

**Timeout y providers que cuelgan.** Si se decide interrumpir de verdad un provider que cuelga, la
vía es `node:worker_threads` (el único mecanismo que puede matar trabajo colgado en Node);
`Promise.race` sólo acota la espera. La decisión se toma aquí, no en F-M0.

**Cierre.** `core/tests/memory/injection.spec.ts` con un `FakeMemoryProvider`:
- con `injectOnStart: true` y un provider que devuelve `"X"`, `history[1]` es un `system` que contiene
  `[Memoria del proyecto]` y `"X"`, y `history[0]` sigue siendo la persona;
- idempotencia probada en los dos caminos por separado: (a) sesión **nueva**, `initialize()` sin
  `sessionId` → rama `!resumed` → `applySystemPrompt()` → `injectMemoryContext()`; (b) sesión
  **reanudada**, `initialize({ sessionId })` → `load()` → `applySystemPrompt(Boolean(record.agentId))`
  → `injectMemoryContext()`, también al reabrir un `SessionRecord` que ya trae el bloque. En ambos,
  tras la segunda pasada, `history.filter(m => m.content.startsWith(PREFIX)).length === 1`;
- con `memory.enabled: false` el historial no gana ningún mensaje (regresión de R5);
- un provider cuyo `context()` **lanza** no rompe `initialize`: el historial queda sin bloque y se
  loguea un `warn`;
- `recall` con un provider que devuelve hits produce un `ToolResult` con el texto; con un provider que
  lanza, `isError: true` y el turno continúa;
- un agente con `tools: ["readFile"]` **no** recibe `recall` (allowlist intacta).

**Depende de:** F-M0, F-M1.

### F-M3 — Captura al compactar

**Entrega.** `compactHistoryWithSummary()` en `core/src/session/history.ts` (devuelve
`{ history, summary, title }`; `compactHistory` pasa a ser `compactHistoryWithSummary(...).history`, una
línea, sin tocar su firma ni su comportamiento). El `title` **no** puede salir del historial ya
compactado: en `compactSession()` (`SessionManager.ts:701-717`) `this.history` ya fue reemplazado por
`compactHistory(...)`, así que su primer `user` es el primero de la ventana reciente y no el primer turno
de la sesión; y `summary` lo produce `summarizeHistory` sobre los mensajes viejos (`olderMessages`), otra
fuente distinta del historial nuevo. Por eso el título lo calcula `compactHistoryWithSummary()` a partir
de `olderMessages[0]` (su primer `user`, recortado) y lo devuelve junto al `summary`: el contrato del
helper es `{ history, summary, title }`. En `SessionManager.compactSession()`, tras compactar y sólo si
`changed`, `capture({ kind: "episode", scope: "project", title, content: summary, project, sessionId })`
con `captureOnCompact`, tomando `title` y `summary` de lo que devolvió `compactHistoryWithSummary()`. Redacción previa de secretos
(`sk-…`, `Bearer …`, `apikey=…`) en `core/src/memory/redact.ts`.

**Cierre.** `core/tests/memory/capture.spec.ts`:
- compactar un historial `u1…u6` llama a `capture` **una** vez, el `content` contiene `"u1"` y el
  argumento `title === "u1"` (viene de `olderMessages[0]`, no del primer `user` del historial ya
  compactado);
- `compactHistory` sigue devolviendo exactamente lo que devolvía (los 8 tests de
  `history.spec.ts` verdes sin tocarlos);
- un provider cuyo `capture()` lanza no rompe `compactSession()`: devuelve `true` y el historial quedó
  compactado;
- `redact("key sk-abc123")` no contiene `sk-abc123`.

**Depende de:** F-M2.

### F-M4 — `HttpMemoryProvider` + adaptador Engram

**Entrega.** `core/src/memory/HttpMemoryProvider.ts` (sólo `fetch`, sin dependencias) y
`core/src/memory/engram.ts` con el mapeo verificado:
`context()` → `GET /context?project=X&compact=true&max_bytes=<maxChars>`;
`search()` → `GET /search?q=<text>&project=X&response_format=compact` (los hits llegan en
`results[]` con `{id,title,type,scope,preview,state,review_after,sync_id}`);
`capture()` → `POST /observations` con `{session_id, type, title, content, project}`;
`health()` → `GET /health` (`{status:"ok",service:"engram",version,instance_id,capabilities}`);
`forget()` → `DELETE /observations/<id>?expected_project=X`, devolviendo `true` **sólo** si la respuesta
no trae `hard_delete: false` (documentando que Engram hace soft-delete). `capabilities().semantic =
false`. `memory.apikey` opcional como `Authorization`.

**Cierre.** `core/tests/memory/HttpMemoryProvider.spec.ts` contra un servidor `node:http` **stub en
proceso** (no requiere Engram instalado): verifica path, query string y body exactos de las 5 llamadas;
un `500` degrada a `[]`/`""`/`false` sin lanzar; un servidor que no responde en `timeoutMs` degrada
igual. Más `scripts/memory-smoke.mjs` (documentado, no en CI) que corre contra un Engram real y hace
`health → capture → search → context`.

**Depende de:** F-M2. **No depende de F-M1.**

### F-M5 — Cliente MCP + `McpMemoryProvider`

**Entrega.** `core/src/mcp/client.ts`: JSON-RPC 2.0 sobre stdio (`initialize` → `tools/list` →
`tools/call`), con `id` incremental, timeout y `close()`. `core/src/memory/McpMemoryProvider.ts`
mapeando `mem_search`, `mem_context`, `mem_save`, `mem_delete` (los 4 de los 27 que son memoria).
`memory.provider = "mcp"` con `command`/`args`.

**Cierre.** `core/tests/mcp/client.spec.ts` contra un servidor stdio falso (un `.mjs` que responde
`initialize` con `serverInfo` y `tools/call` con `content:[{type:"text",text:"<json>"}]`): handshake,
`tools/list`, `tools/call` con el JSON desempaquetado, y matar el proceso hijo deja de colgar. Test del
provider: `search` mapea `mem_search` y parsea el JSON de `content[0].text`.

**Depende de:** F-M4 (comparte el patrón de degradación) y del punto 6 de `core/TODO.md:113`.
**Dimensión:** ~300 LOC + tests; es la fase más cara y por eso va la última de las de backend.

### F-M6 — CLI

**Entrega.** En `cli/src/commands/CommandRepository.ts` (junto a `/skills`, `:146`): `/memory` (estado
del backend vía `memoryStatus()`), `/memory search <q>` (vía `searchMemory()`, sin llamada al modelo, sin
entrada en el historial — mismo criterio que `/skill <id>`, `CommandRepository.ts:153`), `/memory on|off`
(escribe `config.memory.enabled` y persiste). Formateador en `cli/src/render/status.ts`.

**Cierre.** `cli/tests/commands/CommandRepository.spec.ts`: `/memory` con backend caído imprime el
detalle y no lanza; `/memory search x` no incrementa el historial; `/memory off` deja
`config.memory.enabled === false` en el `config.json` escrito.

**Depende de:** F-M2.

### F-M7 — (diferido) Vectores

`sqlite-vec` cargado con `loadExtension` de `node:sqlite` (verificado que existe en Node 26) sobre la
misma tabla, con embeddings de `ollama` local o `fastembed`. **No se planifica hasta que F-M1..F-M4
lleven un mes en uso y haya evidencia de fallos de recall léxico.** Criterio de entrada: una lista real
de búsquedas que FTS5 falló.

### Diferido explícitamente

- RAG sobre el workspace (`core/TODO.md:115`).
- Resolución de conflictos / `memory_relations`.
- Sincronización entre máquinas.
- Borrado duro y exportación GDPR.
- Memoria procedimental (es skills).
- UI de memoria en el frontal web (F3 de `docs/ARCHITECTURE.md`).

### Orden y dependencias

```
F-M0 ──► F-M1 ──► F-M2 ──► F-M3
                    │
                    ├──► F-M4 ──► F-M5
                    └──► F-M6
```

Camino crítico para "memoria funcionando de verdad": **F-M0 → F-M1 → F-M2 → F-M3**. Con eso el harness
recuerda entre sesiones sin instalar nada. F-M4 es lo que hace verdad el "plug-and-play".

## 8. Riesgos

| # | Riesgo | Mitigación concreta |
|---|---|---|
| 1 | **El backend de memoria caído rompe el turno** | Doble red: el contrato obliga a no lanzar (§3.2, regla 1) **y** el harness envuelve cada llamada en `try/catch` + `Promise.race` con `memory.timeoutMs` (5000). Test explícito en F-M2 y F-M4 con un provider que lanza y otro que cuelga |
| 2 | **Inyección de prompt a través de la memoria** (contenido de una sesión anterior o de una tool entra como `system`) | El bloque va con prefijo fijo y una línea que lo declara contexto, no instrucciones; `maxContextChars` (2000) y `maxHitChars` (1200) acotan; **nunca** se inyecta salida de tool en crudo, sólo el resumen de `summarizeHistory` ya truncado a 500 chars/mensaje (`history.ts:20`) |
| 3 | **Secretos capturados** (una API key en un mensaje acaba en `memory.db`) | `redact()` en F-M3 sobre el texto antes de `capture`, con patrones `sk-`, `Bearer`, `apikey=`, `token=`. Test unitario obligatorio |
| 4 | **La memoria infla el contexto y dispara compactaciones** | El bloque cuenta en `status().contextUsage` **sólo cuando `getContextTokens()` es 0**: `this.provider?.getContextTokens() \|\| estimateHistoryTokens(this.history)` (`SessionManager.ts:1005`) no ejecuta el fallback en el caso normal, así que a partir del primer turno lo mide el provider **y el coste es real**, no gratis. Además `compactHistory` conserva todos los `system` (`history.ts:46`), así que el bloque no desaparece al compactar y se acumula con cada reinyección si no se limpia. Y sí entra en el presupuesto que dispara la auto-compactación por `autoCompactThreshold` (`configuration/index.ts:127`), lo que reabre el bucle riesgo → compactación → `capture` que acotan el riesgo 1 y F-M3. Mitigación: `maxContextChars` acotado (2000 por defecto ≈ 500 tokens) **y** `stripMemoryBlocks` obligatorio en cada reinyección, no opcional (F-M2, punto único de inyección), con un test de que dos reanudaciones consecutivas no acumulan bloques |
| 5 | **Dos procesos escriben `memory.db` a la vez** (CLI + gateway) | `PRAGMA journal_mode=WAL` + `PRAGMA busy_timeout=5000` al abrir (F-M1). WAL permite N lectores y 1 escritor con espera acotada; el test de dos instancias de F-M1 lo cubre |
| 6 | **`node:sqlite` no existe en Node 20** y `core/package.json:17` declara `engines: node >=20.11` | **Decisión pendiente** (ver Notas). Opción A: subir `engines` a `>=22.5` (donde `node:sqlite` aparece) y documentarlo en `docs/INSTALL.md`. Opción B: `import("node:sqlite")` dinámico dentro de `LocalMemoryProvider` y, si falla, degradar a `NoopMemoryProvider` con un `warn` y `memoryStatus().ok = false`. **Recomendación: B**, porque no rompe a nadie y el fallo es visible |
| 7 | **Lock-in al modelo de un producto** (Engram `observations`, mem0 `memories`) | El seam es nuestro y el esquema local también. `MemoryObservation` es un superconjunto mínimo; el adaptador traduce. Cambiar de backend = cambiar `memory.provider`, no migrar código |
| 8 | **El hueco léxico de Engram se descubre tarde** | `capabilities().semantic = false` es visible desde F-M4 y `/memory` lo imprime. Documentado en §5 con las dos pruebas que fallan. Un usuario que necesite semántica usa `local` + F-M7, no Engram |
| 9 | **`forget()` miente en Engram** (soft-delete) | El adaptador devuelve `false` cuando la respuesta trae `hard_delete: false`, y `/memory` lo reporta como "borrado lógico". No se promete lo que el backend no hace |
| 10 | **El cliente MCP (F-M5) se come el presupuesto** | Va el último de los backends y su cierre es un test contra un servidor stdio falso, no contra Engram. Si F-M5 se cae, el harness sigue teniendo memoria local y HTTP |
| 11 | **Regresión del prompt byte-idéntico** | `memory.enabled = false` por defecto y la inyección es un mensaje aparte, nunca dentro de `composeSystemPrompt` (`agents/defaults.ts:20`). Test de regresión en F-M2, donde existe la inyección y el test puede discriminar; en F-M0 no hay ruta de memoria activa que pudiera tocar el prompt |

## Notas de verificación

- **Leído del repo** (worktree `/Users/racso/work/racso/agent-harness-memory`, rama `docs/memory-options`):
  `core/src/session/history.ts`, `core/src/session/SessionStore.ts`,
  `core/src/session/SessionManager.ts` (líneas 200-330, 620-730, 900-960, 995-1060, 1120-1160),
  `core/src/configuration/index.ts`, `core/src/contract.ts`, `core/src/types/providers.ts`,
  `core/src/types/session.ts`, `core/src/skills/{Skill,SkillRegistry,index}.ts`,
  `core/src/tools/{index,Tool,useSkill}.ts`, `core/src/agents/defaults.ts`, `core/src/utils/env.ts`,
  `core/src/index.ts`, `core/package.json`, `core/TODO.md`, `docs/ARCHITECTURE.md`,
  `cli/src/commands/CommandRepository.ts`, `core/tests/session/history.spec.ts`.
- **Verificado empíricamente por el usuario** (no re-probado aquí): todo lo de §5 sobre Engram 3.6.2
  (endpoints, MCP stdio con 27 tools, hueco léxico, soft-delete, `internal/store/store.go`), las
  versiones y licencias de las alternativas npm, y que `node:sqlite` de Node 26.12.1 crea tablas `fts5`
  y consulta con `MATCH`. `node -v` en este worktree → `v26.12.1`.
- **No verificado / decidido con información incompleta:**
  1. **`engines` vs `node:sqlite`** (riesgo 6). No se comprobó en qué versión exacta `node:sqlite` dejó
     de ser experimental ni si `loadExtension` está disponible en 22.x. La recomendación (import
     dinámico + degradación) no depende de ese dato, pero la decisión de subir `engines` sí.
  2. **Formato exacto de `GET /search` con `response_format=compact`**: se conoce la forma de
     `results[]` (`{id,title,type,scope,preview,state,review_after,sync_id}`) pero no si `preview` viene
     ya truncado ni con qué tope. El adaptador de F-M4 debe tratar `preview` como el `content` del hit y
     aplicar `maxHitChars` por su cuenta.
  3. **`POST /observations` no documenta `topic_key` en el body** en los hallazgos disponibles (sí existe
     la columna y `mem_suggest_topic_key` como tool MCP). F-M4 **no** debe asumir que el upsert por
     `topicKey` funciona por HTTP: si no está, `capture` con `topicKey` degrada a insert y se anota.
  4. **Autenticación de Engram**: los hallazgos sólo muestran `expected_project` como aserción de
     ownership, no un esquema de auth. `memory.apikey` se deja opcional y sin comportamiento definido
     hasta que se pruebe contra un Engram con auth.
  5. **Coste real de `capture` en F-M3**: se asume que el resumen de `summarizeHistory` es un payload
     aceptable (≤ 20 % de la ventana, `history.ts:14`), pero no se midió cuántas observaciones genera una
     sesión larga. Si es ruido, `captureOnCompact` se apaga por config sin tocar código.
- **No se ejecutó ningún test ni build**: es un documento de diseño y no cambia comportamiento. El
  baseline de 446 tests en verde se da por bueno (reportado por el usuario).
