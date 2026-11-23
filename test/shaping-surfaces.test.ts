import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FeatureFlagsConfig } from "../src/shared/feature-flags.ts";
import { currentShaping, shapingView, taskShapingRead, withCurrentShaping, type TaskShaping } from "../src/shared/shaping.ts";
import type { Session, TaskSummary } from "../src/shared/types.ts";
import { FeatureFlagsContext } from "../src/web/useFeatureFlag.ts";
import {
  RoutedSkills, ShapingChip, ShapingRailMark, ShapingTileFlag, afterWorkPromptWords, deliveredState, shapingChipLabel,
} from "../src/web/components/ShapingChip.tsx";
import type { ShapingSkillSummary, TaskSkillPrompt } from "../src/shared/shaping.ts";
import { mkSession } from "./helpers/session-fixture.ts";

// The reader rule and the session surfaces that apply it: the chip's two states, the board and
// rail markers, and nothing at all for a record that names another session or with the flag off.

const on: FeatureFlagsConfig = { enableAll: false, overrides: { "task-shaping": true } };
const off: FeatureFlagsConfig = { enableAll: false, overrides: {} };

function record(sessionId: string, state: TaskShaping["state"], entries = 2): TaskShaping {
  return {
    state, at: 1, sessionId, durationMs: 40, entries, bytes: 120, truncated: false,
    shapers: [{
      id: "acme", label: "Acme guidance", stage: "select", origin: "registered", sha256: null,
      outcome: state === "ok" ? "ok" : "timed_out", reason: state === "ok" ? null : "Timed out after 5 s.",
      durationMs: 40, entries, bytes: 120, truncated: false, redacted: false, version: "v1.4.0",
    }],
  };
}

function session(shaping: TaskShaping | undefined, id = "s1"): Session {
  return mkSession({ id, task: { id: "t1", title: "Task", ...(shaping ? { shaping } : {}) } as unknown as TaskSummary });
}

function render(flags: FeatureFlagsConfig, element: React.ReactElement): string {
  return renderToStaticMarkup(createElement(FeatureFlagsContext.Provider, { value: flags }, element));
}

test("currentShaping shows a record only while it names the task's current session", () => {
  assert.deepEqual(currentShaping({ shaping: record("s1", "ok"), sessionId: "s1" }), record("s1", "ok"));
  assert.equal(currentShaping({ shaping: record("s0", "degraded"), sessionId: "s1" }), null, "an earlier launch's record");
  assert.equal(currentShaping({ shaping: record("s1", "ok"), sessionId: null }), null, "no current session");
  assert.equal(currentShaping({ shaping: { ...record("s1", "ok"), sessionId: undefined }, sessionId: "s1" }), null, "an unstamped record");
  assert.equal(currentShaping({ shaping: null, sessionId: "s1" }), null);
});

test("shapingView reports shaping while the mark is set, and the current record otherwise", () => {
  assert.deepEqual(shapingView({ sessionId: null, shapingContext: { startedAt: 7 } }), { state: "shaping", startedAt: 7 });
  // The wait wins over an earlier launch's record, which is what the launch in progress replaces.
  assert.equal(shapingView({ sessionId: "s1", shaping: record("s1", "ok"), shapingContext: { startedAt: 7 } })?.state, "shaping");
  assert.deepEqual(shapingView({ sessionId: "s1", shaping: record("s1", "degraded") }), record("s1", "degraded"));
  assert.equal(shapingView({ sessionId: "s1", shaping: record("s0", "degraded") }), null, "never another session's record");
  assert.equal(shapingView({ sessionId: "s1", shapingContext: null }), null);
});

test("task reads drop a record that names another session and keep the current one", () => {
  const stale = withCurrentShaping({ id: "t", sessionId: "s1", shaping: record("s0", "degraded") });
  assert.equal("shaping" in stale, false);
  const kept = withCurrentShaping({ id: "t", sessionId: "s1", shaping: record("s1", "ok") });
  assert.deepEqual(kept.shaping, record("s1", "ok"));
  const plain = { id: "t", sessionId: "s1" };
  assert.equal(withCurrentShaping(plain), plain, "an unshaped task is returned untouched");
  assert.deepEqual(taskShapingRead({ sessionId: "s1", shaping: record("s1", "degraded") }), {
    state: "degraded", sessionId: "s1", summary: "degraded: acme timed out; 2 entries",
  });
  assert.equal(taskShapingRead({ sessionId: "s1", shaping: record("s0", "degraded") }), null);
});

