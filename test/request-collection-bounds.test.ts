import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

/**
 * Every collection a request can make Zod parse carries an upper bound.
 *
 * GHSA-mrhx-c7xc-m3w5: Zod 3 parsed every element of an array, set or map - recording an issue
 * per bad one - before any length check ran, so an oversized request could exhaust memory on
 * the way to being refused. Zod 4.6.6 checks `.max()` FIRST, but only where there is a `.max()`
 * to check: an unbounded `z.array` still parses everything it is given. A record has no `.max()`
 * at all, which is what `boundedRecord` (`src/shared/zod-shapes.ts`) is for.
 *
 * So this walks every schema a request reaches and fails on a collection without a bound:
 *   - every schema the HTTP route files hand to `parseBody`, `parseBoundedBody` or `safeParse`,
 *     found by scanning those files so a new route cannot be missed by a hand-kept list;
 *   - the validators a request's `z.unknown()` field is later parsed with (ensemble strategy
 *     configs, task-source configs), the conductor ingest envelope and browser telemetry facts;
 *   - every MCP tool's input, read from the server's own `tools/list`, which is also the proof
 *     that list renders at all - Zod 4's JSON Schema renderer refuses `z.custom`, and one such
 *     field took every Mission tool down with it.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "request-collection-bounds-"));
process.env.HARNESS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { recordEntryBound } = await import("../src/shared/zod-shapes.ts");

type Schema = z.core.$ZodType;

/** The paths at which `schema` lets a request carry a collection of any size. */
function unboundedCollections(schema: Schema, path = "$", seen = new Set<Schema>()): string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const def = schema._zod.def as z.core.$ZodTypeDef & Record<string, unknown>;
  const checks = ((def.checks ?? []) as z.core.$ZodCheck[]).map((check) => check._zod.def.check);
  const bounded = (...kinds: string[]) => checks.some((kind) => kinds.includes(kind));
  const walk = (child: unknown, at: string) => unboundedCollections(child as Schema, at, seen);
  switch (def.type) {
    case "array":
      return [...(bounded("max_length", "length_equals") ? [] : [`${path} (array)`]), ...walk(def.element, `${path}[]`)];
    case "set":
      return [...(bounded("max_size", "size_equals") ? [] : [`${path} (set)`]), ...walk(def.valueType, `${path}<>`)];
    case "map":
      return [
        ...(bounded("max_size", "size_equals") ? [] : [`${path} (map)`]),
        ...walk(def.keyType, `${path}<key>`),
        ...walk(def.valueType, `${path}<value>`),
      ];
    case "record":
      // Reached only outside `boundedRecord`, whose pipe is recognised below.
      return [`${path} (record)`, ...walk(def.valueType, `${path}{}`)];
    case "pipe": {
      const out = def.out as Schema;
      if (recordEntryBound(schema) !== null && out._zod.def.type === "record") {
        return walk((out._zod.def as unknown as { valueType: Schema }).valueType, `${path}{}`);
      }
      return [...walk(def.in, path), ...walk(out, path)];
    }
    case "object":
      return Object.entries(def.shape as Record<string, Schema>).flatMap(([key, value]) => walk(value, `${path}.${key}`));
    case "union":
      return (def.options as Schema[]).flatMap((option, index) => walk(option, `${path}|${index}`));
    case "intersection":
      return [...walk(def.left, path), ...walk(def.right, path)];
    case "tuple":
      return [
        ...(def.items as Schema[]).flatMap((item, index) => walk(item, `${path}[${index}]`)),
        ...(def.rest ? [`${path}[...] (tuple rest)`, ...walk(def.rest, `${path}[...]`)] : []),
      ];
    case "lazy":
      return walk((def.getter as () => Schema)(), path);
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "catch":
    case "readonly":
    case "nonoptional":
      return walk(def.innerType, path);
    default:
      return [];
  }
}

