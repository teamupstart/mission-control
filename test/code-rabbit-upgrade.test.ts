import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { upgradeDatabaseToCurrentSchema } from "../src/server/db.ts";
import { ShippingConfigSchema } from "../src/shared/protocol.ts";

function legacyDatabase(value?: string, version = 36): DatabaseSync {
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
  const db = legacyDatabase(optedOut, 37);
  try {
    upgradeDatabaseToCurrentSchema(db);
    assert.equal(storedShipping(db), optedOut);
  } finally {
    db.close();
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