test("the chip reads Context: N entries, or an amber Context degraded", () => {
  const ok = render(on, createElement(ShapingChip, { session: session(record("s1", "ok")) }));
  assert.match(ok, />Context: 2 entries</);
  assert.doesNotMatch(ok, /is-degraded/);
  const one = render(on, createElement(ShapingChip, { session: session(record("s1", "ok", 1)) }));
  assert.match(one, />Context: 1 entry</);
  const degraded = render(on, createElement(ShapingChip, { session: session(record("s1", "degraded")) }));
  assert.match(degraded, />Context degraded</);
  assert.match(degraded, /task-context-chip is-degraded/);
  assert.match(degraded, /Timed out after 5 s\./, "the reason is in its tooltip");
});

test("a record that names another session renders no chip, no tile marker and no rail marker", () => {
  const other = session(record("s0", "degraded"), "s1");
  assert.equal(render(on, createElement(ShapingChip, { session: other })), "");
  assert.equal(render(on, createElement(ShapingTileFlag, { session: other })), "");
  assert.equal(render(on, createElement(ShapingRailMark, { session: other })), "");
});

test("the board and rail markers appear only for this session's degraded launch", () => {
  const degraded = session(record("s1", "degraded"));
  assert.match(render(on, createElement(ShapingTileFlag, { session: degraded })), /tile-flag tf-shaping[^>]*>context degraded</);
  assert.match(render(on, createElement(ShapingRailMark, { session: degraded })), /aria-label="Context degraded"/);
  const ok = session(record("s1", "ok"));
  assert.equal(render(on, createElement(ShapingTileFlag, { session: ok })), "");
  assert.equal(render(on, createElement(ShapingRailMark, { session: ok })), "");
  assert.equal(render(on, createElement(ShapingTileFlag, { session: session(undefined) })), "");
});

test("with the flag off nothing renders, whatever the record says", () => {
  const degraded = session(record("s1", "degraded"));
  for (const component of [ShapingChip, ShapingTileFlag, ShapingRailMark]) {
    assert.equal(render(off, createElement(component, { session: degraded })), "");
  }
});

test("the viewer tells an unavailable delivery apart from a launch that added nothing", () => {
  const delivered = record("s1", "ok");
  assert.deepEqual(deliveredState("loading", delivered), { kind: "loading" });
  assert.deepEqual(deliveredState({ summary: delivered, text: "## Task context" }, delivered), { kind: "text", text: "## Task context" });
  // The route's 404, or a reply that describes a newer launch: the text is not this launch's to show.
  assert.deepEqual(deliveredState(null, delivered), { kind: "unavailable" });
  assert.deepEqual(deliveredState({ summary: { ...delivered, at: 99 }, text: "newer" }, delivered), { kind: "unavailable" });
  // Only a matching reply with no text, or a record that counts no entries, says nothing was added.
  assert.deepEqual(deliveredState({ summary: delivered, text: null }, delivered), { kind: "none" });
  assert.deepEqual(deliveredState(null, record("s1", "degraded", 0)), { kind: "none" });
});

function skill(name: string, state: ShapingSkillSummary["state"], lifecyclePoint = "during", extra: Partial<ShapingSkillSummary> = {}): ShapingSkillSummary {
  return { name, lifecyclePoint, reasonId: `route/${name}`, shaper: "router", repositories: [], state, verified: false, reason: null, ...extra };
}

