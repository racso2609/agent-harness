# Sesiones concurrentes y el comando `/new`

Estado: planeación — nada implementado todavía. (2026-11-07)

Índice: [`../../TODO.md`](../../TODO.md) · TODO vivo: [`../../cli/TODO.md`](../../cli/TODO.md)

Este documento es el análisis de viabilidad de un comando `/new` que abra una sesión nueva
sin detener la que está en curso, de modo que el usuario pueda saltar de una a otra sin
tocar el trabajo que corre debajo. **No es** un plan de implementación, ni un registro de
nada hecho, ni una promesa: describe qué costaría cada camino, qué se rompe si se intenta,
y qué decisiones siguen abiertas para la próxima ronda de planeación.

## Qué queremos

Tres cosas, en orden de importancia:

1. `/new` abre una sesión nueva. La anterior deja de estar en primer plano, pero **sigue
   viva**: si tenía un turno corriendo, ese turno sigue corriendo.
2. Se puede cambiar de sesión en cualquier momento y volver más tarde, sin perturbar lo que
   estuviera pasando debajo.
3. La sesión que no se está mirando puede terminar su trabajo, o quedarse esperando una
   respuesta. En cualquier caso no se pierde.

El punto 2 es el que convierte esto en un problema de arquitectura y no en un comando más:
exige que haya más de una sesión viva en el mismo proceso.

## Por qué no es "solo un comando"

Hoy hay exactamente una sesión viva en todo el CLI.

`MainLoop` (`cli/src/MainLoop.ts`) es un bucle secuencial: pide un prompt con
`nextPrompt()`, ejecuta un único `await this.harness.ask(prompt, …)` dentro de `loop()`, y
vuelve a pedir otro prompt cuando ese turno cierra. Mientras el `await` está pendiente, el
bucle no atiende nada más que los eventos que el propio turno emite.

Un solo `IHarness` guarda esa única sesión. `Harness.loadSession()`
(`core/src/harness.ts`, alrededor de la línea 41) llama a `this.session.save()` y después a
`this.session.load(id)` sobre la **misma** instancia de `SessionManager`. Y `load()`
(`core/src/session/SessionManager.ts`, alrededor de las líneas 301-364) no crea nada: muta
la instancia en sitio —provider, modelo, historial, agente, registro de herramientas,
`undelivered`, `delivered`, `id`/`sessionId`. Es la operación correcta para `/resume`
(donde la sesión anterior ya terminó) y la equivocada para conmutación concurrente: si se
invoca a mitad de turno, el turno en vuelo se queda con el provider, el historial y el id
de otra sesión.

El renderer tampoco ayuda. `TuiUiAdapter` (`cli/src/ui/TuiUiAdapter.tsx`) guarda **un**
`TuiState`; su transcript es un único array `lines` (`TuiState` en
`cli/src/ui/tui/App.tsx`), y los campos de estado de la conversación son campos únicos de
`MainLoop`: la cola de prompts (`queue`/`pending`), `turnInFlight`, `autoContinuations`,
`noticedBatch`. Los campos de cola solo existen bajo la TUI: en modo línea no hay cola que
repartir (ver "Modo línea"), así que el troceado por sesión es un asunto de la TUI.

Hay además una cancelación que no existe. `createHarness()` (`core/src/harness.ts`,
alrededor de las líneas 162-173) sobrescribe el logger global del proceso (`setLogger`,
alrededor de la línea 164) y abre un `SessionStore` propio (alrededor de la línea 167).
No monta renderer ni toca la terminal, pero eso no lo hace barato: crear N sesiones no es
gratis, y por encima solo sobrevive el logger de la última. El detalle está en
"Aislamiento por sesión en el core". El problema real, aquí,
es que no hay forma de parar lo que una instancia está haciendo.

El costo de plomería tampoco es despreciable. `commandContext()`
(`cli/src/MainLoop.ts`, alrededor de las líneas 471-481) entrega la **misma** instancia
de `harness` en cada `CommandContext`, y `Flows` lo recibe como parámetro en cada uno de
sus métodos
(`cli/src/flows/index.ts`). Pasar a un registro de sesiones cambia una firma interna que
toca los 13 comandos de `cli/src/commands/CommandRepository.ts` que usan `context.harness`
(`/help`, `/exit` y `/clear` no lo tocan) y los 6 métodos de `Flows`.

## Los tres caminos

