# Contrato `@racso/core` / `cli`

Estado: diseño acordado (tarea #4). Implementación en tareas #6–#19.

## Principios

- `core` es un SDK **sin interacción**: no importa `node:readline`, no lee stdin
  para preguntar nada y no renderiza terminal. No existe `utils/stdin.ts` dentro
  de `core`.
- La composición es **in-process** (opción A2): `cli` importa `@racso/core`,
  construye un `IHarness` y aporta logger, aprobaciones y render.
- El boot técnico (config, providers, stores de sesión, agentes, tools) queda en
  `core`.
- `cli` es dueño del `MainLoop`, los slash commands, los flujos que eligen
  provider/model/agent/sesión, el logo y las imágenes.

## Tipos raíz

```ts
// core/src/contract.ts
import type { ApprovalDecision, ApprovalRequest } from "@/tools";
import type { AgentResponse, Model } from "@/types/providers";
import type { AgentSummary } from "@/agents";
import type { SessionStatus, SessionSummary } from "@/types/session";
import type { SpawnHandle } from "@/session/spawn";

export type LoggerLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

// Compatible estructuralmente con pino: (obj, msg) o (msg).
export interface ILogger {
  fatal(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  trace(obj: unknown, msg?: string): void;
}

// Recibe una línea ya formateada. El sink NO conoce prompts ni cursor.
export type LoggerSink = (line: string) => void;

export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;

export interface HarnessDeps {
  // Logger del harness. Por defecto escribe a stderr.
  logger?: ILogger;
  // Handler de aprobaciones interactivas. Sin handler, `ask` deniega.
  approval?: ApprovalHandler;
  // Config ya construida por el CLI (permite startSetup antes del boot).
  config?: Config;
  // Store de sesiones; por defecto el de `~/.racso-harness/sessions`.
  store?: SessionStore;
}

export interface HarnessOptions {
  // Reanuda una sesión persistida.
  sessionId?: string;
  // Agente inicial; por defecto el configurado.
  agent?: string;
}
```

## `IHarness`

```ts
export interface IHarness {
  // Boot: valida config, crea provider y carga agente/sesión.
  initialize(options?: HarnessOptions): Promise<void>;

  // Turno principal. `images` es dato de dominio; el CLI decide cómo pintarlo.
  ask(prompt: string, options?: AskOptions): Promise<AgentResponse>;
  // AgentResponse.outcome?: TurnOutcome = { status, pending[], next? }, para reportar
  // estado sin parsear texto. status: "completed" | "toolError" | "incomplete".
  // AskOptions.onEvent recibe el progreso del turno mientras se produce:
  // { type: "text" | "reasoning", delta }, { type: "toolCallStart" | "toolCallEnd", id, name }
  // y { type: "toolOutput", id, name, chunk } (salida viva de la tool, con throttle).
  // Omitirlo mantiene el comportamiento bloqueante de siempre.
 // AskOptions.unprompted?: true marca el prompt que no escribió el usuario: la sesión
 // arrancó el turno sola (una continuación automática tras asentarse un hijo). El turno
 // se guarda igual en el historial, porque el modelo tiene que verlo, pero conversation()
 // lo deja fuera y sessionTitle() lo ignora; su respuesta sí se muestra.

  // Snapshot de uso/coste/contexto y del agente/provider activos.
  status(): SessionStatus;

  // --- sesiones ---
  listSessions(): SessionSummary[];
  // Acepta id completo, prefijo único o índice 1-based de la lista.
  resolveSession(target: string): string | undefined;
  // Persiste la actual y carga la resuelta. false si no existe/ambigua.
  loadSession(target: string): Promise<boolean>;
  save(): void;
  // La conversación tal como la lee la UI, de la más antigua a la más reciente.
  // Solo user y assistant: se filtran system (persona, memoria de compactación),
  // la salida de tools, los turnos assistant sin texto y los turnos user marcados
 // `unprompted` (nadie los escribió; su respuesta sí se muestra). Devuelve una copia.
  conversation(): ConversationEntry[];

  // --- providers / modelos ---
  listProviders(): string[];
  listProviderDetails(): ProviderDetail[];
  // Crea o reemplaza una instancia (id libre + type de backend).
  configureProvider(
    id: string,
    provider: ProviderConfig,
    options?: { makeDefault?: boolean; model?: string },
  ): void;
  // Borra una instancia. false si no existe.
  removeProvider(id: string): boolean;
  setProvider(name: string): Promise<boolean>;
  listModels(): Model[];
  setModel(model: string): boolean;

  // --- agentes ---
  listAgents(): AgentSummary[];
  setAgent(agentId: string): Promise<boolean>;

  // --- skills ---
  // Skills cargadas en la sesion activa. Solo el indice: nunca el body.
  listSkills(): SkillSummary[];
  // Re-escanea config.skills.dirs y recompone el system prompt.
  reloadSkills(): SkillSummary[];

  // --- aprobaciones ---
  // Instala el handler que el CLI usa para preguntar (y/N/always).
  approveWith(handler: ApprovalHandler): void;

  // --- hijos en background ---
  spawn(agentId: string, prompt: string, options?: { context?: string }): SpawnHandle;
  pollSpawn(spawnId: string): SpawnHandle | undefined;
  listSpawns(): SpawnHandle[];
  // Suscripción en vivo a arranque/fin de hijos. Devuelve el unsubscribe.
  // No reenvía eventos pasados: el estado inicial se lee con listSpawns().
  onSpawnEvent(listener: SpawnEventListener): () => void;
  waitSpawn(spawnId: string): Promise<SpawnHandle | undefined>;
  collectSpawns(spawnIds?: string[]): Promise<SpawnHandle[]>;

  // --- mantenimiento ---
  compactSession(): Promise<boolean>;
  // Persiste sin salir del proceso. El CLI decide el exit code.
  shutdown(): void;
}
```

`IHarness` no expone `input`, `select`, `printLogo`, `printImage` ni callbacks de
render. Todo eso vive en `cli`.

## `createHarness`

```ts
export const createHarness = (deps: HarnessDeps = {}): IHarness => {
  const logger = deps.logger ?? createLogger();
  setLogger(logger);

  const config = deps.config ?? new Config();
  const store = deps.store ?? new SessionStore();
  const session = new SessionManager(config, store);

  if (deps.approval) session.approveWith(deps.approval);

  return new Harness(session, config, store);
};
```

`core/src/index.ts` solo re-exporta, sin efectos secundarios (hoy arranca
`MainLoop`). El binario pasa a `cli`.

## `createLogger`

```ts
// core/src/utils/logger.ts
export const createLogger = (sink?: LoggerSink): ILogger;
// Instala el logger activo para los módulos que importan `logger`.
export const setLogger = (logger: ILogger): void;
export { logger }; // proxy al logger activo
```

- `createLogger()` sin sink escribe líneas a `process.stderr`.
- `cli` pasa un sink que limpia/redibuja el prompt alrededor de cada línea.
- `logger.ts` deja de importar `stdin`; desaparecen `clearPrompt`/`restorePrompt`.
- Mientras la refactorización no inyecte el logger por constructor, `logger` es
  un proxy mutable (`setLogger`) para no tocar todos los providers/tools.

## `Config` sin setup interactivo

```ts
class Config {
  needsSetup(): boolean; // antes setupComplete()
  validateConfig(): {
    ok: boolean;
    errors: string[]; // provider default ausente, URL/key...
  };
  configureProvider(
    id: string,
    provider: ProviderConfig,
    options?: { makeDefault?: boolean; model?: string },
  ): void;
  removeProvider(id: string): boolean;
  listProviderDetails(): ProviderDetail[];
  writeConfig(): void;
}
```

`startSetup()` se elimina. El CLI implementa `startSetup` con `input`/`select`,
llama a `configureProvider(...)` y `writeConfig()`.

## Providers: id de instancia vs tipo de backend

`providers` es un **mapa de instancias**: la clave es un id libre elegido por el
usuario (`cheap`, `openrouter`, `work`, ...). El tipo de backend se declara en
el campo `type` y es lo que decide que implementacion de `Provider` se instancia.

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
    "apikey": "sk-or-...",
    "model": "openai/gpt-4o-mini"
  }
},
"defaultProvider": "cheap"
```

```ts
interface ProviderConfig {
  // Backend que interpreta url/apikey. Default "openai" (compatibilidad).
  type?: string;
  url: string;
  apikey: string;
  // Modelo preferido de esta instancia. Se usa como fallback cuando el
  // modelo activo no existe en la instancia destino (p.ej. al cambiar con
  // /provider entre dos instancias con catalogos distintos).
  model?: string;
}

