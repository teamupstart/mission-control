import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../src/shared/types.ts";

// What is at stake: a harness that declares a capability `null` must land on the SAME
// path the daemon already takes when that capability is unavailable for any other reason
// - the pane it cannot read, the session with no hooks, the file that isn't there. Not a
// new branch, and above all not a silent no-op.
//
// The distinction is what the whole guard migration is for. `if (agent !== "claude")`
// states WHO, so the next harness inherits a decision nobody made about it: a permission
// mode walked with keystrokes the agent doesn't understand, a `/reload-skills` typed as a
// prompt, a queue that never ticks, and - the live defect this item fixes - Claude's
// `/clear` submitted into a Codex composer, ungated, on every reset.
//
// So each block below pins one capability at BOTH ends: the null harness is refused, and
// its refusal is indistinguishable from the pre-existing degradation the code was already
// tested for.

const home = mkdtempSync(join(tmpdir(), "harness-caps-"));
// Set before importing anything that resolves the state dir (routes.ts reaches the db).
process.env.HARNESS_HOME = join(home, "state");
process.env.CODEX_HOME = join(home, "codex");

const { AGENT_TYPES } = await import("../src/shared/types.ts");
const { AGENT_NAMES } = await import("../src/shared/agent.ts");
const { HARNESS_CAPABILITIES, capabilitiesFor, skillsAgents, workQueueUnsupportedWhy } = await import(
  "../src/shared/harness-capabilities.ts"
);
const { HARNESSES } = await import("../src/server/harness/index.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ModePicker } = await import("../src/web/components/ModePicker.tsx");
const { pickableModes } = await import("../src/web/lib/format.ts");
const { reloadOwed, pendingReloads } = await import("../src/server/skills/reload.ts");
const { tickTargets } = await import("../src/server/foreman/queue-machine.ts");
const { decidePromptedWrapup } = await import("../src/server/foreman/prompted-wrapup.ts");
const { resetToOrigin } = await import("../src/server/actions.ts");
const { stubRun } = await import("../src/server/util/exec.ts");
const { mkSession } = await import("./helpers/session-fixture.ts");
const { mkOriginAndClone } = await import("./helpers/git-fixture.ts");

after(() => rmSync(home, { recursive: true, force: true }));

/** An agent whose harness declares the capability, and one that declares it null. */
function split<K extends "permissionModes" | "skills" | "workQueue" | "clearContext" | "mcp">(cap: K) {
  const has = AGENT_TYPES.filter((a) => capabilitiesFor(a)[cap] !== null);
  const hasnt = AGENT_TYPES.filter((a) => capabilitiesFor(a)[cap] === null);
  return { has, hasnt };
}

// ---- the record itself ----

test("every agent answers every capability, and each entry knows its own id", () => {
  for (const agent of AGENT_TYPES) {
    const caps = capabilitiesFor(agent);
    assert.equal(caps.id, agent, "a capability entry's id must match its key");
  }
  assert.deepEqual(Object.keys(HARNESS_CAPABILITIES).sort(), [...AGENT_TYPES].sort());
});

test("the server harness registry IS the shared record, plus what needs a filesystem", () => {
  // The split is by PURITY, not by capability. If these ever stop being the same values,
  // the dashboard and the daemon are answering the same question two ways - which is the
  // duplicate-register defect this layer exists to avoid, one layer down.
  for (const agent of AGENT_TYPES) {
    const caps = capabilitiesFor(agent);
    const harness = HARNESSES[agent];
    assert.equal(harness.permissionModes, caps.permissionModes);
    assert.equal(harness.skills, caps.skills);
    assert.equal(harness.workQueue, caps.workQueue);
    assert.equal(harness.clearContext, caps.clearContext);
    assert.equal(harness.mcp, caps.mcp);
  }
});

test("at least one harness declares each capability null - these paths are live, not theoretical", () => {
  // A guard nothing exercises rots. Codex is the live proof for all five today; if a
  // future harness fills them all in, this fails and the degradation tests below need a
  // deliberate fixture rather than quietly asserting nothing.
  for (const cap of ["permissionModes", "skills", "workQueue", "clearContext", "mcp"] as const) {
    assert.ok(split(cap).hasnt.length > 0, `nothing declares ${cap} null - the null path is untested`);
  }
});

// ---- permission modes ----

const registry = { getSession: (id: string) => SESSIONS.get(id) } as unknown as Parameters<typeof buildApp>[0];
const app = buildApp(registry, {} as never, {} as never, {} as never);
const HEADERS = { host: "127.0.0.1:7317" };
const SESSIONS = new Map<string, Session>();

test("both mode routes refuse a harness with no permission modes, and name it", async () => {
  const { hasnt } = split("permissionModes");
  for (const agent of hasnt) {
    const s = mkSession({ id: `mode-${agent}`, agent });
    SESSIONS.set(s.id, s);
    for (const path of [`/api/sessions/${s.id}/mode/cycle`, `/api/sessions/${s.id}/mode`]) {
      const res = await app.request(path, {
        method: "POST",
        headers: { ...HEADERS, "content-type": "application/json" },
        body: JSON.stringify({ mode: "plan" }),
      });
      // A 400 BEFORE the walk, not a walk that times out having typed Shift+Tab into
      // somebody's editor. The sentence names the harness, so a fourth one does not
      // inherit "permission modes are a Claude feature".
      assert.equal(res.status, 400, path);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, `${AGENT_NAMES[agent].label} has no permission modes`, path);
    }
  }
});

