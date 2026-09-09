import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import {
  buildApp,
  resolveRouteDeps,
  REQUIRED_ROUTE_DEPS,
  REQUIRED_ROUTE_DEPS_ARE_COMPLETE,
  ROUTE_DEP_NAMES,
  ROUTE_DEP_NAMES_ARE_COMPLETE,
  type RouteDeps,
} from "../src/server/routes.ts";
import type { KeepAwakeManager } from "../src/server/keep-awake.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { Registry } from "../src/server/registry.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskManager } from "../src/server/tasks.ts";
import type { WorktreeOperationsService } from "../src/server/worktrees/operations.ts";

/**
 * The composition contract for `buildApp`.
 *
 * `buildApp` is the widest construction seam in the daemon: 27 dependencies feeding a route
 * table of 300-odd handlers whose domains are otherwise unrelated. It used to take those 27
 * by POSITION, which assigns by index with no identity check - so an argument skipped or
 * inserted in the middle bound a perfectly valid service to a DIFFERENT route domain and
 * constructed successfully, surfacing much later as an unrelated domain's 503.
 *
 * These tests hold the seam closed from both ends: the named object is the only call form
 * that exists, and every representation of the dependency contract is pinned to the
 * `RouteDeps` interface rather than restated beside it.
 */

/** The loopback Host every data endpoint requires. See `hostIsLoopback` in routes.ts. */
const LOOPBACK = { host: "127.0.0.1:7317" };

/** None of the routes exercised here read these, so bare stubs keep the test hermetic. */
const registry = {} as unknown as Registry;
const reviews = {} as unknown as ReviewManager;
const tasks = {} as unknown as TaskManager;
const queues = {} as unknown as QueueManager;

const KEEP_AWAKE_STATUS = {
  supported: true,
  unavailableReason: null,
  state: "off",
  provider: "caffeinate",
  since: null,
  error: null,
} as const;

/** A keep-awake owner recognisable by its answer, so "which field got it" is observable. */
const keepAwakeStub = { status: () => KEEP_AWAKE_STATUS } as unknown as KeepAwakeManager;

const INVENTORY = { pools: [], orphans: [], legacy: [] };
const worktreeOperationsStub = {
  inventory: async () => INVENTORY,
} as unknown as WorktreeOperationsService;

/** Call through an untyped view, to reach shapes the signature already rejects. */
const unchecked = buildApp as unknown as (...args: unknown[]) => unknown;
const resolveUnchecked = resolveRouteDeps as unknown as (value: unknown) => RouteDeps;

test("ROUTE_DEP_NAMES names every RouteDeps key exactly once", () => {
  // The compile-time half of this pair lives in `RouteDepNamesAreComplete`: a field added to
  // the interface and never listed fails `npm run typecheck` with the name printed.
  assert.equal(ROUTE_DEP_NAMES_ARE_COMPLETE, true);
  assert.equal(new Set(ROUTE_DEP_NAMES).size, ROUTE_DEP_NAMES.length);
});

test("REQUIRED_ROUTE_DEPS matches the fields RouteDeps declares non-optional", () => {
  // Derived, not restated: `RequiredRouteDep` is read off the interface, so a field made
  // required without being listed here fails to typecheck, and a listed field made optional
  // fails the `satisfies` clause. The behavioural half is the refusal test below.
  assert.equal(REQUIRED_ROUTE_DEPS_ARE_COMPLETE, true);
  assert.deepEqual([...REQUIRED_ROUTE_DEPS], ["registry", "reviews", "tasks", "queues"]);
  for (const name of REQUIRED_ROUTE_DEPS) assert.ok(ROUTE_DEP_NAMES.includes(name));
});

test("there is no positional call form left to miswire", () => {
  // The property the issue asks for. `buildApp` takes exactly one parameter, and the old
  // 27-argument shape no longer constructs anything: it is refused at the seam rather than
  // binding argument two onto some other domain and succeeding.
  assert.equal(buildApp.length, 1);
  assert.throws(
    () => unchecked(registry, reviews, tasks, queues),
    /buildApp: missing required route dependencies "registry", "reviews", "tasks", "queues"/,
  );
});