| Camino                                   | Qué es                                                                                        | Costo                                                                                                                | Riesgo                                                     | ¿Da ejecución en background?                                                                                                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. `/new` secuencial**                 | `save()` de la sesión actual y arranque de una nueva; la anterior queda pausada, no corriendo | ~1 archivo nuevo en `cli/src/flows/` + una entrada en `BUILT_IN_COMMANDS` de `cli/src/commands/CommandRepository.ts` | Ninguno: es lo que `/resume` ya hace, en la otra dirección | **No**: no da ejecución en background en el sentido de "corriendo". La sesión anterior queda persistida y se puede retomar, pero no sigue ejecutando nada mientras no se la mira |
| **B. Multiplexor real**                  | Varias instancias vivas de `IHarness` (una por sesión), una activa y N en background          | Clase c3, multi-módulo (`core` y `cli`)                                                                              | Alto: el modelo de concurrencia no existe hoy              | Sí                                                                                                                                                                               |
| **C. Superficie de conmutación sobre B** | `/sessions` con estado vivo (spinner del turno en background), `/new`, `/switch`              | Depende de B                                                                                                         | Medio: es UI sobre estado que B debe exponer               | Sí                                                                                                                                                                               |

A es barato y honesto, pero no cumple el punto 2 de "Qué queremos": no hay nada corriendo
debajo. B cumple la intención y es donde está todo el trabajo. C no tiene sentido sin B.

Conviene notar que `/resume` (con alias `/switch`) y `/sessions` ya existen hoy
(`cli/src/commands/CommandRepository.ts`), pero solo listan y conmutan sesiones
**persistidas**: leen el índice del `SessionStore` y cargan una en la misma instancia. La
superficie de C es la misma puerta con una columna más: qué sesiones están vivas ahora.

## Qué rompe exactamente en el camino B

### Aislamiento por sesión en el core

Cada sesión concurrente necesita su propio `IHarness` y su propio `SessionManager`.
`createHarness()` (`core/src/harness.ts`, línea 162) construye un `Config`, un
`SessionStore` y un `SessionManager` nuevos, así que llamarlo N veces es viable; lo que no
sirve es `loadSession()`, porque es intra-instancia (`this.session.load(id)`). El CLI
tendría que pasar de un `harness: IHarness` a un `Map<sessionId, IHarness>` con una sesión
activa, y todos los sitios que hoy hacen `this.harness.…` pasan a resolver contra la activa.
El camino actual es `createHarness()` seguido de `initialize()`: `createHarness()` ya
devuelve un `SessionManager` sin provider y sin modelo, y los hijos se construyen igual
(`SessionManagerImpl` directo más `initialize()`, alrededor de las líneas 672-674). Lo que
falta no es un arranque en blanco, sino una operación de `core` que cree una sesión
**nueva** y devuelva su harness sin pasar por `loadSession()`.

- **El logger es un singleton de proceso.** `createHarness()` (`core/src/harness.ts`,
  alrededor de las líneas 162-173) llama a `setLogger(...)`, que escribe el `active` de
  módulo en `core/src/utils/logger.ts` (alrededor de las líneas 69-71). Ese `active` lo
  comparten todas las llamadas a `logger.*` del core, así que gana el último `setLogger` y
  ninguna línea lleva etiqueta de sesión. Que la TUI lo descarte todo
  (`createLogger(() => {})` en `cli/src/ui/TuiUiAdapter.tsx`, alrededor de la línea 467) es
  la consecuencia, no la causa. Queda abierto si la salida debe ser un logger inyectado por
  instancia o un logger que lleve el `sessionId` en su contexto.
- **`save()` no sabe si hay un turno en vuelo.** `SessionManager.save()`
  (`core/src/session/SessionManager.ts`, alrededor de las líneas 413-440) serializa el
  registro entero y se llama en ocho sitios del mismo archivo. Los representativos son el
  arranque de la sesión en blanco al final de `initialize()` (alrededor de la línea 295),
  el arranque de `ask()` (alrededor de la línea 805) y cada settle de un hijo (alrededor
  de la línea 703). Fuera de ese archivo, `Harness.loadSession()` (`core/src/harness.ts`,
  alrededor de las líneas 46-48) añade dos saves más, uno a cada lado de `load()`, que
  es justo el peligro del que habla este párrafo. Con varias sesiones en un proceso,
  algo que hoy es "guardar al cerrar" pasa a escribir en el punto más caro del turno.
  Queda abierto si conviene un buffer por sesión o dejarlo así.

### Cancelación real

`ToolContext.signal` existe (`core/src/tools/Tool.ts`, línea 25) y `shell.ts` ya lo escucha
(`core/src/tools/shell.ts`, alrededor de la línea 176:
`ctx.signal?.addEventListener("abort", …)`). Pero `SessionManager.runAgentLoop`
(`core/src/session/SessionManager.ts`, alrededor de la línea 812) nunca crea un
`AbortController`, y el CLI no tiene ninguna noción de "cancela el turno en curso". Los
únicos `AbortController` del repo están en `core/src/session/spawn.ts` (líneas 63 y 126),
para los hijos: un grep sobre `core/src`, `cli/src` y `gateway/` no encuentra ningún otro.
Sin cancelación, un turno en background no se puede ni detener ni reiniciar limpio: cerrar
el CLI a medias es la única salida, y esa no la controlamos.

