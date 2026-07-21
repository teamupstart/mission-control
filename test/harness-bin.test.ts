import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: which process a dispatch actually spawns.
//
// Binary resolution used to live in three places that each answered for a different
// caller - `AGENT_BINS` in `config.ts` for dispatched sessions, a `CLAUDE_BIN` chain
// inside `claude-cli.ts` for headless runs, and a bare literal in the Electron installer.
// An operator pointing `MISSION_CLAUDE_BIN` at a wrapper got it in one path and not the
// others, and nothing said so. The spec is the harness's now and the resolver is one
// function, so these tests are about that CHAIN holding for every declared harness -
// legacy names included, since those are read by environments configured once and never
// revisited.
//
// Table-driven off the registry: a new harness inherits all of it.

const home = mkdtempSync(join(tmpdir(), "mission-harness-bin-"));
// Set before importing anything that resolves the state dir.
process.env.HARNESS_HOME = join(home, "state");

const { HARNESSES, allHarnesses, harnessFor, resolveAgentBin } = await import(
  "../src/server/harness/index.ts"
);
const { AGENT_TYPES } = await import("../src/shared/types.ts");

after(() => rmSync(home, { recursive: true, force: true }));

/** Every env name any harness reads, so one test can't leak an override into the next. */
function envNames(): string[] {
  return allHarnesses().flatMap((h) => [
    `MISSION_${h.bin.env}`,
    `FLEET_${h.bin.env}`,
    `HARNESS_${h.bin.env}`,
    ...h.bin.legacyEnv,
  ]);
}

beforeEach(() => {
  for (const name of envNames()) delete process.env[name];
});

test("the registry key and the harness's own id agree", () => {
  // Nothing in the type system ties them, and every lookup goes by key while every
  // message and comparison goes by `id`.
  for (const id of AGENT_TYPES) {
    assert.equal(HARNESSES[id].id, id, `HARNESSES.${id}`);
    assert.equal(harnessFor(id), HARNESSES[id]);
  }
  assert.deepEqual(allHarnesses().map((h) => h.id), [...AGENT_TYPES]);
});

test("with nothing set, a harness launches its own command", () => {
  for (const h of allHarnesses()) {
    assert.ok(h.bin.command, `${h.id} must name a command to launch`);
    assert.equal(resolveAgentBin(h.id), h.bin.command);
  }
});

test("every prefix of the rename chain overrides the binary", () => {
  // Oldest-last and every one kept, for the reason `envVar` documents: these are read by
  // processes installed into an environment once, so dropping a prefix stops honouring a
  // setting that is still there rather than failing.
  for (const h of allHarnesses()) {
    for (const prefix of ["MISSION", "FLEET", "HARNESS"]) {
      const name = `${prefix}_${h.bin.env}`;
      process.env[name] = `/fake/${prefix.toLowerCase()}-${h.id}`;
      assert.equal(resolveAgentBin(h.id), `/fake/${prefix.toLowerCase()}-${h.id}`, name);
      delete process.env[name];
    }
  }
});

test("MISSION_ wins over the older prefixes", () => {
  for (const h of allHarnesses()) {
    process.env[`MISSION_${h.bin.env}`] = "/fake/new";
    process.env[`FLEET_${h.bin.env}`] = "/fake/old";
    process.env[`HARNESS_${h.bin.env}`] = "/fake/older";
    assert.equal(resolveAgentBin(h.id), "/fake/new", h.id);
  }
});

test("a legacy name is still honoured, and still loses to the chain", () => {
  for (const h of allHarnesses()) {
    for (const legacy of h.bin.legacyEnv) {
      process.env[legacy] = "/fake/legacy";
      assert.equal(resolveAgentBin(h.id), "/fake/legacy", legacy);
      process.env[`MISSION_${h.bin.env}`] = "/fake/current";
      assert.equal(resolveAgentBin(h.id), "/fake/current", `MISSION_ over ${legacy}`);
      delete process.env[legacy];
      delete process.env[`MISSION_${h.bin.env}`];
    }
  }
});

test("FOREMAN_CLAUDE_BIN is still one of them", () => {
  // Named explicitly, not just covered by the loop above: it is the one env var the
  // collapse could have dropped silently, because only `claude-cli.ts` ever read it and
  // that chain is now gone. A live environment still has it set.
  assert.ok(
    HARNESSES.claude.bin.legacyEnv.includes("FOREMAN_CLAUDE_BIN"),
    "dropping this breaks existing setups with no error",
  );
});

test("an empty override is an unset one, not a request to spawn nothing", () => {
  for (const h of allHarnesses()) {
    process.env[`MISSION_${h.bin.env}`] = "";
    for (const legacy of h.bin.legacyEnv) process.env[legacy] = "";
    assert.equal(resolveAgentBin(h.id), h.bin.command, h.id);
  }
});

test("no two harnesses share an env override", () => {
  // A shared name would mean setting one harness's binary silently repoints another's.
  const seen = new Map<string, string>();
  for (const h of allHarnesses()) {
    for (const name of [h.bin.env, ...h.bin.legacyEnv]) {
      const other = seen.get(name);
      assert.equal(other, undefined, `${h.id} and ${other} both read ${name}`);
      seen.set(name, h.id);
    }
  }
});