test("an off-by-one positional list is rejected at construction, not at request time", () => {
  // The exact scenario the issue named, and the one the previous design could only survive
  // rather than prevent. `keepAwake` was positional slot 15; one slot late is `archives`.
  // Under the positional API that list CONSTRUCTED an app successfully, and the mistake
  // surfaced much later and somewhere else, as GET /api/keep-awake answering 503.
  const offByOne: unknown[] = [registry, reviews, tasks, queues];
  offByOne[16] = keepAwakeStub;
  assert.throws(() => unchecked(...offByOne), /^TypeError: buildApp: /);

  // The correctly-placed variant is refused identically. That is the point: position now
  // carries no meaning at all, so there is no off-by-one to be off by.
  const onTime: unknown[] = [registry, reviews, tasks, queues];
  onTime[15] = keepAwakeStub;
  assert.throws(() => unchecked(...onTime), /^TypeError: buildApp: /);

  // No app escapes either call, so no route can answer 503 for a wiring mistake made here.
  for (const list of [offByOne, onTime]) {
    let built: unknown = "not built";
    try {
      built = unchecked(...list);
    } catch {
      /* expected */
    }
    assert.equal(built, "not built");
  }
});

test("a named dependency object resolves to exactly the fields it supplied", () => {
  const resolved = resolveRouteDeps({ registry, reviews, tasks, queues, keepAwake: keepAwakeStub });
  assert.equal(resolved.keepAwake, keepAwakeStub);
  assert.equal(resolved.archives, undefined);
  assert.equal(resolved.worktreeOperations, undefined);
});

test("a misspelled dependency name is refused, naming the key and the nearest real one", () => {
  assert.throws(
    () => resolveUnchecked({ registry, reviews, tasks, queues, keepAwke: keepAwakeStub }),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /unknown route dependency "keepAwke"/);
      assert.match(error.message, /did you mean "keepAwake"\?/);
      return true;
    },
  );
});

test("a wholly unrelated key is refused without being dressed up as a typo", () => {
  assert.throws(
    () => resolveUnchecked({ registry, reviews, tasks, queues, telemetryExporter: {} }),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /unknown route dependency "telemetryExporter"/);
      assert.doesNotMatch(error.message, /did you mean/);
      // The refusal still teaches the caller the vocabulary it should have used.
      assert.match(error.message, /Known dependencies: registry, reviews, /);
      return true;
    },
  );
});

test("a misspelling hidden on a prototype is refused, not read past", () => {
  // `Object.keys` cannot see an inherited field, but `fields[key]` can read one. An object
  // whose prototype carries `keepAwke` therefore used to pass validation in silence and
  // leave GET /api/keep-awake answering 503 at request time, which is precisely the deferred
  // failure this seam exists to abolish. The shape is refused outright.
  const viaPrototype = Object.create({ keepAwke: keepAwakeStub }) as Record<string, unknown>;
  Object.assign(viaPrototype, { registry, reviews, tasks, queues });
  assert.throws(
    () => resolveUnchecked(viaPrototype),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /expected a plain RouteDeps object/);
      assert.match(error.message, /non-standard prototype chain/);
      return true;
    },
  );
});

test("a misspelling polluted onto Object.prototype is refused, not ignored", () => {
  // The chain is bounded to Object.prototype by the plain-object rule, but not emptied.
  // Every built-in member of Object.prototype is non-enumerable, so a clean literal has no
  // inherited enumerable names, while assignment pollution creates one. Reflect.ownKeys
  // cannot see it and Object.hasOwn will not copy it, so before this it was neither
  // reported nor honoured: keepAwake stayed absent and /api/keep-awake answered 503.
  const polluted = Object.prototype as unknown as Record<string, unknown>;
  polluted.keepAwke = keepAwakeStub;
  try {
    assert.throws(
      () => resolveUnchecked({ registry, reviews, tasks, queues }),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /route dependency name "keepAwke"/);
        assert.match(error.message, /did you mean "keepAwake"\?/);
        assert.match(error.message, /through its prototype rather than as own fields/);
        return true;
      },
    );
  } finally {
    delete polluted.keepAwke;
  }
});

