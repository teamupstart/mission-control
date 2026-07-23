import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillsPanel } from "../src/web/components/SkillsPanel.tsx";
import type { SkillsState } from "../src/web/useSkills.ts";
import type { SkillRow, SkillsView } from "../src/shared/types.ts";
import { AGENT_IDENTITY, agentList } from "../src/shared/agent.ts";
import { AGENT_TYPES } from "../src/shared/types.ts";
import { capabilitiesFor, skillsAgents } from "../src/shared/harness-capabilities.ts";

/**
 * Who the panel is entitled to name, read off the `skills` capability - the same source
 * the panel itself reads.
 *
 * Asserted as a PAIR (named / not named) rather than against the computed string alone,
 * which would be vacuous: the interesting property is that a harness with no skills
 * capability is never claimed to be affected, and that is a real fact about the record,
 * not a restatement of the render.
 */
const SKILLED = AGENT_TYPES.filter((a) => capabilitiesFor(a).skills);
const UNSKILLED = AGENT_TYPES.filter((a) => !capabilitiesFor(a).skills);
/** Who a change has to be TYPED at - a strict subset of SKILLED. See `skillsAgents`. */
const RELOADED = skillsAgents();

// The skills panel, rendered. Static markup rather than a driven browser: this
// dashboard's pages don't take script injection from the automation extension, and
// these are questions about words and structure.
//
// What's at stake is that the panel never over-promises, and - since Codex gained a
// skills directory - never UNDER-promises either. Enabling a skill loads it; it does not
// oblige the agent to use it. A row that says only "on" claims the first; a row still
// saying "claude only" over a reconciler that writes into two directories denies the
// second. Both sentences are computed from the capability rather than typed.

function mkRow(over: Partial<SkillRow> = {}): SkillRow {
  return {
    id: "html-plans",
    name: "html-plans",
    description: "Renders a plan as a page.",
    category: "planning",
    enforcement: "triggered",
    enabled: false,
    ...over,
  };
}

function mkView(over: Partial<SkillsView> = {}): SkillsView {
  return { enabled: true, skills: [mkRow()], pending: 0, problems: [], ...over };
}

function render(over: Partial<SkillsState> = {}): string {
  const state: SkillsState = {
    view: mkView(),
    update: async () => {},
    error: null,
    ...over,
  };
  return renderToStaticMarkup(createElement(SkillsPanel, { state }));
}

test("a row shows the skill's user-facing name, not its prefixed directory", () => {
  const html = render();
  assert.match(html, /\/html-plans/);
  assert.doesNotMatch(html, /mission-html-plans/);
});

test("every row carries its enforcement rung", () => {
  // `/reload-skills` fixes DELIVERY, not activation. A reloaded skill is loaded, not
  // obeyed, and the badge is the only thing on the row that says so.
  assert.match(render(), /on triggers/);
  assert.match(
    render({ view: mkView({ skills: [mkRow({ enforcement: "opportunistic" })] }) }),
    /when relevant/,
  );
});

test("a row names who a skill LEAVES OUT, and says nothing when nobody is left out", () => {
  // A harness with no skills capability has no reload command and no skills directory,
  // so the loop skips it entirely. A toggle that silently no-ops on half the grid is the
  // failure that disqualified launch flags - and a row that NAMED such a harness would be
  // the same lie with the words the other way round.
  //
  // Every shipped harness declares `skills` now, so the badge renders for nobody. Left
  // unconditional it printed "claude only" - false - over a title that composed to
  // " sessions are unaffected", a caveat with a blank where the subject should be.
  const html = render();
  if (UNSKILLED.length === 0) {
    assert.doesNotMatch(html, /skill-badge-agent/, "no caveat when there is nobody to caveat about");
    assert.doesNotMatch(html, / only</, "and no 'X only' claim that is not true");
  }
  for (const a of UNSKILLED) {
    assert.match(html, new RegExp(`${AGENT_IDENTITY[a].label} sessions are unaffected`));
  }
});

test("the panel says the change is global before you click anything", () => {
  const html = render();
  // Every declaring harness's directory, read off its own `homeDir` - not `~/.claude`
  // spelled out here, which is how the panel comes to name one install while the
  // reconciler writes into two.
  for (const a of SKILLED) {
    assert.match(html, new RegExp(`~/${capabilitiesFor(a).skills!.homeDir.join("/")}`));
    assert.match(html, new RegExp(AGENT_IDENTITY[a].label));
  }
  assert.match(html, /every<\/strong>/);
});

test("the panel distinguishes idle-reloaded skills from watched skills", () => {
  const html = render();
  assert.match(html, /Running Claude Code or Pi sessions pick changes up at their next idle moment/);
  assert.match(html, /Changes are picked up automatically by Codex/);
  assert.doesNotMatch(html, /restart running sessions/);
});

test("the rows are disabled while the master switch is off", () => {
  // ForemanBar's fieldset cascade: a row you can still click while the master switch
  // is off is a row that lies about what it does.
  const off = render({ view: mkView({ enabled: false }) });
  assert.match(off, /<fieldset[^>]*disabled/);
  const on = render({ view: mkView({ enabled: true }) });
  assert.doesNotMatch(on, /<fieldset[^>]*disabled/);
});

test("an enabled row renders checked", () => {
  assert.match(render({ view: mkView({ skills: [mkRow({ enabled: true })] }) }), /checked/);
});

test("a rejected edit says so", () => {
  // The modal's first async error path - it had only ever written to localStorage.
  assert.match(render({ error: "That didn't stick: no." }), /That didn&#x27;t stick: no\./);
});

test("a catalog problem renders, rather than a row silently vanishing", () => {
  const html = render({ view: mkView({ problems: ["skills/broken/SKILL.md has no 'name'"] }) });
  assert.match(html, /skills\/broken\/SKILL\.md has no &#x27;name&#x27;/);
});

test("the pending count is a promise about WHEN, and names who it is about", () => {
  const html = render({ view: mkView({ pending: 3 }) });
  assert.match(html, new RegExp(`3 ${agentList(RELOADED)} sessions will pick this up when they next go idle`));
  // The count is `pendingReloads`, which counts only sessions something has to be TYPED
  // at. Naming a harness that loads skills by watching its own directory (Codex) would
  // attach a number that can never reach zero to a session already holding the skill -
  // the same failure as naming one that cannot load a skill at all, one door along.
  for (const a of AGENT_TYPES.filter((x) => !RELOADED.includes(x as never))) {
    assert.doesNotMatch(html, new RegExp(`${AGENT_IDENTITY[a].label} sessions will`));
  }
});

test("one pending session is not '1 sessions'", () => {
  assert.match(
    render({ view: mkView({ pending: 1 }) }),
    new RegExp(`1 ${agentList(RELOADED)} session will pick this up`),
  );
});

test("no pending sessions says nothing at all", () => {
  assert.doesNotMatch(render({ view: mkView({ pending: 0 }) }), /pick this up/);
});

test("an empty catalog says where skills come from rather than rendering blank", () => {
  const html = render({ view: mkView({ skills: [] }) });
  assert.match(html, /No skills in the catalog yet/);
});

test("the panel renders before the first poll lands", () => {
  // It mounts inside the settings modal, so the first paint happens with view: null.
  const html = render({ view: null });
  assert.match(html, /Skills/);
  assert.doesNotMatch(html, /pick this up/);
});