interface ProviderDetail extends ProviderConfig {
  id: string;
  // true si es el defaultProvider del config.
  isDefault: boolean;
}
```

Reglas:

- `SUPPORTED_PROVIDERS` pasa a significar **tipos de backend** disponibles
  (hoy solo `"openai"`), no nombres de instancia.
- Al escribir la config desde el CLI, `type` se persiste explicitamente; al
  leerla, un provider sin `type` se interpreta como `"openai"` (las configs
  actuales con `providers.openai` siguen funcionando sin migracion).
- La sesion persiste el **id de instancia** en `record.provider`; los agentes
  (`provider:` en el markdown) tambien referencian un id de instancia.
- `Config` valida por entrada: `type` soportado, `url` y `apikey` no vacios. La
  seleccion de modelo efectivo sigue igual: `agent.model ?? config.model` con
  `providers.<id>.model` como fallback al cambiar de instancia.

## Primitivas de `SessionManager`

Se eliminan los métodos interactivos y `pickSession`/`promptApproval`:

```ts
setProvider(name: string): Promise<boolean>;
setModel(model: string): boolean;
setAgent(agentId: string): Promise<boolean>;
resolveSession(target: string): string | undefined;
listProviders(): string[];
approveWith(handler: ApprovalHandler): void;
```

`approve()` conserva la política (`read` allow, `deny` deny, `auto` allow,
`alwaysAllowed` por sujeto) y en modo `ask` delega en el handler inyectado:

```ts
protected async approve(request: ApprovalRequest): Promise<ApprovalDecision> {
  // ...política igual que hoy...
  if (mode === "auto") { this.alwaysAllowed.add(key); return "allow"; }
  if (!this.approvalHandler) {
    logger.warn("Approval required but no handler installed; denying");
    return "deny";
  }
  const decision = await this.approvalHandler(request);
  if (decision === "always") this.alwaysAllowed.add(key);
  return decision;
}
```

Las sesiones hijas creadas por `spawn` heredan `approvalHandler` y el logger
activo.

## Mapa: método interactivo actual → primitivas + flujo CLI

| Hoy (core)                               | Ahora en core                                                              | Flujo CLI                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `changeProvider(name?)`                  | `listProviders()`, `setProvider(name)`                                     | `flows/changeProvider.ts` pregunta con `select`                                |
| `changeModel(model?)`                    | `listModels()`, `setModel(model)`                                          | `flows/changeModel.ts` pregunta con `select`                                   |
| `changeAgent(id?)`                       | `listAgents()`, `setAgent(id)`                                             | `flows/changeAgent.ts` pregunta con `select`                                   |
| `changeSession(target?)` + `pickSession` | `listSessions()`, `resolveSession(target)`, `loadSession(target)`          | `flows/pickSession.ts` pregunta y llama `loadSession`                          |
| `promptApproval(request)`                | `approveWith(handler)`                                                     | `flows/promptApproval.ts` pregunta `y/N/always`                                |
| `Config.startSetup()`                    | `needsSetup()`, `validateConfig()`, `configureProvider()`, `writeConfig()` | `flows/startSetup.ts` pregunta URL/key/model                                   |
| — (nuevo)                                | `listProviderDetails()`, `configureProvider()`, `removeProvider()`         | `flows/addProvider.ts`, `flows/removeProvider.ts`, `/provider add\|rm\|ls\|id` |

## Mapa de archivos que se mudan a `cli`

| Origen (core)                       | Destino (cli)                       |
| ----------------------------------- | ----------------------------------- |
| `src/utils/stdin.ts`                | `src/terminal/stdin.ts`             |
| `src/utils/status.ts`               | `src/render/status.ts`              |
| `src/utils/commandMenu.ts`          | `src/terminal/commandMenu.ts`       |
| `src/session/MainLoop.ts`           | `src/MainLoop.ts`                   |
| `src/commands/CommandRepository.ts` | `src/commands/CommandRepository.ts` |
| `racso-logo.txt`                    | `racso-logo.txt`                    |
| `tests/utils/`                      | `tests/terminal/` + `tests/render/` |
| `tests/commands/`                   | `tests/commands/`                   |

Se quedan en core: `types/`, `providers/`, `tools/`, `agents/`,
`configuration/`, `session/{SessionManager,SessionStore,classifyAction,history,spawn}.ts`,
`utils/{env,logger,session}.ts`.

## Reglas de frontera

- `core` **no** puede importar `@/utils/stdin`, `terminal-image`, ni nada de
  `cli`.
- `core` no puede escribir prompts ni leer stdin para decisiones.
- `cli` no puede importar rutas internas de core; solo `@racso/core` (y tipos
  públicos re-exportados).
- Las imágenes se quedan como `AgentResponse.images: { url }[]`; el CLI las
  imprime o las vuelca a disco.
- El estado "always allow" de aprobaciones pertenece a core; el CLI solo
  recolecta la decisión.

## Riesgos / gotchas

1. **Logger singleton profundo.** `providers`, `tools` y `agents` importan
   `logger` directo. `setLogger` mantiene compatibilidad; no se debe crear un
   logger por harness que deje huérfanos a los módulos.
2. **`SessionManager` construye `Config`/`SessionStore` por defecto.** `Harness`
   debe pasar siempre las instancias de `HarnessDeps` para que el CLI comparta
   config y store.
3. **Hijos de `spawn`.** Deben recibir `approvalHandler`, config y store del
   padre; si no, las aprobaciones del hijo se denegarán.
4. **Prompt activo durante logs/aprobaciones.** El CLI necesita un renderer
   único (stdin + sink del logger) para no corromper la línea; core ya no lo
   resuelve.
5. **Tests actuales.** `SessionManager.spec.ts` mockea `utils/stdin`; pasa a
   probar `approveWith`. `CommandRepository.spec.ts` se muda con el comando.
6. **Ids de provider.** La clave de `providers` es el id de instancia y se
   persiste en sesiones y agentes. Renombrar un id deja huerfanas las sesiones
   viejas; `removeProvider` no borra historial, solo la entrada de config.
7. **`scripts/omniroute.ts`** importa `printImage`; deja de hacerlo y vuelca la
   URL/base64 con `console` (o se elimina el script si no aporta).