### Estado de UI por sesión

Hoy `turnInFlight`, la cola (`queue`/`pending`), `autoContinuations` y `noticedBatch` son
campos únicos de `MainLoop`, y el transcript es un único `lines` dentro del `TuiState` que
`TuiUiAdapter` guarda. Ojo: los campos de cola solo existen bajo la TUI, porque en modo línea
`nextPrompt()` lee stdin y no encola nada; el troceado por sesión es, por tanto, un asunto de
la TUI. Con N sesiones todo eso pasa a ser un objeto de vista por sesión
(`SessionView`): transcript, franja de hijos, estado de turno, cola y presupuesto de
continuaciones. En la TUI, `App.tsx` (`cli/src/ui/tui/App.tsx`, alrededor de la línea 80)
ya recibe el `TuiState` entero, y `lines` es solo un campo suyo (`TuiState` se define
alrededor de la línea 60); `TuiUiAdapter` es dueño del `state` y lo reemplaza de forma
inmutable en cada evento. Lo que tiene que cambiar es otra cosa: el adaptador pasa de
un `TuiState` a un `TuiState` por sesión, y `App` recibe además el `sessionId` activo.

### Interleaving de eventos

`MainLoop` registra un `harness.onSpawnEvent(...)` que escribe directo en el renderer, y
cada turno escribe sus eventos con `onEvent` en el mismo sitio. Con N sesiones los eventos
llegan intercalados sin decir de quién son.

Pero el problema de los hijos en background es peor que una etiqueta perdida: el listener
se enlaza **una sola vez**, en `MainLoop.start()` (`cli/src/MainLoop.ts`, alrededor de las
líneas 178-189), contra el único harness activo, y `createHarness` (`core/src/harness.ts`,
alrededor de las líneas 162-173) no ofrece forma de cambiarlo después. Con N harnesses, un
hijo de una sesión en background se queda en la cola `undelivered` de esa sesión y `MainLoop`
no se entera nunca: `maybeContinue()` ni siquiera llega a consultarse. Es pérdida silenciosa,
no una etiqueta equivocada.

La consecuencia es un requisito de fan-in: el CLI necesita un registro que suscriba cada
harness y etiquete sus eventos con su `sessionId`. Mientras ese registro no exista, los hijos
de una sesión en background son invisibles para el bucle. Eso no quita lo demás: hace falta
la etiqueta `sessionId` en cada evento de UI y un buffer para los de sesiones inactivas (o se
pierden, o se pintan en el transcript equivocado).

### Continuación automática

`maybeContinue()` (`cli/src/MainLoop.ts`) decide si un hijo que terminó merece un turno sin
prompt, y lo hace con una idea implícita de "**la** sesión": mira `pendingSpawns()` del
harness activo, el draft del input y un presupuesto de continuaciones. Con N sesiones, un
hijo de una sesión en background que termina podría disparar un turno que nadie está
mirando, gastando presupuesto y costo reales. La decisión no está tomada: este documento la
deja abierta (ver "Decisiones abiertas"). Sin política, C hereda el problema de B.

### Aprobaciones bloqueantes

`promptApproval()` y `select()` pertenecen al renderer, no a la sesión
(`cli/src/ui/UiAdapter.ts` las define; `CliUiAdapter` y `TuiUiAdapter` las implementan; el
`TuiUiAdapter` guarda **un** resolver pendiente de cada tipo, no una cola). Un turno en
background que pida aprobación se quedaría esperando a un resolver que no existe, o pintaría
el diálogo encima de la sesión que el usuario está mirando y se lo resolvería el primer
teclazo destinado a otra cosa. Hacen falta una cola de aprobaciones por sesión y una
política explícita de qué hacer con las de una sesión inactiva.

Esta duplicación no la estrena `/new`: ya ocurre hoy con los hijos de `spawn` de una sola
sesión, que heredan el handler del padre sin ninguna etiqueta
(`core/src/session/SessionManager.ts`, alrededor de la línea 675,
`child.approveWith(this.approvalHandler)`). `/new` no introduce la primera instancia del
problema: la multiplica.

Y no es solo una cola de UI: el handler de aprobación y la lista de permisos también son
por sesión, y deben seguir siéndolo. El handler se inyecta una vez por instancia con
`approveWith` (`core/src/session/SessionManager.ts`, alrededor de las líneas 1154-1157,
cableado desde `core/src/harness.ts`, alrededor de la línea 170), y `alwaysAllowed` vive en
el mismo `SessionManager` (alrededor de la línea 212). Eso es justo lo correcto: un
`always` concedido en la sesión A no puede autorizar nada en la sesión B. Por eso el handler y
la allow-list se quedan acotados a la sesión, y lo que se añade es la cola de aprobaciones, no
un handler global.

