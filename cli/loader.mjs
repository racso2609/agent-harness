// Entry imported via `node --import ./loader.mjs`. Registers the alias/
// extension resolve hook. `registerHooks` is the current (non-deprecated)
// synchronous API and is enough for our static specifiers.
import { registerHooks } from "node:module";
import { aliasResolve } from "./alias-hooks.mjs";

registerHooks({ resolve: aliasResolve });
