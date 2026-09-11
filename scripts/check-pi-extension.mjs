#!/usr/bin/env node
// Optional live compatibility check. Uses the installed Pi, isolated homes and no provider.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
const dir = await mkdtemp(join(tmpdir(), "mission-pi-live-"));
try {
  const extensions = join(dir, "agent", "extensions");
  await mkdir(extensions, { recursive: true });
  await symlink(resolve("dist/pi-extension/index.js"), join(extensions, "mission-control.js"));
  const record = join(dir, "registered.json");
  await writeFile(join(extensions, "verify.js"), `import {writeFileSync} from 'node:fs';
export default function(pi) { pi.on('session_start', () => { writeFileSync(${JSON.stringify(record)}, JSON.stringify(pi.getAllTools())); }); }`);
  const env = { ...process.env, HOME: dir, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_OFFLINE: "1", MISSION_HOME: join(dir, "mission"), MISSION_PORT: "1" };
  for (const key of ["MISSION_MCP_SERVER", "FLEET_MCP_SERVER", "HARNESS_MCP_SERVER", "MISSION_API_TOKEN", "MISSION_API_TOKEN_FILE", "MISSION_SESSION_ID", "CLAUDE_SESSION_ID"]) delete env[key];
  const run = promisify(execFile);
  const version = await run(process.argv[2] ?? "pi", ["--version"], { env });
  const child = execFile(process.argv[2] ?? "pi", ["--mode", "rpc", "--no-session", "--offline"], { cwd: dir, env, timeout: 25_000 }, () => {});
  child.stdin.end();
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => stdout += chunk);
  child.stderr.on("data", (chunk) => stderr += chunk);
  const code = await new Promise((done) => child.once("exit", done));
  assert.equal(code, 0, stderr);
  const tools = JSON.parse(await readFile(record, "utf8"));
  for (const name of ["request_input", "submit_workflow_evidence", "report_status"]) assert.ok(tools.some((tool) => tool.name === name), name);
  assert.equal(stdout, "", "extension writes no protocol noise to stdout");
  assert.equal(stderr, "", "a down daemon must not print an extension error");
  console.log(`Pi ${version.stdout.trim()}: auto-discovered .js symlink registered ${tools.length - 8} Mission tools using the baked MCP path, with no daemon, no extension stdout/stderr and no model calls.`);
} finally { await rm(dir, { recursive: true, force: true }); }
