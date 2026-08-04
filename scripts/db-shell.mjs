import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir } from "../src/shared/harness-runtime.mjs";

export function databasePath() {
  return join(stateDir(), "harness.db");
}

export function sqliteShellArgs(path) {
  return [
    "-readonly",
    "-cmd",
    "PRAGMA query_only = ON;",
    "-cmd",
    ".headers on",
    "-cmd",
    ".mode column",
    "-cmd",
    ".nullvalue NULL",
    path,
  ];
}

export function openDatabaseShell({
  path = databasePath(),
  sqliteBin = process.env.SQLITE3_BIN || "sqlite3",
  spawn = spawnSync,
} = {}) {
  if (!existsSync(path)) {
    console.error(
      `Mission Control database not found at ${path}. Start Mission Control once, or set MISSION_HOME to the state directory you want to inspect.`,
    );
    return 1;
  }

  console.error(`Opening ${path} read-only. Use .tables, .schema TABLE, .help, and .quit.`);
  const result = spawn(sqliteBin, sqliteShellArgs(path), { stdio: "inherit" });
  if (result.error?.code === "ENOENT") {
    console.error(
      `Could not find ${sqliteBin}. Install the SQLite command-line shell or set SQLITE3_BIN to its path.`,
    );
    return 1;
  }
  if (result.error) {
    console.error(`Could not start the SQLite shell: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = openDatabaseShell();
}
