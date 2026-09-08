import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

function sourceFiles(path: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    if (statSync(child).isDirectory()) files.push(...sourceFiles(child));
    else if (/\.(?:ts|tsx)$/u.test(name)) files.push(child);
  }
  return files;
}

function localDependencyGraph(entrypoint: string): { files: Set<string>; builtins: Set<string> } {
  const files = new Set<string>();
  const builtins = new Set<string>();
  const pending = [entrypoint];
  while (pending.length > 0) {
    const file = normalize(pending.pop()!);
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:from\s+|import\s*\()\s*["']([^"']+)["']/gu)) {
      const specifier = match[1]!;
      if (specifier.startsWith("node:")) {
        builtins.add(specifier);
        continue;
      }
      let target: string | null = null;
      if (specifier.startsWith("@shared/")) target = join(root, "src", "shared", specifier.slice("@shared/".length));
      else if (specifier.startsWith(".")) target = resolve(dirname(file), specifier);
      if (target?.endsWith(".ts") || target?.endsWith(".tsx")) pending.push(target);
    }
  }
  return { files, builtins };
}

test("standalone repository MCP has no Mission Control, credential, database, or network dependency path", () => {
  const graph = localDependencyGraph(join(root, "src", "repository-mcp", "server.ts"));
  const names = [...graph.files].map((file) => relative(root, file));
  assert.equal(names.some((file) => /(?:^|\/)(?:mcp|workflows)(?:\/|$)/u.test(file)), false);
  assert.equal(names.some((file) => /(?:mission-mcp|db|registry|actions)\.ts$/u.test(file)), false);
  assert.deepEqual([...graph.builtins].filter((name) => ["node:http", "node:https", "node:net", "node:tls", "node:dns"].includes(name)), []);
  assert.doesNotMatch(names.map((file) => readFileSync(join(root, file), "utf8")).join("\n"), /MISSION_TOKEN|Authorization:\s*Bearer|\bfetch\s*\(/u);
});

test("standalone repository MCP reads its config through one no-follow file handle", () => {
  const source = readFileSync(join(root, "src", "repository-mcp", "server.ts"), "utf8");
  assert.match(source, /open\(configPath, constants\.O_RDONLY \| constants\.O_NOFOLLOW\)/u);
  assert.match(source, /configHandle\.stat\(\)/u);
  assert.match(source, /configHandle\.readFile\("utf8"\)/u);
  assert.doesNotMatch(source, /lstatSync\(configPath\)|readFile\(configPath/u);
});

test("worktree files open no-follow and non-blocking before post-open type validation", () => {
  const source = readFileSync(join(root, "src", "server", "repository", "reader.ts"), "utf8");
  const opened = source.indexOf("constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK");
  const verified = source.indexOf("const openedStat = await file.stat()", opened);
  const read = source.indexOf("await file.readFile({ signal })", verified);
  assert.notEqual(opened, -1);
  assert.equal(opened < verified && verified < read, true);
});

test("Persona workload executor remains unreachable from production Workflow code", () => {
  const imports = sourceFiles(join(root, "src"))
    .filter((file) => !file.includes(`${join("workflows", "persona-workload")}/`))
    .filter((file) => /(?:from\s+|import\s*\()["'][^"']*persona-workload/u.test(readFileSync(file, "utf8")))
    .map((file) => relative(root, file));
  assert.deepEqual(imports, []);
});

test("existing Inspector security ownership does not depend on repository access", () => {
  const inspectorFiles = sourceFiles(join(root, "src", "server", "inspector"));
  const repositoryImports = inspectorFiles
    .filter((file) => /(?:from\s+|import\s*\()["'][^"']*repository\//u.test(readFileSync(file, "utf8")))
    .map((file) => relative(root, file));
  assert.deepEqual(repositoryImports, []);
});
