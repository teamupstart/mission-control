import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import ts from "typescript";

import { EXECUTABLE_IDS } from "../src/shared/executables.ts";
import {
  EXECUTABLE_SPECS,
  FIXED_OS_EXECUTABLES,
} from "../src/server/executables/catalog.ts";

const ROOT = join(import.meta.dirname, "..");

const CHILD_PROCESS_METHODS = new Set([
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
  "spawn",
  "spawnSync",
]);

interface ExternalCall {
  operation: string;
  command: string;
  line: number;
}

interface ChildProcessBoundary {
  operation: string;
  command: string;
  contract:
    | "bootstrap-login-shell"
    | "current-runtime"
    | "locator-result"
    | "operator-command"
    | "resolved-path-parameter"
    | "test-provider";
  reason: string;
}

/**
 * Every direct `node:child_process` call, declared at call granularity rather than by a
 * self-attested source comment. The syntax-tree scan below must find this exact multiset.
 */
const CHILD_PROCESS_BOUNDARIES: Readonly<Record<string, readonly ChildProcessBoundary[]>> = {
  "src/pi/mcp-client.ts": [
    { operation: "spawn", command: "process.execPath", contract: "current-runtime", reason: "Pi runs the bundled MCP server with its own absolute Node runtime" },
  ],
  "src/main/integrations.ts": [
    { operation: "execFileSync", command: "executable.path", contract: "locator-result", reason: "resolved integration CLI removal" },
    { operation: "execFileSync", command: "executable.path", contract: "locator-result", reason: "resolved integration CLI registration" },
  ],
  "src/main/update-build.ts": [
    { operation: "spawn", command: "request.node", contract: "current-runtime", reason: "absolute runtime selected by Electron" },
  ],
  "src/main/updater.ts": [
    { operation: "execFile", command: "executable.path", contract: "locator-result", reason: "resolved GitHub CLI" },
    { operation: "spawn", command: "args.node", contract: "current-runtime", reason: "absolute detached helper runtime" },
  ],
  "src/main/update-runtime.ts": [
    { operation: "execFile", command: "executable", contract: "resolved-path-parameter", reason: "bounded probes of locator-selected Node and npm, and fixed OS env for child-runtime identity" },
  ],
  "src/server/claude-cli.ts": [
    { operation: "spawn", command: "executable.path", contract: "locator-result", reason: "resolved Claude CLI" },
  ],
  "src/server/executables/locator.ts": [
    { operation: "spawn", command: "shell", contract: "bootstrap-login-shell", reason: "bounded shell probe that constructs the locator snapshot" },
  ],
  "src/server/git/worktree-activity.ts": [
    { operation: "spawn", command: "executable.path", contract: "locator-result", reason: "resolved Git stream reader" },
  ],
  "src/server/harness/codex/sdk-deps.ts": [
    { operation: "spawn", command: "executable", contract: "resolved-path-parameter", reason: "Codex path resolved by the harness before transport creation" },
  ],
  "src/server/harness/pi/model-catalog.ts": [
    { operation: "spawn", command: "executable", contract: "resolved-path-parameter", reason: "Pi path resolved before catalog discovery" },
  ],
  "src/server/keep-awake.ts": [
    { operation: "spawn", command: "bin", contract: "test-provider", reason: "explicit fake provider retained for Linux-safe integration coverage" },
  ],
  "src/server/llm/codex.ts": [
    { operation: "spawn", command: "executable.path", contract: "locator-result", reason: "resolved Codex CLI" },
  ],
  "src/server/mission-mcp.ts": [
    { operation: "spawn", command: "descriptor.command", contract: "current-runtime", reason: "absolute Node or Electron runtime recorded in the MCP descriptor" },
  ],
  "src/server/session-files.ts": [
    { operation: "execFile", command: "executable.path", contract: "locator-result", reason: "resolved Git file reader" },
  ],
  "src/server/standards.ts": [
    { operation: "spawn", command: "executable.path", contract: "locator-result", reason: "resolved Git standards reader" },
  ],
  "src/server/terminal/herdr-client.ts": [
    { operation: "spawn", command: "executable", contract: "resolved-path-parameter", reason: "Herdr path resolved by the catalog-backed status probe before server startup" },
  ],
  "src/server/util/exec.ts": [
    { operation: "execFile", command: "resolved", contract: "locator-result", reason: "shared locator-backed execution primitive" },
  ],
  "src/server/workflows/check-identity.ts": [
    { operation: "execFileSync", command: "executable.path", contract: "locator-result", reason: "resolved process-status utility" },
  ],
  "src/server/workflows/check-spawn.ts": [
    { operation: "spawn", command: "runtime.command", contract: "operator-command", reason: "current runtime supervising operator-authored Workflow argv" },
  ],
};

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files;
}

