// Clean-install smoke test (closing criterion of F0, docs/ARCHITECTURE.md).
//
// Packs both packages with `pnpm pack`, asserts on the *contents* of the
// tarballs, then installs them into a throwaway consumer project with `npm`
// (what the end user runs) and checks that the CLI and the SDK work from
// outside the workspace. Everything happens under one temporary directory and
// one temporary HOME, so the real ~/.racso-harness/ is never touched; that is
// asserted too.
//
// Node builtins only. Run from the repo root: `node scripts/smoke-install.mjs`.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORE_NAME = "@racso2609/core";
const CLI_NAME = "@racso2609/cli";
const CLI_BIN = "racso-harness";
const EXPECTED_AGENTS = 6;
// Manifest entries no tarball may carry: source, tests or repo-only docs.
const CORE_FORBIDDEN = ["package/src/", "package/tests/", "package/TODO.md"];
const CLI_FORBIDDEN = ["package/src/", "package/tests/"];

const checks = [];
const describe = (values) => (values.length ? values.join(", ") : "(none)");

// Records one check. `run` throws (node:assert) with expected and found.
const check = (title, run) => {
  try {
    run();
    checks.push({ title, ok: true });
    process.stdout.write(`  ok   ${title}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    checks.push({ title, ok: false });
    process.stdout.write(`  FAIL ${title}\n       ${message.replace(/\n/g, "\n       ")}\n`);
  }
};

const entriesOf = (tarball) =>
  execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n").filter(Boolean);

const readPackedManifest = (tarball) =>
  JSON.parse(execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }));

const listMatching = (entries, prefix, suffix) =>
  entries.filter((entry) => entry.startsWith(prefix) && entry.endsWith(suffix));

// Snapshot of the real HOME so it can be compared before and after the run.
const realHarnessDir = path.join(os.homedir(), ".racso-harness");
const realHarnessBefore = fs.existsSync(realHarnessDir)
  ? fs.statSync(realHarnessDir).mtimeMs
  : null;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "racso-smoke-"));
const tmpHome = path.join(tmpRoot, "home");
const releaseDir = path.join(tmpRoot, "rel");
const consumerDir = path.join(tmpRoot, "consumer");
// Second consumer, its own HOME: only the cli tarball is installed there, on purpose.
const cliOnlyDir = path.join(tmpRoot, "consumer-cli-only");
const cliOnlyHome = path.join(tmpRoot, "home-cli-only");
for (const dir of [tmpHome, releaseDir, consumerDir, cliOnlyDir, cliOnlyHome])
fs.mkdirSync(dir, { recursive: true });

// The child processes never see the real HOME: harnessHome() reads $HOME, so
// everything the first run seeds lands under the temporary one.
const childEnv = {
  ...process.env,
  HOME: tmpHome,
  USERPROFILE: tmpHome,
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
  npm_config_loglevel: "error",
};

const cliOnlyEnv = { ...childEnv, HOME: cliOnlyHome, USERPROFILE: cliOnlyHome };

const cleanup = () => fs.rmSync(tmpRoot, { recursive: true, force: true });

// Anything unexpected aborts here: the temp tree is removed and the process
// leaves with a readable message instead of a stack trace.
const fail = (message) => {
  process.stdout.write(`\n${message}\n`);
  cleanup();
  process.exit(1);
};

const pnpmPack = (packageDir) => {
  const stdout = execFileSync("pnpm", ["pack", "--pack-destination", releaseDir], {
    cwd: path.join(repoRoot, packageDir),
    encoding: "utf8",
    env: childEnv,
  });
  return stdout.trim().split("\n").filter(Boolean).at(-1);
};

try {
  process.stdout.write(`smoke-install: repo ${repoRoot}\n`);
  process.stdout.write(`smoke-install: tmp  ${tmpRoot}\n\n`);

  process.stdout.write("1. pack\n");
  let coreTarball;
  let cliTarball;
  try {
    coreTarball = pnpmPack("core");
    cliTarball = pnpmPack("cli");
  } catch (err) {
    fail(`pnpm pack failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const tarball of [coreTarball, cliTarball]) {
    if (!tarball || !fs.existsSync(tarball)) fail("pnpm pack produced no tarball");
    process.stdout.write(`  ok   ${path.basename(tarball)}\n`);
  }

  process.stdout.write("\n2. tarball contents\n");
  const coreEntries = entriesOf(coreTarball);
  const cliEntries = entriesOf(cliTarball);
  const coreManifest = readPackedManifest(coreTarball);
  const cliManifest = readPackedManifest(cliTarball);

  check("core tarball ships package/dist/", () => {
    const hasDist = coreEntries.some((entry) => entry.startsWith("package/dist/"));
    assert.ok(hasDist, "expected package/dist/ entries in the core tarball, found none");
  });

  check(`core tarball ships the bundled agents (${EXPECTED_AGENTS} .md)`, () => {
    const agents = listMatching(coreEntries, "package/agents/", ".md");
    assert.equal(
      agents.length,
      EXPECTED_AGENTS,
      `expected ${EXPECTED_AGENTS} files under package/agents/, found ${agents.length}: ${describe(agents)}`,
    );
  });

  check("core tarball ships the bundled skills (.md)", () => {
    const skills = listMatching(coreEntries, "package/skills/", ".md");
    assert.ok(
      skills.length > 0,
      "expected .md files under package/skills/, found none (the first run would seed nothing)",
    );
  });

  check("core tarball excludes src/, tests/ and TODO.md", () => {
    const leaked = coreEntries.filter((entry) =>
      CORE_FORBIDDEN.some((prefix) => entry.startsWith(prefix)),
    );
    assert.deepEqual(leaked, [], `unexpected entries in the core tarball: ${describe(leaked)}`);
  });

  check(`core manifest name is ${CORE_NAME}`, () => {
    assert.equal(
      coreManifest.name,
      CORE_NAME,
      `expected name ${CORE_NAME}, found ${JSON.stringify(coreManifest.name)}`,
    );
  });

  check("core manifest keeps files and engines", () => {
    const missing = ["files", "engines"].filter((field) => !coreManifest[field]);
    assert.deepEqual(
      missing,
      [],
      `expected these fields in the packed core manifest, found none: ${describe(missing)}`,
    );
  });

  check("cli tarball ships package/dist/", () => {
    const hasDist = cliEntries.some((entry) => entry.startsWith("package/dist/"));
    assert.ok(hasDist, "expected package/dist/ entries in the cli tarball, found none");
  });

  check("cli tarball ships bin/run.mjs and racso-logo.txt", () => {
    const missing = ["package/bin/run.mjs", "package/racso-logo.txt"].filter(
      (entry) => !cliEntries.includes(entry),
    );
    assert.deepEqual(missing, [], `missing from the cli tarball: ${describe(missing)}`);
  });

  check("cli tarball excludes src/ and tests/", () => {
    const leaked = cliEntries.filter((entry) =>
      CLI_FORBIDDEN.some((prefix) => entry.startsWith(prefix)),
    );
    assert.deepEqual(leaked, [], `unexpected entries in the cli tarball: ${describe(leaked)}`);
  });

  check(`cli manifest name is ${CLI_NAME}`, () => {
    assert.equal(
      cliManifest.name,
      CLI_NAME,
      `expected name ${CLI_NAME}, found ${JSON.stringify(cliManifest.name)}`,
    );
  });

  check("cli manifest is not private", () => {
    assert.equal(
      cliManifest.private,
      undefined,
      `expected no "private" field in the packed cli manifest, found ${JSON.stringify(cliManifest.private)}`,
    );
  });

  check(`cli dependency on ${CORE_NAME} is rewritten to ^1.0.0`, () => {
    const dependency = cliManifest.dependencies?.[CORE_NAME];
    assert.equal(
      dependency,
      "^1.0.0",
      `expected ${CORE_NAME} to be "^1.0.0" (workspace:^ rewritten by pnpm pack), found ${JSON.stringify(dependency)}`,
    );
  });

  process.stdout.write("\n3. install into a clean consumer\n");
  fs.writeFileSync(
    path.join(consumerDir, "package.json"),
    `${JSON.stringify({ name: "racso-smoke-consumer", version: "1.0.0", private: true }, null, 2)}\n`,
    "utf8",
  );

  const install = spawnSync("npm", ["install", coreTarball, cliTarball], {
    cwd: consumerDir,
    env: childEnv,
    encoding: "utf8",
  });
  if (install.status !== 0) {
    fail(
      `npm install of the two tarballs failed (exit ${String(install.status)})\n` +
        `--- stdout ---\n${install.stdout}\n--- stderr ---\n${install.stderr}`,
    );
  }
  process.stdout.write("  ok   npm install <core.tgz> <cli.tgz>\n");

  process.stdout.write("\n4. the installed artefacts run\n");
  // `npx --no-install` runs exactly the installed binary, never a fetched one.
  const cliResult = spawnSync("npx", ["--no-install", CLI_BIN, "--version"], {
    cwd: consumerDir,
    env: childEnv,
    encoding: "utf8",
    input: "",
    timeout: 120_000,
  });
  const cliOutput = `${cliResult.stdout ?? ""}${cliResult.stderr ?? ""}`.trim();

  check(`npx ${CLI_BIN} --version exits 0 with a version`, () => {
    assert.equal(
      cliResult.status,
      0,
      `expected \`npx ${CLI_BIN} --version\` to exit 0, found ${String(cliResult.status)}` +
        (cliResult.error ? ` (${cliResult.error.message})` : "") +
        `\noutput:\n${cliOutput}`,
    );
    assert.match(
      cliOutput,
      /\d+\.\d+\.\d+/,
      `expected a version (\\d+.\\d+.\\d+) in the output of \`npx ${CLI_BIN} --version\`, found none` +
        `\noutput:\n${cliOutput}`,
    );
  });

  check(`import(${JSON.stringify(CORE_NAME)}) exposes createHarness`, () => {
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `import(${JSON.stringify(CORE_NAME)}).then((m) => console.log(typeof m.createHarness));`,
      ],
      { cwd: consumerDir, env: childEnv, encoding: "utf8", timeout: 120_000 },
    );
    const found = (result.stdout ?? "").trim();
    assert.equal(
      result.status,
      0,
      `expected the import to exit 0, found ${String(result.status)}\n${result.stderr ?? ""}`,
    );
    assert.equal(
      found,
      "function",
      `expected "function" from the SDK import, found ${JSON.stringify(found)}`,
    );
  });

 process.stdout.write("\n5. installing the cli tarball alone fails (negative)\n");
 // This assertion exists because the README documented `npm i -g <cli.tgz>` as valid and this
 // smoke test did not catch it: the cli declares @racso2609/core@^1.0.0, which is in no registry.
 fs.writeFileSync(
 path.join(cliOnlyDir, "package.json"),
 `${JSON.stringify({ name: "racso-smoke-cli-only", version: "1.0.0", private: true }, null, 2)}\n`,
 "utf8",
 );

 check("npm install <cli.tgz> alone fails with E404 on the core", () => {
 const alone = spawnSync("npm", ["install", cliTarball], {
 cwd: cliOnlyDir,
 env: cliOnlyEnv,
 encoding: "utf8",
 timeout: 120_000,
 });
 const output = `${alone.stdout ?? ""}${alone.stderr ?? ""}`;
 assert.notEqual(
 alone.status,
 0,
 `installing the cli tarball alone should fail: the core is not in any registry,` +
 ` but npm install exited 0\noutput:\n${output.trim()}`,
 );
 assert.match(
 output,
 /E404/,
 `expected E404 in the output of \`npm install <cli.tgz>\`, found none` +
 `\noutput:\n${output.trim()}`,
 );
 assert.match(
 output,
 /@racso2609\/core/,
 `expected @racso2609/core to be named in the E404 output, found none` +
 `\noutput:\n${output.trim()}`,
 );
 process.stdout.write(` saw E404 on ${CORE_NAME}:\n`);
 for (const line of output.trim().split("\n")) process.stdout.write(`   ${line}\n`);
 });

 process.stdout.write("\n6. the real HOME is untouched\n");
  check(`${realHarnessDir} unchanged`, () => {
    const existsAfter = fs.existsSync(realHarnessDir);
    if (realHarnessBefore === null) {
      assert.equal(
        existsAfter,
        false,
        `expected ${realHarnessDir} not to exist after the smoke test, but it was created`,
      );
      return;
    }
    assert.equal(existsAfter, true, `expected ${realHarnessDir} to still exist, but it is gone`);
    const after = fs.statSync(realHarnessDir).mtimeMs;
    assert.equal(
      after,
      realHarnessBefore,
      `expected the mtime of ${realHarnessDir} to stay at ${new Date(realHarnessBefore).toISOString()}, found ${new Date(after).toISOString()}`,
    );
  });
} catch (err) {
  fail(`unexpected failure: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
}

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);

if (failed.length) {
  process.stdout.write(`\nfailed:\n${failed.map((entry) => `  - ${entry.title}`).join("\n")}\n`);
  cleanup();
  process.exit(1);
}

process.stdout.write("\nsmoke-install: OK\n");
cleanup();
process.exit(0);