test("a CORRECTLY named dependency on the prototype is refused rather than adopted", () => {
  // Silently declining to honour it would be its own quiet miswiring: the environment says
  // keepAwake is set, and the app would answer 503 anyway. A polluted prototype cannot be
  // told apart from a supplied field, so it is refused either way.
  const polluted = Object.prototype as unknown as Record<string, unknown>;
  polluted.keepAwake = keepAwakeStub;
  try {
    assert.throws(
      () => resolveUnchecked({ registry, reviews, tasks, queues }),
      /route dependency name "keepAwake".*through its prototype/s,
    );
  } finally {
    delete polluted.keepAwake;
  }
});

test("an ordinary literal has no inherited enumerable names to refuse", () => {
  // The guard must not fire on the built-ins every object inherits: toString, valueOf and
  // the rest are all non-enumerable, so a normal call is unaffected.
  const resolved = resolveRouteDeps({ registry, reviews, tasks, queues, keepAwake: keepAwakeStub });
  assert.equal(resolved.keepAwake, keepAwakeStub);
});

test("a class instance is refused as a dependency object", () => {
  class Deps {
    registry = registry;
    reviews = reviews;
    tasks = tasks;
    queues = queues;
  }
  assert.throws(
    () => resolveUnchecked(new Deps()),
    /expected a plain RouteDeps object, received an instance of Deps/,
  );
});

test("a misspelling hidden on a non-enumerable own property is refused by name", () => {
  // The other half of the same hole: an own property is invisible to `Object.keys` when it is
  // non-enumerable, so the name must be collected with `Reflect.ownKeys` instead.
  const viaNonEnumerable: Record<string, unknown> = { registry, reviews, tasks, queues };
  Object.defineProperty(viaNonEnumerable, "keepAwke", {
    value: keepAwakeStub,
    enumerable: false,
  });
  assert.throws(
    () => resolveUnchecked(viaNonEnumerable),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /unknown route dependency "keepAwke"/);
      assert.match(error.message, /did you mean "keepAwake"\?/);
      return true;
    },
  );
});

test("a symbol key is reported rather than ignored", () => {
  const withSymbol: Record<string | symbol, unknown> = { registry, reviews, tasks, queues };
  withSymbol[Symbol.for("keepAwake")] = keepAwakeStub;
  assert.throws(() => resolveUnchecked(withSymbol), /unknown route dependency "Symbol\(keepAwake\)"/);
});

test("a null-prototype object is accepted, having no chain to hide a name on", () => {
  const bare = Object.create(null) as Record<string, unknown>;
  Object.assign(bare, { registry, reviews, tasks, queues, keepAwake: keepAwakeStub });
  const resolved = resolveUnchecked(bare);
  assert.equal(resolved.keepAwake, keepAwakeStub);
});

test("an inherited dependency value is not adopted as if it were supplied", () => {
  // The mirror of the typo case: a CORRECTLY named field on a prototype must not be read
  // either, or presence would depend on the chain rather than on what the caller wrote.
  const bare = Object.create(null) as Record<string, unknown>;
  Object.assign(bare, { registry, reviews, tasks, queues });
  const resolved = resolveUnchecked(bare);
  assert.equal(resolved.keepAwake, undefined);
});

test("an accessor field is read exactly once", () => {
  // Read twice, a getter could answer the presence check and the assignment differently.
  let reads = 0;
  const deps: Record<string, unknown> = { registry, reviews, tasks, queues };
  Object.defineProperty(deps, "keepAwake", {
    enumerable: true,
    get: () => {
      reads += 1;
      return keepAwakeStub;
    },
  });
  const resolved = resolveUnchecked(deps);
  assert.equal(reads, 1);
  assert.equal(resolved.keepAwake, keepAwakeStub);
});

test("every required dependency is refused by name when it is absent", () => {
  for (const missing of REQUIRED_ROUTE_DEPS) {
    const deps: Record<string, unknown> = { registry, reviews, tasks, queues };
    delete deps[missing];
    assert.throws(
      () => resolveUnchecked(deps),
      new RegExp(`missing required route dependency "${missing}"`),
      `should refuse a missing ${missing}`,
    );
  }
  assert.throws(
    () => resolveUnchecked({}),
    /missing required route dependencies "registry", "reviews", "tasks", "queues"/,
  );
});

test("a non-object is refused as a call form, not read as a dependency", () => {
  assert.throws(() => resolveUnchecked(null), /expected a named RouteDeps object, received null/);
  assert.throws(() => resolveUnchecked(7), /expected a named RouteDeps object, received number/);
});

