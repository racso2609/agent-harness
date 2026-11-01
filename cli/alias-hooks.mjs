// Resolve hook (loader thread). Node ESM needs explicit extensions and tsc
// keeps tsconfig `paths` aliases in the emitted JS, so the compiled output is
// not directly runnable. This hook:
//   - maps `@/x` to the importing package's `dist/x`,
//   - appends the missing `.js`/`/index.js` extension to relative specifiers.
// Works for both `core` and `cli` since it locates the package from the
// importing module's path.
import { accessSync, constants, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const EXTENSIONS = [".js", "/index.js"];

const exists = (file) => {
  try {
    accessSync(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const withExtension = (file) => {
  if (path.extname(file)) return exists(file) ? file : undefined;
  for (const ext of EXTENSIONS) {
    if (exists(file + ext)) return file + ext;
  }
  return undefined;
};

// Walks up from `fromDir` until it finds a directory that has both a
// package.json and a dist folder; returns that dist path.
const packageDist = (fromDir) => {
  let dir = fromDir;
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "dist"))) {
      return path.join(dir, "dist");
    }
    dir = path.dirname(dir);
  }
  return undefined;
};

export function aliasResolve(specifier, context, nextResolve) {
  const parentURL = context.parentURL;

  // Leave third-party dependencies (CJS/ESM in node_modules) untouched.
  if (parentURL?.startsWith("file:") && !parentURL.includes("node_modules")) {
    const parentDir = path.dirname(fileURLToPath(parentURL));

    if (specifier.startsWith("@/")) {
      const dist = packageDist(parentDir);
      if (dist) {
        const mapped = withExtension(path.join(dist, specifier.slice(2)));
        if (mapped) {
          return { url: pathToFileURL(mapped).href, shortCircuit: true };
        }
      }
    }

    if (specifier.startsWith(".")) {
      const mapped = withExtension(path.resolve(parentDir, specifier));
      if (mapped) {
        return { url: pathToFileURL(mapped).href, shortCircuit: true };
      }
    }
  }

  return nextResolve(specifier, context);
}