function moduleName(node: ts.ImportDeclaration): string | null {
  return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
}

function externalCalls(file: string, source: string): {
  childProcess: ExternalCall[];
  sharedRun: ExternalCall[];
} {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const childBindings = new Map<string, string>();
  const childNamespaces = new Set<string>();
  const runBindings = new Set<string>();
  const runNamespaces = new Set<string>();

  for (const statement of tree.statements) {
    if (ts.isImportDeclaration(statement)) {
      const importedFrom = moduleName(statement);
      if (!importedFrom) continue;
      const clause = statement.importClause;
      if (clause?.name) {
        if (importedFrom === "node:child_process") childNamespaces.add(clause.name.text);
        if (/(?:^|\/)util\/exec\.ts$/.test(importedFrom)) runNamespaces.add(clause.name.text);
      }
      const bindings = clause?.namedBindings;
      if (!bindings) continue;
      if (ts.isNamespaceImport(bindings)) {
        if (importedFrom === "node:child_process") childNamespaces.add(bindings.name.text);
        if (/(?:^|\/)util\/exec\.ts$/.test(importedFrom)) runNamespaces.add(bindings.name.text);
        continue;
      }
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        const importedName = element.propertyName?.text ?? element.name.text;
        if (importedFrom === "node:child_process" && CHILD_PROCESS_METHODS.has(importedName)) {
          childBindings.set(element.name.text, importedName);
        }
        if (/(?:^|\/)util\/exec\.ts$/.test(importedFrom) && importedName === "run") {
          runBindings.add(element.name.text);
        }
      }
    }
  }

  function registerRequire(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression)
      && node.initializer.expression.text === "require"
      && node.initializer.arguments.length === 1
      && ts.isStringLiteral(node.initializer.arguments[0]!)
      && node.initializer.arguments[0]!.text === "node:child_process"
    ) {
      childNamespaces.add(node.name.text);
    }
    ts.forEachChild(node, registerRequire);
  }
  registerRequire(tree);

  const childProcess: ExternalCall[] = [];
  const sharedRun: ExternalCall[] = [];
  function record(target: ExternalCall[], operation: string, node: ts.CallExpression): void {
    const command = node.arguments[0]?.getText(tree) ?? "<missing>";
    const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
    target.push({ operation, command, line });
  }
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        const childOperation = childBindings.get(node.expression.text);
        if (childOperation) record(childProcess, childOperation, node);
        if (runBindings.has(node.expression.text)) record(sharedRun, "run", node);
      } else if (
        ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
      ) {
        const owner = node.expression.expression.text;
        const operation = node.expression.name.text;
        if (childNamespaces.has(owner) && CHILD_PROCESS_METHODS.has(operation)) {
          record(childProcess, operation, node);
        }
        if (runNamespaces.has(owner) && operation === "run") record(sharedRun, operation, node);
      } else if (
        ts.isElementAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.argumentExpression
        && ts.isStringLiteral(node.expression.argumentExpression)
      ) {
        const owner = node.expression.expression.text;
        const operation = node.expression.argumentExpression.text;
        if (childNamespaces.has(owner) && CHILD_PROCESS_METHODS.has(operation)) {
          record(childProcess, operation, node);
        }
        if (runNamespaces.has(owner) && operation === "run") record(sharedRun, operation, node);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return { childProcess, sharedRun };
}

function literalCommand(expression: string): string | null {
  if (expression.length < 2) return null;
  const quote = expression[0];
  return (quote === '"' || quote === "'" || quote === "`") && expression.at(-1) === quote
    ? expression.slice(1, -1)
    : null;
}