### Persistencia y cierre

`MainLoop.shutdown()` (llamado desde `SIGINT` y desde el comando `/exit`) llama a
`this.harness.shutdown()`, que guarda **una** sesión (`Harness.shutdown()` →
`this.session.save()`), y después a `process.exit`. Con N sesiones hay que guardar todas,
abortar los turnos vivos y decidir qué queda de un turno a medias en disco. Hoy el turno a
medias simplemente muere con el proceso, y `load()` ya trata a los hijos `running` como
interrumpidos, pero no hay nada equivalente para un turno del padre.

### El límite real del "background"

Todo esto es **un** proceso de Node y **un** event loop. Un turno en background avanza solo
cuando está esperando I/O: la respuesta del LLM, la salida de un `shell`, una lectura de
disco. Mientras espera, el turno en primer plano corre; mientras el turno en primer plano
hace CPU (ejecutar herramientas, renderizar markdown, repintar la TUI con Ink), el de
background no avanza. Es concurrencia cooperativa, no paralelismo: da la sensación de
background para turnos dominados por I/O, que son la mayoría, y no la da para turnos
dominados por herramientas locales. Aislamiento de verdad exigiría un proceso por sesión y
convertir el CLI en un cliente de esos procesos: otro producto.

## Modo línea

`CliUiAdapter` (`cli/src/ui/CliUiAdapter.ts`) lee stdin directamente para las aprobaciones y
las preguntas, y `MainLoop.nextPrompt()` en modo línea también lee stdin él mismo. No hay
cola donde encolar un prompt ni forma de pintar dos sesiones intercaladas en un scrollback.
Por eso `/new` con background solo tiene sentido bajo `--tui`. Lo razonable es rechazarlo en
modo línea con un aviso claro en vez de intentarlo a medias, pero eso todavía no está
decidido (ver "Decisiones abiertas"). No es solo cuestión de rechazarlo: el modo línea
no puede soportar la conmutación en absoluto, porque `CliUiAdapter` no guarda ningún transcript
propio (el manejo de `conversation`, `cli/src/ui/CliUiAdapter.ts`, alrededor de las líneas
161-168) y `MainLoop` se limita a repintar cuando cambia la sesión
(`cli/src/MainLoop.ts`, alrededor de las líneas 387-390).

## Recomendación provisional

Si la motivación real es "no perder un turno largo mientras pregunto otra cosa", buena parte
del valor (estimación, no una medición) está en **camino A + cancelación + cola de prompts por
sesión**. Eso da: poder soltar la sesión actual sin miedo, poder parar un turno que se
desbocó, y poder escribir mientras algo corre. El multiplexor completo (B + C) añade mucho
riesgo antes de que estén claras dos políticas que hoy no lo están: aprobaciones y
continuación automática.

Si se elige B + C, este es el orden de ataque razonable, de menos a más riesgo:

1. **Cancelación**: `AbortController` por turno en `runAgentLoop`, `signal` propagado al
   `ToolContext` (ya se respeta en `shell.ts`), y un comando para abortar.
2. **`createSession()` en core**: una operación explícita que devuelva un harness nuevo, en
   vez de reutilizar `loadSession()` mutando la instancia.
3. **`SessionView` en `MainLoop`**: sacar los campos únicos (`turnInFlight`, cola,
   `autoContinuations`, `noticedBatch`) a una estructura por sesión.
4. **Etiquetado de eventos**: `sessionId` en los eventos de UI y buffering de los de
   sesiones inactivas.
5. **Cola de aprobaciones**: por sesión, con política para las de sesiones inactivas.
6. **Política de continuación**: decidir si `maybeContinue()` corre en background.
7. **Shutdown múltiple**: guardar todas, abortar turnos, resolver el turno a medias.

Después de eso, `/new` y `/sessions` son casi triviales: son la superficie de un estado que
ya existe.

## Decisiones abiertas

Nada de lo siguiente está decidido. Es la agenda de la próxima ronda.

- ¿Continuación automática en sesiones en background: sí o no? ¿Y con qué tope de gasto?
- ¿Aprobaciones de una sesión inactiva: la sesión se bloquea hasta que la mires, o van a una
  cola global que el usuario ve en cualquier momento?
- ¿Un `IHarness` por sesión en el mismo proceso, o un proceso por sesión y el CLI como
  cliente?
- ¿Presupuesto y costo visibles por sesión, o solo el de la sesión activa?
- ¿Se permite `/spawn` desde una sesión inactiva, o hay que estar mirándola para lanzarlo?
- ¿Qué pasa con el turno a medias al cerrar: se descarta, se intenta terminar, o se guarda
  como interrumpido en el historial?
- ¿`/new` se rechaza en modo línea, porque `CliUiAdapter` no guarda transcript propio, o se
  acepta ahí en su variante secuencial (camino A)?