test("the whole route surface is registered from a minimal named object", () => {
  const app = buildApp({ registry, reviews, tasks, queues });
  const table = app.routes.map((route) => `${route.method} ${route.path}`);
  assert.ok(table.length > 300, `expected the whole surface, saw ${table.length}`);
});

test("a named dependency reaches its own route domain and no other", async () => {
  const app = buildApp({ registry, reviews, tasks, queues, keepAwake: keepAwakeStub });

  const served = await app.request("/api/keep-awake", { headers: LOOPBACK });
  assert.equal(served.status, 200);
  assert.deepEqual(await served.json(), KEEP_AWAKE_STATUS);

  // Supplying keep-awake did not confer a worktree operations service on any other domain.
  // This is the property positional composition could not state: one domain's dependency
  // never changes the meaning of another's.
  const neighbour = await app.request("/api/worktrees", { headers: LOOPBACK });
  assert.equal(neighbour.status, 503);
});

test("field order in the literal is irrelevant to which domain gets what", async () => {
  // The positional hazard, structurally absent: the same two services written in opposite
  // orders compose the same app, because identity comes from the name and nothing else.
  for (const deps of [
    { registry, reviews, tasks, queues, keepAwake: keepAwakeStub, worktreeOperations: worktreeOperationsStub },
    { worktreeOperations: worktreeOperationsStub, keepAwake: keepAwakeStub, queues, tasks, reviews, registry },
  ] satisfies RouteDeps[]) {
    const app = buildApp(deps);
    assert.equal((await app.request("/api/keep-awake", { headers: LOOPBACK })).status, 200);
    assert.equal((await app.request("/api/worktrees", { headers: LOOPBACK })).status, 200);
  }
});

test("a service supplied under the wrong name leaves its own domain unavailable", async () => {
  // Miswiring by name is still possible to write, but it cannot be silent in the direction
  // that matters: the domain that lost its owner reports itself unavailable.
  const app = buildApp({
    registry,
    reviews,
    tasks,
    queues,
    worktreeOperations: keepAwakeStub as unknown as WorktreeOperationsService,
  });
  const res = await app.request("/api/keep-awake", { headers: LOOPBACK });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "keep-awake manager unavailable" });
});

/** Every `.ts` file under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

/**
 * Call sites that hand `buildApp` more than one argument.
 *
 * A separator at bracket depth one is the whole signal: `buildApp(deps)` and
 * `buildApp({ registry, reviews })` are both single-argument and safe, because identity comes
 * from field names either way, while `buildApp(a, b)` is the positional shape by definition.
 * Commas nested inside the object literal never reach depth one.
 */
function positionalCallsIn(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/\bbuildApp\(/g)) {
    let depth = 1;
    let separated = false;
    let i = match.index + match[0].length;
    for (; i < source.length && depth > 0; i++) {
      const ch = source[i];
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") depth--;
      else if (ch === "," && depth === 1) separated = true;
    }
    if (separated) found.push(source.slice(match.index, Math.min(i, match.index + 60)));
  }
  return found;
}

test("no caller anywhere composes routes by position", () => {
  // The guard against reintroduction. A positional call cannot typecheck today, but a future
  // `as unknown as` cast or a re-added overload could bring the hazard back one file at a
  // time; this fails the moment any call site passes a second argument.
  const root = fileURLToPath(new URL("..", import.meta.url));
  // This file is excluded because it is the guard: it necessarily contains the pattern it
  // looks for, in `unchecked(registry, reviews, tasks, queues)` above.
  const exempt = new Set([join(root, "src/server/routes.ts"), fileURLToPath(import.meta.url)]);
  const offenders: string[] = [];
  for (const file of [...sourceFiles(join(root, "src")), ...sourceFiles(join(root, "test"))]) {
    if (exempt.has(file)) continue;
    for (const call of positionalCallsIn(readFileSync(file, "utf8"))) {
      offenders.push(`${file.slice(root.length)}: ${call}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the daemon's composition root wires routes by name", () => {
  // The one caller that matters in production. Positional there is how a hole such as the
  // three bare `undefined` arguments this replaced becomes load-bearing punctuation.
  const source = readFileSync(
    fileURLToPath(new URL("../src/server/index.ts", import.meta.url)),
    "utf8",
  );
  assert.match(source, /const app = buildApp\(\{/);
});