test("a harness with no permission modes offers none to pick, so the picker draws nothing", () => {
  const { has, hasnt } = split("permissionModes");
  for (const agent of hasnt) {
    assert.deepEqual(pickableModes(agent), []);
    // Deliberately handed a mode it could never report, so what silences the picker is
    // the CAPABILITY and not the absent reading. The three layouts mount this
    // unconditionally now; an empty string here is what makes that safe.
    const html = renderToStaticMarkup(
      createElement(ModePicker, { session: mkSession({ agent, permissionMode: "plan" }) }),
    );
    assert.equal(html, "", `${agent} must render no mode chip`);
  }
  for (const agent of has) {
    assert.ok(pickableModes(agent).length > 0, `${agent} declares modes but offers none`);
    const html = renderToStaticMarkup(
      createElement(ModePicker, { session: mkSession({ agent, permissionMode: "plan" }) }),
    );
    assert.match(html, /mode-plan/, "the other half: a harness that HAS modes still renders them");
  }
});

// ---- skills ----

test("a harness with no skills is never owed a reload, however healthy the session", () => {
  const { hasnt } = split("skills");
  const cfg = { enabled: true, skills: {}, generation: 3, generationAt: 0 };
  for (const agent of hasnt) {
    // Everything else about this session is perfect: a pane, hooks seen, idle, started
    // before the generation. The only reason it is excluded is the capability - which is
    // the same `false` a pane-less session gets, and the same one that keeps the panel's
    // counter able to reach zero.
    const s = mkSession({ id: `sk-${agent}`, agent, state: "idle", hooksSeen: true, startedAt: null });
    assert.equal(reloadOwed(s, new Map(), cfg), false);
    assert.equal(pendingReloads([s], new Map(), cfg), 0, "a session nothing can reload must not be counted");
  }
});

test("the reload command comes from the harness, not from a shared constant", () => {
  // It is typed into a live pane, so it has exactly one definition - and that definition
  // is per-harness, which is what stops a second one inheriting Claude's slash vocabulary.
  for (const agent of skillsAgents()) {
    const spec = capabilitiesFor(agent).skills!;
    assert.ok(spec.reloadCommand.startsWith("/"), "a reload command is a slash command");
    assert.doesNotMatch(spec.reloadCommand, /\n/, "a command carrying a newline is two submissions");
  }
});

// ---- work queue ----

test("a harness that can't hold a queue is never selected for a tick, or asked to wrap up", () => {
  const { has, hasnt } = split("workQueue");
  // `pendingReviews` puts every one of them in `needs-you`, so the ONLY thing that
  // differs between these sessions is the agent - and therefore the only thing that can
  // explain a selection difference is the capability. Without that, a selector that
  // returned nothing at all would satisfy the negative assertion vacuously.
  const sessions = AGENT_TYPES.map((agent) =>
    mkSession({ id: `q-${agent}`, agent, state: "idle", hooksSeen: true, instrumented: true, pendingReviews: 1 }),
  );
  const selected = new Set(tickTargets(sessions, ["drain", "prompted"]).map((s) => s.id));
  for (const agent of hasnt) assert.equal(selected.has(`q-${agent}`), false, `${agent} must not be ticked`);
  for (const agent of has) assert.equal(selected.has(`q-${agent}`), true, `${agent} must still be ticked`);

  for (const agent of hasnt) {
    const verdict = decidePromptedWrapup({
      session: mkSession({ agent, state: "idle" }),
      bucket: "idle",
      queue: null,
      goalPrompt: "ship the thing",
      cfg: { triggers: ["prompted"] } as never,
      now: 0,
    } as never);
    assert.equal(verdict.kind, "skip");
    assert.match(verdict.why ?? "", new RegExp(AGENT_NAMES[agent].label));
  }
});

