import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskSettingsPanel } from "../src/web/components/TaskSettingsPanel.tsx";
import type { SkillsState } from "../src/web/useSkills.ts";
import type { SkillsView } from "../src/shared/types.ts";

function skills(view: Partial<SkillsView> | null): SkillsState {
  return {
    view: view && {
      alwaysDraftPr: false,
      commitPlanHtml: false,
      planStorage: "repository",
      grillFirstKinds: [],
      enabled: true,
      skills: [{ id: "grill", name: "grill", description: "", category: "planning", enforcement: "triggered", enabled: true }],
      pending: 0,
      problems: [],
      ...view,
    },
    update: async () => {},
    error: null,
  };
}

function render(state: SkillsState): string {
  return renderToStaticMarkup(createElement(TaskSettingsPanel, { skills: state }));
}

/** One kind's section, as drawn: its card from the opening tag to the next card. */
function section(html: string, kind: string): string {
  const start = html.indexOf(`data-anchor="tasks/kind-${kind}"`);
  if (start === -1) return "";
  const next = html.indexOf('<section class="sc-card"', start);
  return html.slice(start, next === -1 ? undefined : next);
}

/** The checkbox for one kind's default, as drawn. */
function kindBox(html: string, kind: string): string {
  return html.match(new RegExp(`<input type="checkbox"[^>]*aria-label="Grill me first for ${kind} tasks"[^>]*/>`))?.[0] ?? "";
}

test("each kind's section holds its Grill me first default, off, with an info tip", () => {
  const html = render(skills({}));
  assert.match(html, /data-anchor="tasks\/kinds"/);
  for (const kind of ["ship", "bugfix", "document", "plan", "scout", "chat"]) {
    const card = section(html, kind);
    assert.ok(card, `a section for ${kind}`);
    assert.match(card, new RegExp(`<h3 class="sc-card-title">${kind}</h3>`));
    const box = kindBox(card, kind);
    assert.ok(box, `${kind}'s box is in ${kind}'s own section`);
    assert.doesNotMatch(box, /checked/, `${kind} starts off`);
    assert.match(card, /<button type="button" class="info-tip" aria-label="About Grill me first"[^>]*>i<\/button>/);
  }
  assert.equal(section(html, "pipeline"), "", "Conductor owns a pipeline's launch");
  assert.match(html, /runs the Library&#x27;s Grill action/);

  const chosen = render(skills({ grillFirstKinds: ["plan", "bugfix"] }));
  assert.match(kindBox(chosen, "plan"), /checked=""/);
  assert.match(kindBox(chosen, "bugfix"), /checked=""/);
  assert.doesNotMatch(kindBox(chosen, "ship"), /checked/);
  assert.doesNotMatch(chosen, /The grill skill is off/);
});

test("a Grill me first default whose skill is off says the dispatch would be refused", () => {
  const grillOff = skills({
    grillFirstKinds: ["ship"],
    skills: [{ id: "grill", name: "grill", description: "", category: "planning", enforcement: "triggered", enabled: false }],
  });
  assert.match(render(grillOff), /The grill skill is off/);
  assert.match(render(skills({ grillFirstKinds: ["ship"], enabled: false })), /The grill skill is off/);
  // No kind on, nothing is refused, so nothing is said.
  assert.doesNotMatch(render({ ...grillOff, view: { ...grillOff.view!, grillFirstKinds: [] } }), /The grill skill is off/);
});

test("before the Skills config answers, the Grill me first boxes are drawn disabled", () => {
  const html = render(skills(null));
  assert.match(html, /Can&#x27;t reach the daemon/);
  assert.match(kindBox(html, "plan"), /disabled=""/);
});