function boundarySignature(
  file: string,
  call: Pick<ExternalCall, "operation" | "command">,
): string {
  return `${file} ${call.operation}(${call.command})`;
}

function validBoundaryCommand(boundary: ChildProcessBoundary): boolean {
  switch (boundary.contract) {
    case "bootstrap-login-shell":
      return boundary.command === "shell";
    case "current-runtime":
      return ["args.node", "descriptor.command", "request.node", "process.execPath"].includes(boundary.command);
    case "locator-result":
      return boundary.command === "executable.path" || boundary.command === "resolved";
    case "operator-command":
      return boundary.command === "runtime.command";
    case "resolved-path-parameter":
      return boundary.command === "executable";
    case "test-provider":
      return boundary.command === "bin";
  }
}

test("every executable id has exactly one complete catalog declaration", () => {
  assert.deepEqual(Object.keys(EXECUTABLE_SPECS).sort(), [...EXECUTABLE_IDS].sort());
  for (const id of EXECUTABLE_IDS) {
    const spec = EXECUTABLE_SPECS[id];
    assert.equal(spec.id, id);
    assert.ok(spec.label.trim(), `${id} label`);
    assert.match(spec.command, /^[^/\\\s]+$/, `${id} command`);
    assert.ok(spec.overrideEnv === null || /^[A-Z0-9_]+$/.test(spec.overrideEnv), `${id} override`);
  }
});

test("literal external commands are declared or fixed absolute OS utilities", () => {
  const declared = new Set(Object.values(EXECUTABLE_SPECS).map((spec) => spec.command));
  const fixed = new Set<string>(Object.values(FIXED_OS_EXECUTABLES));
  const problems: string[] = [];
  for (const file of sourceFiles(join(ROOT, "src"))) {
    const source = readFileSync(file, "utf8");
    const calls = externalCalls(relative(ROOT, file), source);
    for (const call of [...calls.childProcess, ...calls.sharedRun]) {
      const command = literalCommand(call.command);
      if (!command) continue;
      if (declared.has(command) || fixed.has(command)) continue;
      problems.push(`${relative(ROOT, file)}:${call.line} invokes undeclared ${command}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("the child-process scanner follows import aliases and namespace calls", () => {
  const calls = externalCalls(
    "fixture.ts",
    [
      'import { spawn as nodeSpawn } from "node:child_process";',
      'import * as cp from "node:child_process";',
      'import childProcess from "node:child_process";',
      'const required = require("node:child_process");',
      "// executable-contract: comments grant no exemption",
      'nodeSpawn("aliased-tool", []);',
      'cp.spawn("namespaced-tool", []);',
      'childProcess["spawn"]("default-import-tool", []);',
      'required.spawn("required-tool", []);',
    ].join("\n"),
  );
  assert.deepEqual(
    calls.childProcess.map(({ operation, command }) => ({ operation, command })),
    [
      { operation: "spawn", command: '"aliased-tool"' },
      { operation: "spawn", command: '"namespaced-tool"' },
      { operation: "spawn", command: '"default-import-tool"' },
      { operation: "spawn", command: '"required-tool"' },
    ],
  );
});

test("every direct child-process call matches one structured executable boundary", () => {
  const observed: string[] = [];
  for (const file of sourceFiles(join(ROOT, "src"))) {
    const name = relative(ROOT, file);
    const source = readFileSync(file, "utf8");
    for (const call of externalCalls(name, source).childProcess) {
      observed.push(boundarySignature(name, call));
    }
  }
  const declared = Object.entries(CHILD_PROCESS_BOUNDARIES).flatMap(([file, boundaries]) =>
    boundaries.map((boundary) => {
      assert.ok(boundary.reason.trim(), `${file} ${boundary.operation}(${boundary.command}) needs a reason`);
      assert.equal(
        validBoundaryCommand(boundary),
        true,
        `${file} ${boundary.operation}(${boundary.command}) does not match ${boundary.contract}`,
      );
      return boundarySignature(file, boundary);
    }));
  assert.deepEqual(observed.sort(), declared.sort());
});