/** The file that `specifier`, imported from `fromFile`, names. */
function moduleUrl(fromFile: string, specifier: string): string {
  if (specifier.startsWith("@shared/")) return pathToFileURL(join(ROOT, "src/shared", specifier.slice(8))).href;
  if (specifier.startsWith(".")) return pathToFileURL(resolve(dirname(join(ROOT, fromFile)), specifier)).href;
  return specifier;
}

/** The files that receive a request body and validate it. */
const ROUTE_FILES = [
  "src/server/routes.ts",
  "src/server/session-control.ts",
  "src/server/residents/routes.ts",
  "src/server/workflows/mcp.ts",
  "src/server/telemetry/primary-actions.ts",
  "src/server/telemetry/workflow-actions.ts",
];

/** Every request schema a route file parses, resolved through that file's own imports. */
async function routeRequestSchemas(): Promise<Map<string, Schema>> {
  const found = new Map<string, Schema>();
  for (const file of ROUTE_FILES) {
    const source = readFileSync(join(ROOT, file), "utf8");
    const names = new Set<string>();
    // Every schema named in the argument, so `A.merge(B)` and `A.extend({ input: B })` walk B too.
    for (const m of source.matchAll(/parse(?:Bounded)?Body\(\s*c,\s*([\s\S]*?)\)\s*;/g)) {
      for (const name of m[1]!.matchAll(/\b[A-Z][A-Za-z0-9_]*Schema\b/g)) names.add(name[0]);
    }
    for (const m of source.matchAll(/\b([A-Z][A-Za-z0-9_]*Schema)(?:\.[a-z]+\(\))?\.safeParse\(/g)) names.add(m[1]!);
    const imports = new Map<string, string>();
    for (const m of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g)) {
      for (const raw of m[1]!.split(",")) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop();
        if (name) imports.set(name, m[2]!);
      }
    }
    for (const name of names) {
      const specifier = imports.get(name);
      // A schema declared in the route file itself is not exported; it would have to be.
      assert.ok(specifier, `${file} parses ${name}, which it does not import - export it so this guard can see it`);
      const schema = (await import(moduleUrl(file, specifier)))[name] as Schema | undefined;
      assert.ok(schema?._zod, `${file} parses ${name}, which ${specifier} does not export as a schema`);
      found.set(`${name} (${file})`, schema);
    }
  }
  return found;
}

test("the guard sees an unbounded collection, and a bounded one is not reported", async () => {
  const { boundedRecord } = await import("../src/shared/zod-shapes.ts");
  assert.deepEqual(unboundedCollections(z.object({ a: z.array(z.string()), r: z.record(z.string(), z.number()) })), [
    "$.a (array)",
    "$.r (record)",
  ]);
  assert.deepEqual(
    unboundedCollections(z.object({ a: z.array(z.string()).max(3), r: boundedRecord(z.string(), z.number(), 3).optional() })),
    [],
  );
});

test("every request schema a route parses bounds every collection it carries", async () => {
  const schemas = await routeRequestSchemas();
  // The scan must actually find the surface, or an empty map would pass.
  assert.ok(schemas.size > 150, `only ${schemas.size} request schemas were found`);
  const unbounded = [...schemas].flatMap(([name, schema]) => unboundedCollections(schema).map((at) => `${name}: ${at}`));
  assert.deepEqual(unbounded, []);
});

test("the validators a request is handed on to bound every collection too", async () => {
  const { ConductorIngestEnvelopeSchema } = await import("../src/shared/protocol.ts");
  const { ENSEMBLE_STRATEGY_INFO } = await import("../src/shared/ensemble-strategies.ts");
  const { TASK_SOURCE_KIND_INFO } = await import("../src/shared/task-source.ts");
  const { browserIngressEvents } = await import("../src/shared/telemetry-catalog.ts");
  const schemas: [string, Schema][] = [
    ["ConductorIngestEnvelopeSchema", ConductorIngestEnvelopeSchema],
    ...Object.values(ENSEMBLE_STRATEGY_INFO).map((s): [string, Schema] => [`strategy ${s.id}`, s.configSchema]),
    ...Object.entries(TASK_SOURCE_KIND_INFO).map(([kind, s]): [string, Schema] => [`task source ${kind}`, s.configSchema]),
    ...browserIngressEvents().map((e): [string, Schema] => [`telemetry ${e.name}`, e.facts]),
  ];
  const unbounded = schemas.flatMap(([name, schema]) => unboundedCollections(schema).map((at) => `${name}: ${at}`));
  assert.deepEqual(unbounded, []);
});

