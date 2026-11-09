# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo. El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto se adhiere a [Versionado Semántico](https://semver.org/lang/es/).

## [Unreleased]

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

[Unreleased]: https://github.com/racso2609/agent-harness/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/racso2609/agent-harness/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/racso2609/agent-harness/releases/tag/v1.0.0
