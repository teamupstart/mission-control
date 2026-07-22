import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentType, Session } from "../src/shared/types.ts";
// Type-only, so it is erased rather than resolved: a static import of `actions.ts` here
// would reach the db before the HARNESS_HOME preamble below has run.
import type { InjectDeps } from "../src/server/actions.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

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
const { AGENT_IDENTITY } = await import("../src/shared/agent.ts");
const { HARNESS_CAPABILITIES, capabilitiesFor, skillsAgents, supportsSessionEffort, workQueueUnsupportedWhy } = await import(
  "../src/shared/harness-capabilities.ts"
);
const { HARNESSES } = await import("../src/server/harness/index.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ModePicker } = await import("../src/web/components/ModePicker.tsx");
const { EffortPicker, reconcileOptimisticEffort } = await import("../src/web/components/EffortPicker.tsx");
const { pickableModes } = await import("../src/web/lib/format.ts");
const { reloadOwed, pendingReloads } = await import("../src/server/skills/reload.ts");
const { tickTargets } = await import("../src/server/foreman/queue-machine.ts");
const { decidePromptedWrapup } = await import("../src/server/foreman/prompted-wrapup.ts");
const { resetToOrigin } = await import("../src/server/actions.ts");
const { bindSession } = await import("../src/server/terminal/registry.ts");
const { stubRun } = await import("../src/server/util/exec.ts");
const { meta, mkSession } = await import("./helpers/session-fixture.ts");
const { mkOriginAndClone } = await import("./helpers/git-fixture.ts");
const { MODEL_PICKER_XHIGH } = await import("./fixtures/claude-panes.ts");

after(() => rmSync(home, { recursive: true, force: true }));

type SplitCap = "permissionModes" | "skills" | "workQueue" | "clearContext" | "mcp";

/** An agent whose harness declares the capability, and one that declares it null. */
function split<K extends SplitCap>(cap: K) {
  const has = AGENT_TYPES.filter((a) => capabilitiesFor(a)[cap] !== null);
  const hasnt = AGENT_TYPES.filter((a) => capabilitiesFor(a)[cap] === null);
  return { has, hasnt };
}

/**
 * Run `fn` with one agent's capability forced to null, then put it back.
 *
 * The "deliberate fixture" the null-coverage test below asks for. Codex used to declare
 * `skills`, `clearContext` and `mcp` null and so exercised those degradation paths for
 * free; it declares all three now, and a `hasnt` list that has quietly gone empty makes
 * every loop over it pass by iterating nothing. The paths are still live - they are what
 * a third harness that fills in less than these two would land on - so they get a fixture
 * rather than being dropped.
 *
 * Both records, because `HARNESSES` SPREADS `HARNESS_CAPABILITIES` at module load: a
 * server-side reader (`harnessFor`) would otherwise still see the real value.
 */
async function withCapabilityNull<T>(agent: AgentType, cap: SplitCap, fn: () => Promise<T> | T): Promise<T> {
  const caps = HARNESS_CAPABILITIES[agent];
  const harness = HARNESSES[agent] as unknown as Record<string, unknown>;
  const priorCap = caps[cap];
  const priorHarness = harness[cap];
  (caps as unknown as Record<string, unknown>)[cap] = null;
  harness[cap] = null;
  try {
    return await fn();
  } finally {
    (caps as unknown as Record<string, unknown>)[cap] = priorCap;
    harness[cap] = priorHarness;
  }
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
    assert.equal(harness.effort, caps.effort);
  }
});

test("each shipped harness declares its launch-time effort syntax", () => {
  assert.deepEqual(capabilitiesFor("claude").effort?.launchArgs("high"), ["--effort", "high"]);
  assert.deepEqual(capabilitiesFor("codex").effort?.launchArgs("xhigh"), [
    "-c",
    "model_reasoning_effort=xhigh",
  ]);
});

test("the live effort picker follows the selected model, not the launch default", () => {
  assert.equal(capabilitiesFor("codex").effort?.levelsFor("gpt-5.6-sol").includes("max"), true);
  assert.equal(supportsSessionEffort("codex", "gpt-5.6-sol", "max"), false);
  assert.equal(supportsSessionEffort("codex", "gpt-5.5", "max"), false);
  assert.equal(supportsSessionEffort("claude", "claude-opus-4-8", "max"), true);
  assert.equal(capabilitiesFor("claude").effort?.sessionPicker?.command, "/model");
  assert.equal(
    capabilitiesFor("claude").effort?.sessionPicker?.selected(MODEL_PICKER_XHIGH, "Opus 4.8"),
    "xhigh",
  );
  assert.equal(capabilitiesFor("codex").effort?.sessionPicker, null);
});

