import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionNote } from "../src/shared/types.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";

// Isolate the db in a throwaway home before config.ts resolves the state dir.
const home = mkdtempSync(join(tmpdir(), "fleet-notes-"));
process.env.HARNESS_HOME = home;
const { openDb, upsertSessionNote, getSessionNote, loadSessionNotes } = await import(
  "../src/server/db.ts"
);
const { Registry, noteKeyFor } = await import("../src/server/registry.ts");

after(() => rmSync(home, { recursive: true, force: true }));

function mkNote(over: Partial<SessionNote> = {}): SessionNote {
  return {
    noteKey: "agent-1",
    purpose: "Refactoring auth.",
    brief: null,
    recommendation: null,
    disposition: "pending",
    lastAction: null,
    handledMarker: "await:1",
    updatedAt: 1000,
    ...over,
  };
}

function mkDiscovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: "sid",
    agent: "claude",
    name: "n",
    nameSource: "process",
    cwd: "/wt/a",
    gitBranch: null,
    nomistakesGated: false,
    pid: 1,
    tty: "ttys1",
    wezterm: null,
    tmux: null,
    startedAt: 0,
    ...over,
  };
}

test("session note round-trips in the db", () => {
  openDb();
  upsertSessionNote(mkNote());
  const got = getSessionNote("agent-1");
  assert.equal(got?.purpose, "Refactoring auth.");
  assert.equal(got?.disposition, "pending");
  assert.equal(got?.handledMarker, "await:1");
});

test("noteKeyFor prefers the agent session id, falls back to synthetic id", () => {
  assert.equal(noteKeyFor({ id: "sid", agentSessionId: "agent-9" } as never), "agent-9");
  assert.equal(noteKeyFor({ id: "sid", agentSessionId: null } as never), "sid");
});

test("registry.upsertNote merges over the existing note (purpose-only patch keeps the brief)", () => {
  const r = new Registry();
  r.applyDiscovery([mkDiscovered({ syntheticId: "s2", cwd: "/wt/b" })]);
  const s = r.snapshot().sessions.find((x) => x.id === "s2")!;
  r.upsertNote(s.id, { purpose: "P1", brief: "the brief", disposition: "escalated" });
  r.upsertNote(s.id, { purpose: "P2" }); // patch only the purpose
  const note = r.getNote(s.id);
  assert.equal(note?.purpose, "P2");
  assert.equal(note?.brief, "the brief", "brief survives a purpose-only patch");
  assert.equal(note?.disposition, "escalated");
});

test("a note is denormalized onto its session (matched by note key)", () => {
  const r = new Registry();
  r.applyDiscovery([mkDiscovered({ syntheticId: "s3", cwd: "/wt/c" })]);
  const s = r.snapshot().sessions.find((x) => x.id === "s3")!;
  assert.equal(s.note, null);
  r.upsertNote(s.id, {
    purpose: "denorm me",
    disposition: "answered",
    lastAction: "answered: x",
    handledMarker: "review:r-1",
  });
  const after = r.snapshot().sessions.find((x) => x.id === "s3")!;
  assert.equal(after.note?.purpose, "denorm me");
  assert.equal(after.note?.disposition, "answered");
  assert.equal(after.note?.lastAction, "answered: x");
  assert.equal(after.note?.handledMarker, "review:r-1", "the drafted channel travels onto the card");
});

test("notes rehydrate into a fresh Registry and attach by agent session id", () => {
  upsertSessionNote(mkNote({ noteKey: "agent-77", purpose: "survives restart" }));
  assert.ok(loadSessionNotes().some((n) => n.noteKey === "agent-77"));
  const r = new Registry();
  // A discovered session whose agent id resolves to the stored note key.
  r.applyDiscovery([mkDiscovered({ syntheticId: "s4", cwd: "/wt/d" })]);
  // Bind the agent session id via a hook so noteKeyFor resolves to "agent-77".
  r.applyHook({
    event: "SessionStart",
    sessionId: "agent-77",
    cwd: "/wt/d",
    transcriptPath: null,
    env: {},
  } as never);
  const s = r.snapshot().sessions.find((x) => x.id === "s4");
  assert.equal(s?.note?.purpose, "survives restart");
});
