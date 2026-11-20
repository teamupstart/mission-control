import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CURRENT_DATABASE_SCHEMA_VERSION, upgradeDatabaseToCurrentSchema } from "../src/server/db.ts";
import { ShippingConfigSchema } from "../src/shared/protocol.ts";

function legacyDatabase(value?: string, version = 37): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version = ${version};`);
  if (value !== undefined) db.prepare("INSERT INTO app_config VALUES ('shipping', ?)").run(value);
  return db;
}

function storedShipping(db: DatabaseSync): string | undefined {
  return (db.prepare("SELECT value FROM app_config WHERE key = 'shipping'").get() as { value: string } | undefined)?.value;
}

test("a fresh install and a blob that never stored the choice read CodeRabbit follow-up as on", () => {
  assert.equal(ShippingConfigSchema.parse({}).codeRabbitAutoResolve, true);
  assert.equal(ShippingConfigSchema.parse({ autoMerge: true, soakMinutes: 5 }).codeRabbitAutoResolve, true);
});

test("the CodeRabbit upgrade enables a stored off value once and keeps every other Shipping setting", () => {
  for (const codeRabbitAutoResolve of [undefined, false, true]) {
    const before = {
      autoMerge: true,
      soakMinutes: 0,
      method: "rebase",
      repoAllowlist: ["/repo"],
      closeSessionAfterMerge: true,
      stacking: "merge",
      maxStackDepth: 7,
      ...(codeRabbitAutoResolve === undefined ? {} : { codeRabbitAutoResolve }),
    };
    const db = legacyDatabase(JSON.stringify(before));
    try {
      const stored = storedShipping(db);
      upgradeDatabaseToCurrentSchema(db);
      if (codeRabbitAutoResolve === false) {
        assert.deepEqual(JSON.parse(storedShipping(db)!), { ...before, codeRabbitAutoResolve: true },
          "only the CodeRabbit choice changes");
      } else {
        assert.equal(storedShipping(db), stored, "a blob with nothing to migrate is not rewritten");
      }
      assert.equal(ShippingConfigSchema.parse(JSON.parse(storedShipping(db)!)).codeRabbitAutoResolve, true);

      const optedOut = JSON.stringify({ ...before, codeRabbitAutoResolve: false });
      db.prepare("UPDATE app_config SET value = ? WHERE key = 'shipping'").run(optedOut);
      upgradeDatabaseToCurrentSchema(db);
      assert.equal(storedShipping(db), optedOut, "a restart after the upgrade preserves the later opt-out");
    } finally {
      db.close();
    }
  }
});

test("the CodeRabbit upgrade never reruns on a database already past it", () => {
  const optedOut = JSON.stringify({ autoMerge: false, codeRabbitAutoResolve: false });
  const db = legacyDatabase(optedOut, 38);
  try {
    upgradeDatabaseToCurrentSchema(db);
    assert.equal(storedShipping(db), optedOut);
  } finally {
    db.close();
  }
});

test("a stored off value with an unknown property nested past SQLite's JSON depth limit still upgrades", () => {
  // The Shipping schema ignores unknown properties, so this blob is valid settings that SQLite's
  // own JSON functions refuse to read. The upgrade must not depend on them.
  let deep: unknown = "leaf";
  for (let level = 0; level < 1_200; level++) deep = { next: deep };
  const before = { autoMerge: true, soakMinutes: 5, codeRabbitAutoResolve: false, legacyExtra: deep };
  const db = legacyDatabase(JSON.stringify(before));
  try {
    assert.throws(() => db.prepare("SELECT json_type(value, '$.codeRabbitAutoResolve') FROM app_config").get(),
      "the fixture really is past SQLite's limit");
    upgradeDatabaseToCurrentSchema(db);
    // Compared as text: a structural deep-equal would itself recurse 1,200 levels.
    assert.equal(storedShipping(db), JSON.stringify({ ...before, codeRabbitAutoResolve: true }),
      "the flag turns on and every other property, the unknown one included, is kept");
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, CURRENT_DATABASE_SCHEMA_VERSION);
  } finally {
    db.close();
  }
});

test("a stored off value nested past JSON.stringify's stack limit still upgrades, byte for byte", (t) => {
  // Built as text, because `JSON.parse` and the schema accept nesting that a recursive
  // `JSON.stringify` cannot serialize. Where that limit sits depends on the runtime (about ten
  // thousand levels on Node 24), so the fixture finds it rather than assuming one. A runtime
  // whose serializer never overflows still checks the in-place edit at the deepest fixture.
  const nested = (depth: number) => "{\"next\":".repeat(depth) + "\"leaf\"" + "}".repeat(depth);
  let deep = "";
  const value = (flag: string) => `{"autoMerge":true,"codeRabbitAutoResolve":${flag},"legacyExtra":${deep}}`;
  let overflows = false;
  for (let depth = 10_000; depth <= 320_000 && !overflows; depth *= 2) {
    deep = nested(depth);
    try {
      JSON.stringify(JSON.parse(value("false")));
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      overflows = true;
    }
  }
  if (!overflows) t.diagnostic("this runtime's JSON.stringify did not overflow at 320,000 levels");
  const db = legacyDatabase(value("false"));
  try {
    upgradeDatabaseToCurrentSchema(db);
    assert.equal(storedShipping(db), value("true"), "only the top-level flag's bytes change");
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, CURRENT_DATABASE_SCHEMA_VERSION);
  } finally {
    db.close();
  }
});

test("the in-place rewrite changes only the top-level member JSON.parse keeps", () => {
  const cases: Array<[string, string]> = [
    // A nested member of the same name, and the key inside a string, are left alone.
    [`{"nested":{"codeRabbitAutoResolve":false},"note":"\\"codeRabbitAutoResolve\\":false","codeRabbitAutoResolve" : false }`,
      `{"nested":{"codeRabbitAutoResolve":false},"note":"\\"codeRabbitAutoResolve\\":false","codeRabbitAutoResolve" : true }`],
    // With a duplicate key, the last one is what the stored setting reads as.
    [`{"codeRabbitAutoResolve":true,"codeRabbitAutoResolve":false}`, `{"codeRabbitAutoResolve":true,"codeRabbitAutoResolve":true}`],
  ];
  for (const [before, after] of cases) {
    assert.equal(JSON.parse(before).codeRabbitAutoResolve, false, before);
    const db = legacyDatabase(before);
    try {
      upgradeDatabaseToCurrentSchema(db);
      assert.equal(storedShipping(db), after);
    } finally {
      db.close();
    }
  }
});

test("the CodeRabbit upgrade leaves missing and corrupt Shipping settings untouched", () => {
  for (const value of [undefined, "{", "null", JSON.stringify({ soakMinutes: "invalid", codeRabbitAutoResolve: false })]) {
    const db = legacyDatabase(value);
    try {
      upgradeDatabaseToCurrentSchema(db);
      assert.equal(storedShipping(db), value, "missing settings use fresh defaults; corrupt settings still fail closed");
    } finally {
      db.close();
    }
  }
});
