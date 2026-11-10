# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo. El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto se adhiere a [Versionado Semántico](https://semver.org/lang/es/).

## [Unreleased]

## [1.1.2] - 2026-11-10

### Añadido

- **Parar un agente hijo en marcha**: `IHarness.cancelSpawn(spawnId)` interrumpe un hijo que está corriendo y `SpawnStatus` gana el estado `cancelled`. La cancelación no se queda en la marca: la señal de abort viaja hasta la petición que el hijo tiene en vuelo en el proveedor, así que una respuesta en streaming se corta en vez de esperarse, y las herramientas que la respetan matan su trabajo (el proceso de `shell` muere, aunque hoy lo reporte como un `timed out`). Un abort nunca se reintenta, porque reintentar es política de quien llama y una cancelación no es un fallo pasajero. Un hijo cancelado se asienta como tal y no arrastra el error del runner, deja de contar como trabajo pendiente para el padre (no vuelve tras un `/resume`) pero sí queda en el historial con la hora a la que se pidió pararlo. La petición se rechaza, sin lanzar, para un hijo desconocido, uno ya terminado o uno restaurado de una ejecución anterior, y aun así el handle apunta la hora de la cancelación en `cancelRequestedAt`: el usuario sí se rindió con ese hijo, y el handle lo dice.
- **`/stop` en el prompt**: sin argumentos para el único hijo vivo de golpe o un selector cuando hay varios, cada uno etiquetado con su identificador, su agente y su prompt; y `/stop <spawnId>` para uno concreto. Una parada que el núcleo no puede entregar se reporta como tal en lugar de anunciar un final que no va a ocurrir, y cerrar el selector no cancela nada (`Stop canceled`). La franja de progreso distingue además el hijo cancelado con un círculo tachado en amarillo, ni el spinner de uno vivo ni la cruz roja de uno fallido, porque cancelar es algo que pidió el usuario y no una avería.

### Cambiado

- **El mensaje que recibe el padre cuando un hijo supera `sessions.childResultMaxChars` cambia de forma**: antes era el informe cortado a secas; ahora lleva una cabecera, un `Resumen` de una línea, `Informe completo (M caracteres) en: <ruta>`, `Ajustado a N de M caracteres.`, la instrucción explícita de leer el fichero, un `---` y el cuerpo acotado. Por debajo del tope el mensaje sigue siendo byte a byte el mismo que antes, así que nada de lo que ya se leía cambia.
- **Aparece un directorio nuevo en el workspace del usuario**: `<workspace>/.racso-harness/artifacts/<sessionId>/<spawnId>.md` guarda el informe íntegro de cada hijo cuyo resultado supere `sessions.childResultMaxChars`; por debajo del tope no se escribe fichero, y un hijo cancelado no tiene informe que guardar. El `.gitignore` de este repositorio solo ignora `.racso-harness/` cuando el workspace es el propio repositorio, así que en el workspace de un usuario esos ficheros quedan sin ignorar y aparecerán como no rastreados en su control de versiones.

### Corregido

- **El informe de un hijo largo llegaba cortado al padre**: el mensaje que recibe el padre se recortaba a `sessions.childResultMaxChars` (2000 caracteres por defecto) y el padre decidía sobre un texto cortado a mitad de frase. Ahora el informe completo se escribe en `<workspace>/.racso-harness/artifacts/<sessionId>/<spawnId>.md`, dentro del workspace porque es donde las herramientas del padre pueden leer, y el mensaje lleva la ruta absoluta, un resumen de una línea, la longitud completa y la instrucción explícita de leer el fichero en vez de suponerlo. Por debajo del tope el mensaje es exactamente el de antes y no se escribe nada. La escritura es best-effort: si falla, la entrega degrada al mensaje acotado sin ruta, nunca se publica una ruta que no exista y no se escribe fuera del workspace ni a través de un symlink plantado. `SpawnHandle.resultChars` registra la longitud real al asentarse, así que quien consume el handle sabe que hubo recorte sin mirar si el texto acaba en puntos suspensivos.
- **El corte de la respuesta en streaming ya no se confunde con un fallo**: el proveedor relanza el motivo de la señal en vez de un error de aborto pelado y descarta el cuerpo a medio leer, de modo que lo que se reporta es la cancelación y no el error del transporte.

## [1.1.1] - 2026-11-09

### Añadido

- **Mantenimiento de la memoria por el agente**: dos herramientas nuevas, `remember` y `forget`, acompañan a `recall` para que el agente pueda escribir y borrar su memoria persistente en vez de limitarse a leerla. Aplican el mismo gate de allowlist que `recall`: un agente que declara `tools:` sigue recibiendo exactamente su lista. La tool `recall` pasa a imprimir el identificador de cada memoria encontrada, sin el cual `forget` no era alcanzable. El `forget` solo acepta identificadores numéricos, de modo que un id inventado se rechaza antes de llegar al provider.
- **Comandos del prompt**: `/memory recent [n]` lista las memorias más recientes con su identificador al frente y `/memory forget <id>` borra una, en lugar de tener que buscar lo que ya se conoce. Cierra la mitad de CLI de la deuda F-M6 anotada en `docs/MEMORY.md`.
- **Configuración de la memoria**: `memory.rememberTool` y `memory.forgetTool` apagan cada herramienta por separado, con el mismo interruptor que ya tenía `memory.recallTool`, y `memory.maxCaptureChars` (4000 por defecto) acota lo que se puede guardar en una sola observación.