test("the panel's refusal and the daemon's are the same sentence, composed once", () => {
  const { has, hasnt } = split("workQueue");
  for (const agent of hasnt) {
    const why = workQueueUnsupportedWhy(agent);
    assert.ok(why, `${agent} needs a reason, not a bare false`);
    // Named from AGENT_NAMES rather than hardcoded, so a fourth harness gets a true
    // sentence instead of inheriting Codex's.
    assert.match(why!, new RegExp(AGENT_NAMES[agent].label));
  }
  for (const agent of has) assert.equal(workQueueUnsupportedWhy(agent), null);
});

// ---- clearing context: the defect this item fixes ----

/** A session with a pane, and a fake terminal that counts what was written to it. */
function withCountedPane(clone: string, agent: Session["agent"], screens: (string | null)[]) {
  let writes = 0;
  const session = mkSession({
    agent,
    cwd: clone,
    gitBranch: "main",
    tmux: { session: "s", window: "w", windowIndex: 0, paneId: "%1" },
    wezterm: null,
  });
  const deps = {
    exec: async () => {
      writes++;
      return stubRun({ stdout: "", stderr: "", code: 0 });
    },
    capture: async () => (screens.length ? screens.shift()! : null),
    sleep: async () => {},
  };
  return { session, deps, writes: () => writes };
}

test("a harness with no clear command has NOTHING typed at it, and reports cleared:false", async () => {
  const { hasnt } = split("clearContext");
  for (const agent of hasnt) {
    const { clone } = mkOriginAndClone("harness-caps-clear-");
    // A pane, a live session, and `clear: true` - every precondition the old code needed
    // to send Claude's `/clear`. The capability is the only thing stopping it.
    const { session, deps, writes } = withCountedPane(clone, agent, ["> ", "> ", "cleared"]);
    const r = await resetToOrigin(session, true, deps as never);
    assert.equal(r.ok, true, "the git half still lands - this is a degradation, not a failure");
    assert.equal(r.cleared, false);
    assert.equal(writes(), 0, `${agent} must not be sent a slash command it does not speak`);
  }
});

test("that degradation is byte-identical to asking for no clear at all", async () => {
  // The point of the whole exercise: the null capability lands on a path the callers
  // (`resetSession`, `TaskManager.assign`, the ResetModal) were already tested against,
  // rather than on a new shape they each have to learn.
  const { hasnt } = split("clearContext");
  for (const agent of hasnt) {
    const { clone } = mkOriginAndClone("harness-caps-clear-eq-");
    const a = withCountedPane(clone, agent, ["> ", "> ", "cleared"]);
    const asked = await resetToOrigin(a.session, true, a.deps as never);
    const b = withCountedPane(clone, agent, ["> ", "> ", "cleared"]);
    const notAsked = await resetToOrigin(b.session, false, b.deps as never);
    assert.deepEqual(asked, notAsked);
  }
});

test("a harness that DOES declare a clear command still clears - the other half of the pin", async () => {
  const { has } = split("clearContext");
  for (const agent of has) {
    const { clone } = mkOriginAndClone("harness-caps-clear-ok-");
    const command = capabilitiesFor(agent).clearContext!.command;
    // The read-back checks for the bytes that were typed, not for a literal "/clear" -
    // so a harness whose command is spelled differently is not reported as never having
    // echoed anything.
    const { session, deps } = withCountedPane(clone, agent, ["> ", `> ${command}`, "welcome back"]);
    const r = await resetToOrigin(session, true, deps as never);
    assert.equal(r.cleared, true, `${agent} declares ${command} and must be reported as having run it`);
  }
});