test("every capability's null path is exercised, by a real harness or a named fixture", () => {
  // A guard nothing exercises rots. Codex used to be the live proof for all five; it now
  // declares `skills`, `workQueue`, `clearContext` and `mcp`, so those four moved to
  // `withCapabilityNull` fixtures rather than being dropped - the paths are what a harness
  // filling in less than these two would land on, and they are still reachable code.
  //
  // The point of naming them HERE is that the two lists cannot drift apart silently. A
  // capability that gains a null declarer must leave `BY_FIXTURE`, and one that loses its
  // last declarer must join it - either way this fails first, rather than a loop over an
  // empty `hasnt` quietly asserting nothing.
  const BY_FIXTURE: readonly SplitCap[] = ["skills", "workQueue", "clearContext", "mcp"];
  for (const cap of ["permissionModes", "skills", "workQueue", "clearContext", "mcp"] as const) {
    const declared = split(cap).hasnt.length > 0;
    if (BY_FIXTURE.includes(cap)) {
      assert.equal(declared, false, `${cap} has a real null declarer again - drop it from BY_FIXTURE`);
    } else {
      assert.ok(declared, `nothing declares ${cap} null - give it a withCapabilityNull fixture`);
    }
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
      assert.equal(body.error, `${AGENT_IDENTITY[agent].label} has no permission modes`, path);
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

test("only a harness with session-only effort control renders a live picker", () => {
  const sol = renderToStaticMarkup(
    createElement(EffortPicker, {
      session: mkSession({ agent: "codex", meta: meta({ modelId: "gpt-5.6-sol", thinkingLevel: "high" }) }),
    }),
  );
  assert.doesNotMatch(sol, /Change effort for this session/);
  const claude = renderToStaticMarkup(
    createElement(EffortPicker, {
      session: mkSession({ agent: "claude", meta: meta({ thinkingLevel: "high" }) }),
    }),
  );
  assert.match(claude, /Change effort for this session/);
});

test("a newer conflicting metadata read clears an optimistic effort", () => {
  const optimistic = { level: "max" as const, modelId: "claude-opus-4-8", updatedAt: 10 };
  assert.equal(reconcileOptimisticEffort(optimistic, "high", "claude-opus-4-8", 10), optimistic);
  assert.equal(reconcileOptimisticEffort(optimistic, "max", "claude-opus-4-8", 11), null);
  assert.equal(reconcileOptimisticEffort(optimistic, "high", "claude-opus-4-8", 11), null);
  assert.equal(reconcileOptimisticEffort(optimistic, "high", "claude-sonnet-4-6", 10), null);
});

// ---- skills ----

test("a harness with no skills is never owed a reload, however healthy the session", async () => {
  const cfg = { enabled: true, skills: {}, generation: 3, generationAt: 0 };
  await withCapabilityNull("codex", "skills", () => {
    // Everything else about this session is perfect: a pane, hooks seen, idle, started
    // before the generation. The only reason it is excluded is the capability - which is
    // the same `false` a pane-less session gets, and the same one that keeps the panel's
    // counter able to reach zero.
    const s = mkSession({ id: "sk-none", agent: "codex", state: "idle", hooksSeen: true, startedAt: null });
    assert.equal(reloadOwed(s, new Map(), cfg), false);
    assert.equal(pendingReloads([s], new Map(), cfg), 0, "a session nothing can reload must not be counted");
  });
});

test("a harness with skills but NO reload command is owed nothing either", () => {
  // Codex, which is the reason `reloadCommand` is nullable at all: it watches its skills
  // directory itself, so the skill arrives (`skillsDirs()` links it there) and no
  // keystroke is owed. The two halves are separate capabilities, and conflating them
  // would either type a made-up slash command into a Codex prompt or leave the panel's
  // counter above zero for a session nothing will ever reload.
  const cfg = { enabled: true, skills: {}, generation: 3, generationAt: 0 };
  const owed = AGENT_TYPES.filter((a) => capabilitiesFor(a).skills && !capabilitiesFor(a).skills!.reloadCommand);
  assert.ok(owed.length > 0, "codex is the live proof - if it goes, this needs a fixture");
  for (const agent of owed) {
    const s = mkSession({ id: `sk-${agent}`, agent, state: "idle", hooksSeen: true, startedAt: null });
    assert.equal(reloadOwed(s, new Map(), cfg), false);
    assert.equal(pendingReloads([s], new Map(), cfg), 0);
    assert.equal(skillsAgents().includes(agent as never), false, "not a broadcast target");
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
    assert.match(verdict.why ?? "", new RegExp(AGENT_IDENTITY[agent].label));
  }
});

test("the work-queue null path still refuses selection and explains why", async () => {
  await withCapabilityNull("codex", "workQueue", () => {
    const session = mkSession({
      id: "q-codex-null",
      agent: "codex",
      state: "idle",
      hooksSeen: true,
      instrumented: true,
      pendingReviews: 1,
    });
    assert.deepEqual(tickTargets([session], ["drain", "prompted"]), []);
    assert.match(workQueueUnsupportedWhy("codex") ?? "", /Codex/);

    const verdict = decidePromptedWrapup({
      session,
      bucket: "idle",
      queue: null,
      goalPrompt: "ship the thing",
      cfg: { triggers: ["prompted"] } as never,
      now: 0,
    } as never);
    assert.equal(verdict.kind, "skip");
    assert.match(verdict.why ?? "", /Codex/);
  });
});

test("the panel's refusal and the daemon's are the same sentence, composed once", () => {
  const { has, hasnt } = split("workQueue");
  for (const agent of hasnt) {
    const why = workQueueUnsupportedWhy(agent);
    assert.ok(why, `${agent} needs a reason, not a bare false`);
    // Named from AGENT_IDENTITY rather than hardcoded, so a fourth harness gets a true
    // sentence instead of inheriting Codex's.
    assert.match(why!, new RegExp(AGENT_IDENTITY[agent].label));
  }
  for (const agent of has) assert.equal(workQueueUnsupportedWhy(agent), null);
});

// ---- clearing context: the defect this item fixes ----

/**
 * A session with a pane, and a fake terminal that counts every command run against it.
 *
 * Counted at the SUBPROCESS, below the adapter, so "nothing was typed at this agent" means
 * no command ran at all - not even the mode probe that precedes a write. A counter above
 * the adapter would be counting the policy's intentions rather than the pane's traffic.
 */
function withCountedPane(clone: string, agent: Session["agent"], screens: (string | null)[]) {
  let writes = 0;
  const session = mkSession({
    agent,
    cwd: clone,
    gitBranch: "main",
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: "%1" })],
  });
  const deps: InjectDeps = {
    pane: (s) =>
      bindSession(s, async () => {
        writes++;
        return stubRun({ stdout: "", stderr: "", code: 0 });
      }),
    capture: async () => (screens.length ? screens.shift()! : null),
    sleep: async () => {},
  };
  return { session, deps, writes: () => writes };
}