### Cambiado

- **Borrado de memoria**: antes de borrar se pasa por el gate de aprobación como acción de escritura, con el identificador en el sujeto, y solo se alcanza una fila que la sesión posee.
- **Redacción de la captura**: `redact()` vive ahora en un único punto de escritura del session manager y cubre también el título de la memoria capturada al compactar, no solo el contenido.

### Corregido

- **Aislamiento de la memoria entre proyectos**: el índice único que sostiene el upsert por `topicKey` era global y el upsert reescribía el proyecto, así que una clave repetida en otro workspace reclamaba la fila ajena y la dejaba visible y borrable desde allí. El índice pasa a ser `(project, topic_key)` y el conflicto ya no reescribe el proyecto. En un fichero que ya contiene duplicados el índice nuevo no se puede crear: la escritura cae a una inserción plana y avisa una sola vez, en lugar de perder la observación en silencio.

## [1.1.0] - 2026-11-09

### Añadido

- **Soporte de MCP (Model Context Protocol)**: el harness puede conectarse a servidores MCP por stdio. Un `McpManager` posee las conexiones y las expone como herramientas, y `ToolRegistry` resuelve herramientas desde providers dinámicos, de modo que los agentes pueden usar las herramientas MCP incluso sin allowlist. Incluye el modelado del bloque `mcp` en la configuración del harness y su cableado en la sesión, el contrato y el CLI. El apagado es limpio: el cierre recorre el árbol de procesos para terminar el servidor y todos sus descendientes, con el periodo de gracia completo antes de escalar de `SIGTERM` a `SIGKILL` (el CLI acota el cierre completo a 3 s, con 500 ms de gracia por servidor, así que con varios servidores lentos el plazo se agota aunque ninguno ignore la señal).
- **Memoria del proyecto**: nueva costura (seam) de memoria con su bloque de configuración y un provider no-op por defecto, un provider local sobre `node:sqlite` + FTS5 y un provider que habla con Engram por HTTP; el backend MCP queda diferido (hoy solo `local` y `http`). La memoria se aísla por project key, se inyecta en el turno y se expone mediante recall.
- **Captura de memoria en la conversación**: lo que la compactación está a punto de descartar se captura como memoria.
- **Empaquetado**: ambos paquetes son instalables fuera del workspace.
- **Comandos del prompt**: `/resume` reanuda una sesión persistida desde la línea de comandos y `/memory` permite inspeccionar y alternar la memoria sin salir del prompt, y `/mcp` lista los servidores MCP y, con `/mcp reload`, cierra sus conexiones y las vuelve a descubrir (sin releer `config.json`) para recargarlos en caliente.

### Cambiado

- **Toolchain**: root, `core` y `cli` declaran `packageManager` en el nivel superior, donde Corepack y npm lo encuentran.
- **Comportamiento de los comandos del prompt**: en `/resume`, la sesión a reanudar se resuelve antes de pintar nada ni construir el renderer. En `/memory`, el cambio se aplica en la sesión siguiente.
- **Apagado del CLI**: la espera de cierre está acotada para que un `close()` colgado no retenga el proceso, el guardado se ejecuta fuera del plazo de cierre y un segundo `Ctrl-C` permite salir de inmediato.
- **Esquema JSON de herramientas MCP**: `default` y las propiedades anidadas quedan tipados en `JsonSchemaProperty`, y se descartan los tipos de propiedad que el esquema del harness no puede representar.
- **Documentación de usuario**: se documentan los servidores MCP, su alcance y las deudas pendientes, además del flag `resume` del CLI.

### Corregido

- **Compactación**: las sucesivas compactaciones ya no apilan bloques de contexto duplicados.
- **Parser de configuración MCP**: se cierran tres agujeros fail-open; arrancar servidores MCP ahora exige un `true` literal.
- **Herramientas MCP**: se eliminan los duplicados que producía la paginación, una entrada de allowlist se lee como el compuesto que ofrece el manager y solo se instala un provider MCP cuando un agente puede usarlo.
- **Cierre de conexiones MCP**: el transporte se cierra cuando la conexión falla, un manager cerrado no se reabre y el manager se cierra también cuando el guardado falla; si el cierre de MCP falla a su vez, se conserva el error del guardado.
- **Esquemas remotos**: se filtran las entradas no escalares de los enums.
- **Instalación**: corregido en el README el aviso sobre `.npmrc`.

## [1.0.0] - 2026-11-04

Primera versión: `@racso/core` y `@racso/cli` (renombrados a `@racso2609/*` en 1.1.0). El CLI (privado, no instalable) traía el stack de TUI y la persistencia de sesión. El contrato público del harness (`createHarness`, `IHarness`, `Config`, `SessionStore`), ya exportado en 1.0.0, se vuelve consumible de verdad en 1.1.0 al repararse el scope.

[Unreleased]: https://github.com/racso2609/agent-harness/compare/v1.1.2...HEAD
[1.1.2]: https://github.com/racso2609/agent-harness/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/racso2609/agent-harness/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/racso2609/agent-harness/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/racso2609/agent-harness/releases/tag/v1.0.0