test("the chip counts announced skills beside entries, or reads Skills: N when only skills were added", () => {
  const skills = [skill("ship", "announced"), skill("retro", "announced", "after-work"), skill("odd", "unsupported")];
  assert.equal(shapingChipLabel(record("s1", "ok", 3)), "Context: 3 entries", "no router, as before");
  assert.equal(shapingChipLabel({ ...record("s1", "ok", 3), skills }), "Context: 3 entries, 2 skills");
  assert.equal(shapingChipLabel({ ...record("s1", "ok", 1), skills: skills.slice(0, 1) }), "Context: 1 entry, 1 skill");
  assert.equal(shapingChipLabel({ ...record("s1", "ok", 0), skills }), "Skills: 2");
  assert.equal(shapingChipLabel({ ...record("s1", "ok", 0), skills: [skill("odd", "dropped")] }), "Context: 0 entries");
  const html = render(on, createElement(ShapingChip, { session: session({ ...record("s1", "ok", 0), skills }) }));
  assert.match(html, />Skills: 2</);
  assert.match(render(on, createElement(ShapingChip, { session: session({ ...record("s1", "degraded", 0), skills }) })), />Context degraded</,
    "degraded wins over the counts");
});

test("the viewer lists each skill with when, its reason id, its router, whether it was verified, and its state", () => {
  const html = renderToStaticMarkup(createElement(RoutedSkills, {
    skills: [
      skill("ship", "announced", "task-start", { verified: true, repositories: ["billing-api"] }),
      skill("retro", "unavailable", "after-work", { reason: "Enable Skills and the retro skill before sending this instruction." }),
      skill("odd", "unsupported", "before-merge", { reason: 'This build does not know the lifecycle point "before-merge".' }),
    ],
    // A router of its own, named for what it does.
    shapers: [{ ...record("s1", "ok").shapers[0]!, id: "router", label: "Skill router", stage: "route" }],
    afterWork: null,
  }));
  assert.match(html, /aria-label="Skills for this task"/);
  assert.match(html, /aria-label="ship: Announced"/);
  assert.match(html, /at the start · routed by Skill router · verified in the skill catalog · billing-api/);
  assert.match(html, /<code>route\/ship<\/code>/);
  assert.match(html, /aria-label="retro: Unavailable"[\s\S]*Enable Skills and the retro skill/);
  assert.match(html, /aria-label="odd: Unsupported"[\s\S]*before-merge · routed by Skill router · not verified/);
  assert.equal(html.includes("Not prompted yet"), false, "an after-work skill that was not announced has no prompt line");
});

test("an announced after-work skill says whether, and when, it was prompted", () => {
  const prompt = (state: TaskSkillPrompt["state"], extra: Partial<TaskSkillPrompt> = {}): TaskSkillPrompt =>
    ({ sessionId: "s1", state, reason: null, skills: ["retro"], createdAt: 1, deliveredAt: null, ...extra });
  assert.match(afterWorkPromptWords(prompt("delivered", { deliveredAt: Date.UTC(2026, 0, 1, 9, 30) }), "retro", false), /^Prompted at /);
  assert.equal(afterWorkPromptWords(prompt("delivered"), "retro", false), "Prompted.");
  assert.match(afterWorkPromptWords(prompt("delivered", { skills: ["notes"] }), "retro", false), /^Not prompted: /);
  assert.match(afterWorkPromptWords(prompt("queued"), "retro", false), /^Prompt queued/);
  assert.equal(afterWorkPromptWords(prompt("held"), "retro", false), "Prompt held until Foreman's wrap-up is answered.");
  assert.equal(afterWorkPromptWords(prompt("not_delivered", { reason: "The session ended before the prompt was delivered." }), "retro", false),
    "Not delivered: The session ended before the prompt was delivered.");
  assert.match(afterWorkPromptWords(null, "retro", false), /^Not prompted yet/);
  assert.match(afterWorkPromptWords(null, "retro", true), /^Checking/);
  const html = renderToStaticMarkup(createElement(RoutedSkills, {
    skills: [skill("retro", "announced", "after-work")], shapers: [], afterWork: prompt("delivered"),
  }));
  assert.match(html, /role="note">Prompted\.</);
  const dryRun = renderToStaticMarkup(createElement(RoutedSkills, { skills: [skill("retro", "announced", "after-work")], shapers: [], afterWork: undefined }));
  assert.equal(dryRun.includes("role=\"note\""), false, "a dry run prompts nothing, so it says nothing about prompting");
});
