import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKFLOW_CHECK_SLOTS, WORKFLOW_LIMITS } from "../src/shared/workflow.ts";

// What is at stake: HTTP is the write boundary for an argv the daemon will EXECUTE, and there
// are now two doors into one catalog - the dedicated Command routes and the legacy workflow
// config PUT that today's Settings form still uses. Both have to land in the same place, both
// have to refuse the same things, and the legacy read has to project what the daemon would
// actually run. A second stored list, or a projection that disagreed with resolution, would
// be a gate an operator believes they configured and a command that never runs.

const home = mkdtempSync(join(tmpdir(), "mission-workflow-commands-http-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb, setAppConfig } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { WorkflowCommandManager } = await import("../src/server/workflows/commands.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");
const { setWorkflowPolicy } = await import("../src/server/workflows/config.ts");
const { buildApp } = await import("../src/server/routes.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

function fixture() {
  clearWorkflowTables(db);
  setAppConfig("workflows", {});
  const registry = new Registry();
  const commands = new WorkflowCommandManager(registry, new WorkflowStore(db));
  const app = buildApp(
    registry, null as never, null as never, null as never,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined,
    commands,
  );
  const request = (path: string, init?: RequestInit) =>
    app.request(path, {
      ...init,
      headers: { host: "127.0.0.1:7317", "content-type": "application/json", ...init?.headers },
    });
  return { registry, commands, request };
}

const body = (value: unknown): string => JSON.stringify(value);

test("the list projects every built-in slot, in registry order, before anything is written", async () => {
  const { request } = fixture();
  const listed = await (await request("/api/workflow-commands")).json() as Array<{
    slot: string;
    defaultCommand: string[] | null;
    overrides: unknown[];
    revision: number;
  }>;
  // A slot that vanished until somebody configured it would make "no command here" and "the
  // catalog has not loaded" the same observation for every reader.
  assert.deepEqual(listed.map((view) => view.slot), [...WORKFLOW_CHECK_SLOTS]);
  assert.ok(listed.every((view) => view.defaultCommand === null && view.overrides.length === 0));
  assert.ok(listed.every((view) => view.revision === 1));
});

test("an unknown slot is 404 on read and on write, rather than minting a fifth slot", async () => {
  const { request } = fixture();
  assert.equal((await request("/api/workflow-commands/deploy")).status, 404);
  const written = await request("/api/workflow-commands/deploy", {
    method: "PUT",
    body: body({ expectedRevision: 1, defaultCommand: ["x"], overrides: [] }),
  });
  assert.equal(written.status, 404);
  assert.equal((await written.json() as { code: string }).code, "workflow_command_not_found");
});

test("one update replaces the default and the complete override list atomically", async () => {
  const { request, registry } = fixture();
  const emitted: unknown[] = [];
  registry.subscribe((event) => {
    if (event.type === "workflow_command_upsert") emitted.push(event.command);
  });

  const saved = await request("/api/workflow-commands/test", {
    method: "PUT",
    body: body({
      expectedRevision: 1,
      defaultCommand: ["npm", "test"],
      overrides: [
        { repoRoot: "/repo/packages/web", command: ["pnpm", "-C", ".", "test"] },
        { repoRoot: "/repo", command: ["npm", "run", "test:ci"] },
      ],
    }),
  });
  assert.equal(saved.status, 200);
  const view = await saved.json() as {
    revision: number;
    defaultCommand: string[];
    overrides: Array<{ repoRoot: string; command: string[] }>;
  };
  // The COMMITTED view comes back, not the request: the revision the next write must carry
  // is the one thing a caller cannot compute for itself.
  assert.equal(view.revision, 2);
  assert.deepEqual(view.defaultCommand, ["npm", "test"]);
  assert.deepEqual(view.overrides.map((entry) => entry.repoRoot), ["/repo", "/repo/packages/web"]);
  assert.equal(emitted.length, 1, "one committed mutation is one event");

  // Removal is expressible: a shorter list is the removal, and a null default clears it.
  const cleared = await request("/api/workflow-commands/test", {
    method: "PUT",
    body: body({ expectedRevision: 2, defaultCommand: null, overrides: [] }),
  });
  assert.equal(cleared.status, 200);
  const empty = await cleared.json() as { defaultCommand: null; overrides: unknown[] };
  assert.equal(empty.defaultCommand, null);
  assert.deepEqual(empty.overrides, []);
});

test("a stale revision is refused with the current view, so neither window silently loses", async () => {
  const { request } = fixture();
  await request("/api/workflow-commands/lint", {
    method: "PUT",
    body: body({ expectedRevision: 1, defaultCommand: ["npm", "run", "lint"], overrides: [] }),
  });
  const stale = await request("/api/workflow-commands/lint", {
    method: "PUT",
    body: body({ expectedRevision: 1, defaultCommand: ["eslint", "."], overrides: [] }),
  });
  assert.equal(stale.status, 409);
  const refusal = await stale.json() as {
    code: string;
    current: { defaultCommand: string[]; revision: number };
  };
  assert.equal(refusal.code, "workflow_command_revision_conflict");
  // The refusal carries what is actually stored, which is what lets a surface offer "reload".
  assert.deepEqual(refusal.current.defaultCommand, ["npm", "run", "lint"]);
  assert.equal(refusal.current.revision, 2);
});

test("every invalid write is a visible refusal rather than a silently repaired one", async () => {
  const { request } = fixture();
  const refused = async (payload: unknown): Promise<number> =>
    (await request("/api/workflow-commands/build", { method: "PUT", body: body(payload) })).status;

  // A missing half is not a partial update: it would silently clear what it omitted.
  assert.equal(await refused({ expectedRevision: 1, defaultCommand: ["x"] }), 400);
  assert.equal(await refused({ expectedRevision: 1, overrides: [] }), 400);
  assert.equal(await refused({ defaultCommand: null, overrides: [] }), 400);
  // Empty argv, over-long argument, too many arguments, empty path.
  assert.equal(await refused({ expectedRevision: 1, defaultCommand: [], overrides: [] }), 400);
  assert.equal(
    await refused({ expectedRevision: 1, defaultCommand: ["x".repeat(5_000)], overrides: [] }),
    400,
  );
  assert.equal(
    await refused({
      expectedRevision: 1,
      defaultCommand: Array.from({ length: WORKFLOW_LIMITS.checkCommandArgs + 1 }, () => "x"),
      overrides: [],
    }),
    400,
  );
  assert.equal(
    await refused({
      expectedRevision: 1,
      defaultCommand: null,
      overrides: [{ repoRoot: "", command: ["npm"] }],
    }),
    400,
  );
  // Two commands for one repository: refused, never deduplicated. A caller who sent two is
  // otherwise never told which of them survived.
  assert.equal(
    await refused({
      expectedRevision: 1,
      defaultCommand: null,
      overrides: [
        { repoRoot: "/repo", command: ["a"] },
        { repoRoot: "/repo", command: ["b"] },
      ],
    }),
    400,
  );
  // And nothing was written by any of them.
  const view = await (await request("/api/workflow-commands/build")).json() as {
    revision: number;
    defaultCommand: null;
  };
  assert.equal(view.revision, 1);
  assert.equal(view.defaultCommand, null);
});

test("a catalog at its ceiling in non-ASCII characters is accepted, not refused unread", async () => {
  // The schema counts CHARACTERS - that is what `z.string().max()` measures - and the route's
  // body limit counts BYTES. A budget that conflated the two would refuse this payload with a
  // 413 before validation ever ran, which is the worst possible place to be wrong: the refusal
  // carries no field and no reason, so an operator sees a save that failed and has no way to
  // learn which of their values did it.
  //
  // Deliberately built at the REAL ceiling rather than near it: every path is the full
  // `checkRepoRoot`, every argv the full `checkCommandLength`, and the override list is the full
  // `commandOverrides`. A smaller payload would pass under a byte-vs-character bug too.
  const { request } = fixture();
  const wide = (count: number) => "中".repeat(count);
  // Four arguments rather than one: the per-argument ceiling and the joined ceiling are
  // separate bounds, and only an argv that respects both is the maximum this schema accepts.
  const widestArgv = () => Array.from({ length: 4 }, () => wide(WORKFLOW_LIMITS.checkCommandArg - 1));
  const overrides = Array.from({ length: WORKFLOW_LIMITS.commandOverrides }, (_, index) => ({
    // Unique per entry, because the schema refuses a repeated path - and the whole list has to
    // be legal for the size claim to mean anything.
    repoRoot: `${wide(WORKFLOW_LIMITS.checkRepoRoot - 8)}/${String(index).padStart(6, "0")}`,
    command: widestArgv(),
  }));
  const payload = {
    expectedRevision: 1,
    defaultCommand: widestArgv(),
    overrides,
  };
  // The claim, stated as an arithmetic fact before the assertion rests on it: this body is
  // multiple bytes per character, so a character-shaped ceiling is nowhere near it.
  const bytes = Buffer.byteLength(body(payload));
  assert.ok(
    bytes > (WORKFLOW_LIMITS.commandOverrides + 1)
      * (WORKFLOW_LIMITS.checkRepoRoot + WORKFLOW_LIMITS.checkCommandLength + 512),
    `the fixture must defeat a character-counted budget outright; it is ${bytes} bytes`,
  );

  const saved = await request("/api/workflow-commands/test", {
    method: "PUT",
    body: body(payload),
  });
  assert.equal(saved.status, 200, "a schema-valid catalog must not be refused before validation");
  const view = await saved.json() as { overrides: unknown[] };
  assert.equal(view.overrides.length, WORKFLOW_LIMITS.commandOverrides);

  // And it reads back whole. The store's own JSON byte ceiling counts bytes against a
  // character-bounded argv too, so the same confusion there would report the operator's
  // just-accepted command as an unreadable row and silently skip the gate.
  const reread = await (await request("/api/workflow-commands/test")).json() as {
    defaultCommand: string[];
    overrides: Array<{ command: string[] }>;
  };
  assert.deepEqual(reread.defaultCommand, payload.defaultCommand);
  assert.deepEqual(reread.overrides[0]?.command, overrides[0]!.command);
});

test("the legacy config route reads overrides out of the catalog and writes back into it", async () => {
  const { request, commands, registry } = fixture();
  setWorkflowPolicy({ liveEnabled: true, repoAllowlist: [] });

  // A global default first, through the catalog's own route.
  await request("/api/workflow-commands/test", {
    method: "PUT",
    body: body({ expectedRevision: 1, defaultCommand: ["npm", "test"], overrides: [] }),
  });

  const emitted: string[] = [];
  registry.subscribe((event) => {
    if (event.type === "workflow_command_upsert") emitted.push(event.command.slot);
  });

  const saved = await request("/api/workflows/config", {
    method: "PUT",
    body: body({
      liveEnabled: true,
      repoAllowlist: ["/repo"],
      // Null rather than the shipped default: this fixture builds no workflow manager, and
      // the route refuses a dispatch default it cannot verify is published.
      defaultWorkflowId: null,
      checksEnabled: true,
      checkCommands: [
        { repoRoot: "/repo", slot: "typecheck", command: ["npm", "run", "typecheck"] },
        { repoRoot: "/repo", slot: "test", command: ["npm", "run", "test:ci"] },
      ],
    }),
  });
  assert.equal(saved.status, 200);
  const config = await saved.json() as {
    checksEnabled: boolean;
    checkCommands: Array<{ repoRoot: string; slot: string; command: string[] }>;
  };
  assert.equal(config.checksEnabled, true);
  // Projected in registry slot order, so the old field is deterministic rather than
  // dependent on how the request happened to be ordered.
  assert.deepEqual(config.checkCommands, [
    { repoRoot: "/repo", slot: "test", command: ["npm", "run", "test:ci"] },
    { repoRoot: "/repo", slot: "typecheck", command: ["npm", "run", "typecheck"] },
  ]);

  // The write landed in the CATALOG, and the global default it knows nothing about survived.
  assert.deepEqual(commands.get("test")?.defaultCommand, ["npm", "test"]);
  assert.deepEqual(commands.get("test")?.overrides, [
    { repoRoot: "/repo", command: ["npm", "run", "test:ci"] },
  ]);
  // Two slots moved, so two events - and only two: the untouched slots do not churn.
  assert.deepEqual(emitted.sort(), ["test", "typecheck"]);

  // A save that changes only a switch touches no slot and emits nothing more.
  emitted.length = 0;
  await request("/api/workflows/config", {
    method: "PUT",
    body: body({
      liveEnabled: false,
      repoAllowlist: ["/repo"],
      defaultWorkflowId: null,
      checksEnabled: true,
      checkCommands: config.checkCommands,
    }),
  });
  assert.deepEqual(emitted, []);

  // A shorter list is a removal, exactly as the old whole-object PUT always meant.
  await request("/api/workflows/config", {
    method: "PUT",
    body: body({
      liveEnabled: false,
      repoAllowlist: ["/repo"],
      defaultWorkflowId: null,
      checksEnabled: true,
    }),
  });
  assert.deepEqual(commands.get("typecheck")?.overrides, []);
  assert.deepEqual(commands.get("test")?.overrides, []);
  // ...and it still did not touch the global default, which the old form cannot see.
  assert.deepEqual(commands.get("test")?.defaultCommand, ["npm", "test"]);

  const read = await (await request("/api/workflows/config")).json() as {
    checkCommands: unknown[];
  };
  assert.deepEqual(read.checkCommands, [], "a default has no legacy row it could honestly fill");
});

test("a refused legacy write leaves neither policy nor catalog changed", async () => {
  const { request, commands } = fixture();
  setWorkflowPolicy({ liveEnabled: true, repoAllowlist: [] });
  const refused = await request("/api/workflows/config", {
    method: "PUT",
    body: body({
      liveEnabled: false,
      repoAllowlist: ["/repo"],
      defaultWorkflowId: null,
      checkCommands: [
        { repoRoot: "/repo", slot: "test", command: ["a"] },
        { repoRoot: "/repo", slot: "test", command: ["b"] },
      ],
    }),
  });
  assert.equal(refused.status, 400);
  assert.deepEqual(commands.get("test")?.overrides, []);
  const config = await (await request("/api/workflows/config")).json() as { liveEnabled: boolean };
  assert.equal(config.liveEnabled, true, "policy must not move when the command half is refused");
});

test("the catalog routes answer 503 rather than constructing a second owner", async () => {
  const app = buildApp(new Registry(), null as never, null as never, null as never);
  const request = (path: string) => app.request(path, { headers: { host: "127.0.0.1:7317" } });
  assert.equal((await request("/api/workflow-commands")).status, 503);
  assert.equal((await request("/api/workflow-commands/test")).status, 503);
  // And the legacy read still answers, with an empty projection rather than a stale list.
  const config = await (await request("/api/workflows/config")).json() as { checkCommands: [] };
  assert.deepEqual(config.checkCommands, []);
});
