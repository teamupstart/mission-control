import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";
import type { BoundPane } from "../src/server/terminal/registry.ts";
import type { TerminalResult } from "../src/server/terminal/types.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";

const home = mkdtempSync(join(tmpdir(), "mission-prompt-resource-barrier-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { injectPrompt, sendText } = await import("../src/server/actions.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const ok = (): TerminalResult => ({ ok: true, outcomeUnknown: false });

function setup() {
  const registry = new Registry();
  const discovered: DiscoveredSession = {
    syntheticId: "resource-session",
    agent: "claude",
    name: "resource-session",
    nameSource: "process",
    cwd: "/repo/resource-session",
    gitBranch: "harness/cancelled-owner",
    gitRoot: "/repo",
    repoRoot: "/repo",
    nomistakesGated: false,
    pid: 1,
    tty: null,
    terminals: [],
    startedAt: 0,
  };
  registry.applyDiscovery([discovered]);
  const session = registry.getSession("resource-session")!;
  registry.upsertTask(mkTask({
    id: "cancelled-owner",
    title: "Cancelled owner",
    status: "cancelled",
    repoRoot: "/repo",
    worktreePath: session.cwd,
    branch: "harness/cancelled-owner",
    provider: "git",
  }));
  const writes: string[] = [];
  const pane: BoundPane = {
    kind: "multiplexer",
    backend: "tmux",
    label: "tmux",
    token: "tmux:%1",
    capture: async () => null,
    mode: async () => null,
    write: {
      text: async (text) => (writes.push(`text:${text}`), ok()),
      keys: async () => (writes.push("keys"), ok()),
      paste: async (text) => (writes.push(`paste:${text}`), ok()),
    },
  };
  return {
    registry,
    session,
    writes,
    pane,
    deps: {
      pane: () => pane,
      capture: async () => null,
      sleep: async () => {},
    },
    guard: () => registry.promptResourceBlockerForSession(session.id),
  };
}

test("dashboard send cannot reuse a session with cancelled resources", async () => {
  const { session, writes, deps, guard } = setup();
  const result = await sendText(session, "dashboard work", true, deps, guard);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /clean up.*cancelled task/);
  assert.deepEqual(writes, []);
});

test("transcript injection cannot reuse a session with cancelled resources", async () => {
  const { session, writes, deps, guard } = setup();
  const result = await injectPrompt(session, "transcript work", deps, guard);
  assert.equal(result.ok, false);
  assert.equal(result.pasted, false);
  assert.deepEqual(writes, []);
});

test("work-queue delivery cannot reuse a session with cancelled resources", async () => {
  const { session, writes, deps, guard } = setup();
  const result = await injectPrompt(session, "queued work", deps, guard);
  assert.equal(result.ok, false);
  assert.equal(result.pasted, false);
  assert.deepEqual(writes, []);
});

test("Foreman delivery cannot reuse a session with cancelled resources", async () => {
  const { session, writes, deps, guard } = setup();
  const result = await sendText(session, "Foreman work", false, deps, guard);
  assert.equal(result.ok, false);
  assert.deepEqual(writes, []);
});

test("prompt delivery rechecks ownership immediately before the pane write", async () => {
  const { registry, session, writes, pane, deps, guard } = setup();
  registry.upsertTask({
    ...registry.getTask("cancelled-owner")!,
    status: "running",
  });
  pane.mode = async () => {
    registry.upsertTask({
      ...registry.getTask("cancelled-owner")!,
      status: "cancelled",
    });
    return null;
  };

  const result = await injectPrompt(session, "racing work", deps, guard);
  assert.equal(result.ok, false);
  assert.equal(result.pasted, false);
  assert.deepEqual(writes, []);
});
