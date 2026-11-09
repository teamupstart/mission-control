import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { upgradeDatabaseToCurrentSchema } from "../src/server/db.ts";

function legacyDatabase(value?: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version = 22;");
  if (value !== undefined) db.prepare("INSERT INTO app_config VALUES ('skills', ?)").run(value);
  return db;
}

function storedSkills(db: DatabaseSync): string | undefined {
  return (db.prepare("SELECT value FROM app_config WHERE key = 'skills'").get() as { value: string } | undefined)?.value;
}

test("the Mockups upgrade enables absent and disabled rows once while preserving other settings", () => {
  for (const enabled of [true, false]) {
    for (const mockups of [undefined, false, true]) {
      const before = {
        enabled,
        skills: { alpha: true, beta: false, ...(mockups === undefined ? {} : { mockups }) },
        generation: 7,
        generationAt: 123,
        commitPlanHtml: true,
        planStorage: "local",
        alwaysDraftPr: true,
      };
      const db = legacyDatabase(JSON.stringify(before));
      try {
        upgradeDatabaseToCurrentSchema(db);
        assert.deepEqual(JSON.parse(storedSkills(db)!), {
          ...before, skills: { ...before.skills, mockups: true },
        }, "only the Mockups choice changes, including with the master switch off");

        const optedOut = JSON.stringify({ ...before, skills: { ...before.skills, mockups: false } });
        db.prepare("UPDATE app_config SET value = ? WHERE key = 'skills'").run(optedOut);
        upgradeDatabaseToCurrentSchema(db);
        assert.equal(storedSkills(db), optedOut, "a restart preserves the later opt-out");
      } finally {
        db.close();
      }
    }
  }
});

test("the Mockups upgrade preserves default-on policy and does not enable other disabled rows", () => {
  const before = { enabled: true, defaultSkillEnabled: true, skills: { mockups: false, retro: false } };
  const db = legacyDatabase(JSON.stringify(before));
  try {
    upgradeDatabaseToCurrentSchema(db);
    assert.deepEqual(JSON.parse(storedSkills(db)!), { ...before, skills: { mockups: true, retro: false } });
  } finally {
    db.close();
  }
});

test("the Mockups upgrade leaves missing and corrupt configurations untouched", () => {
  for (const value of [undefined, "{", "null", JSON.stringify({ enabled: "invalid", skills: { mockups: false } })]) {
    const db = legacyDatabase(value);
    try {
      upgradeDatabaseToCurrentSchema(db);
      assert.equal(storedSkills(db), value, "missing settings use fresh defaults; corrupt settings still fail closed");
    } finally {
      db.close();
    }
  }
});