test("external model replies and backup JSON also bound every collection", async () => {
  const { BacklogReportSchema } = await import("../src/server/foreman/backlog-plan.ts");
  const { QueueVerdictSchema } = await import("../src/server/foreman/queue-verify.ts");
  const { VerdictSchema } = await import("../src/server/foreman/verdict.ts");
  const { SettingsBackupJsonValueSchema } = await import("../src/shared/settings-backups.ts");
  const { SETTINGS_BACKUP_CATALOGS } = await import("../src/server/settings-backups/catalogs.ts");
  const schemas: [string, Schema][] = [
    ["backlog reply", BacklogReportSchema], ["queue reply", QueueVerdictSchema],
    ["Foreman reply", VerdictSchema], ["backup JSON", SettingsBackupJsonValueSchema],
    ...SETTINGS_BACKUP_CATALOGS.map((entry): [string, Schema] => [`backup ${entry.domain}`, entry.schema]),
  ];
  assert.deepEqual(schemas.flatMap(([name, schema]) => unboundedCollections(schema).map(at => `${name}: ${at}`)), []);
});

/** One `initialize` + `tools/list` against the MCP server, run from source. */
async function listMcpTools(): Promise<{ name: string; inputSchema: unknown }[]> {
  const child = spawn(process.execPath, ["--import", "tsx", join(ROOT, "src/mcp/server.ts")], {
    cwd: ROOT,
    env: { ...process.env, HARNESS_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffered = "";
  const reply = new Promise<{ result?: { tools: { name: string; inputSchema: unknown }[] }; error?: { message: string } }>(
    (resolveReply, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => reject(new Error(`MCP server exited (${code}) before answering tools/list`)));
      child.stdout.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        for (const line of buffered.split("\n")) {
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line) as { id?: number };
            if (message.id === 2) resolveReply(message as never);
          } catch {
            // A partial line; the rest arrives with the next chunk.
          }
        }
      });
    },
  );
  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bounds", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  try {
    const answer = await reply;
    assert.equal(answer.error, undefined, `tools/list failed: ${answer.error?.message}`);
    return answer.result!.tools;
  } finally {
    child.kill();
  }
}

/** The paths at which a rendered JSON Schema accepts an array or map of any size. */
function unboundedJsonCollections(node: unknown, path = "$"): string[] {
  if (typeof node !== "object" || node === null) return [];
  if (Array.isArray(node)) return node.flatMap((entry, index) => unboundedJsonCollections(entry, `${path}[${index}]`));
  const schema = node as Record<string, unknown>;
  const found: string[] = [];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("array") && typeof schema.maxItems !== "number") found.push(`${path} (array)`);
  const extra = schema.additionalProperties;
  if (typeof extra === "object" && extra !== null && typeof schema.maxProperties !== "number") found.push(`${path} (map)`);
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && typeof value === "object" && value !== null) {
      for (const [name, child] of Object.entries(value)) found.push(...unboundedJsonCollections(child, `${path}.${name}`));
    } else if (["items", "additionalProperties", "anyOf", "oneOf", "allOf", "prefixItems"].includes(key)) {
      found.push(...unboundedJsonCollections(value, `${path}/${key}`));
    }
  }
  return found;
}

test("every MCP tool lists, and bounds every collection in its input", async () => {
  const tools = await listMcpTools();
  assert.ok(tools.length > 20, `only ${tools.length} MCP tools were listed`);
  const unbounded = tools.flatMap((tool) => unboundedJsonCollections(tool.inputSchema).map((at) => `${tool.name}: ${at}`));
  assert.deepEqual(unbounded, []);
});