test("a harness with no clear command has NOTHING typed at it, and reports cleared:false", async () => {
  await withCapabilityNull("codex", "clearContext", async () => {
    const { clone } = mkOriginAndClone("harness-caps-clear-");
    // A pane, a live session, and `clear: true` - every precondition the old code needed
    // to send Claude's `/clear`. The capability is the only thing stopping it.
    const { session, deps, writes } = withCountedPane(clone, "codex", ["> ", "> ", "cleared"]);
    const r = await resetToOrigin(session, true, deps);
    assert.equal(r.ok, true, "the git half still lands - this is a degradation, not a failure");
    assert.equal(r.cleared, false);
    assert.equal(writes(), 0, "a harness must not be sent a slash command it does not speak");
  });
});

test("that degradation is byte-identical to asking for no clear at all", async () => {
  // The point of the whole exercise: the null capability lands on a path the callers
  // (`resetSession`, `TaskManager.assign`, the ResetModal) were already tested against,
  // rather than on a new shape they each have to learn.
  await withCapabilityNull("codex", "clearContext", async () => {
    const { clone } = mkOriginAndClone("harness-caps-clear-eq-");
    const a = withCountedPane(clone, "codex", ["> ", "> ", "cleared"]);
    const asked = await resetToOrigin(a.session, true, a.deps);
    const b = withCountedPane(clone, "codex", ["> ", "> ", "cleared"]);
    const notAsked = await resetToOrigin(b.session, false, b.deps);
    assert.deepEqual(asked, notAsked);
  });
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
    const r = await resetToOrigin(session, true, deps);
    assert.equal(r.cleared, true, `${agent} declares ${command} and must be reported as having run it`);
  }
});
