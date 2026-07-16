import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillsPanel } from "../src/web/components/SkillsPanel.tsx";
import type { SkillsState } from "../src/web/useSkills.ts";
import type { SkillRow, SkillsView } from "../src/shared/types.ts";

// The skills panel, rendered. Static markup rather than a driven browser: this
// dashboard's pages don't take script injection from the automation extension, and
// these are questions about words and structure.
//
// What's at stake is that the panel never over-promises. Enabling a skill loads it;
// it does not oblige Claude to use it, and it does nothing whatsoever to a codex
// session. A row that says only "on" is claiming both.

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

test("a row shows the skill's user-facing name, not its fleet- directory", () => {
  const html = render();
  assert.match(html, /\/html-plans/);
  assert.doesNotMatch(html, /fleet-html-plans/);
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

test("every row says claude-only", () => {
  // Codex has no /reload-skills and no ~/.claude/skills, so the loop skips it
  // entirely. A toggle that silently no-ops on half the grid is the failure that
  // disqualified launch flags.
  assert.match(render(), /claude only/i);
});

test("the panel says the change is global before you click anything", () => {
  const html = render();
  assert.match(html, /~\/\.claude\/skills/);
  assert.match(html, /every<\/strong> Claude session/);
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

test("the pending count is a promise about WHEN, and names claude", () => {
  const html = render({ view: mkView({ pending: 3 }) });
  assert.match(html, /3 Claude sessions will pick this up when they next go idle/);
});

test("one pending session is not '1 sessions'", () => {
  assert.match(render({ view: mkView({ pending: 1 }) }), /1 Claude session will pick this up/);
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
