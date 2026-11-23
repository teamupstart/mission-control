import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportsSettingsPanel } from "../src/web/components/ReportsSettingsPanel.tsx";
import { DEFAULT_REPORT_GUIDANCE, REPORT_GUIDANCE_LIMIT, REPORT_GUIDANCE_RULES } from "../src/shared/reports.ts";

// Settings > Reports once the daemon has answered: the guidance box holds the guidance in force,
// says whether it is the default, shows the fixed half it is always followed by, and offers Save
// and Reset to default. A save is driven end to end by `e2e/specs/reports-noise-controls.spec.ts`.

const view = (guidance: string | null) => ({
  guidance,
  effective: guidance ?? DEFAULT_REPORT_GUIDANCE,
  defaultGuidance: DEFAULT_REPORT_GUIDANCE,
  limit: REPORT_GUIDANCE_LIMIT,
});

const draw = (guidance: string | null) =>
  renderToStaticMarkup(createElement(ReportsSettingsPanel, { mutes: [], initialGuidance: view(guidance), now: 10 }));

test("with no guidance saved the box holds the default, and Reset to default has nothing to do", () => {
  const html = draw(null);
  assert.match(html, /<textarea[^>]*aria-label="Report guidance"[^>]*>/);
  assert.ok(html.includes(DEFAULT_REPORT_GUIDANCE));
  assert.match(html, /<span class="si-format">default<\/span>/);
  assert.match(html, new RegExp(`${DEFAULT_REPORT_GUIDANCE.length} / ${REPORT_GUIDANCE_LIMIT.toLocaleString()}`));
  assert.ok(html.includes(REPORT_GUIDANCE_RULES.replaceAll("'", "&#x27;")), "the fixed half is shown, not editable");
  assert.match(html, /<button type="button" class="btn" disabled=""[^>]*>Save<\/button>/, "nothing to save yet");
  assert.match(html, /<button type="button" class="btn btn-ghost" disabled=""[^>]*>Reset to default<\/button>/);
});

test("with the operator's guidance saved the box holds it, and Reset to default is offered", () => {
  const html = draw("Only post when a pull request is ready.");
  assert.ok(html.includes("Only post when a pull request is ready."));
  assert.match(html, /<span class="si-format">your own<\/span>/);
  assert.match(html, /<button type="button" class="btn btn-ghost" aria-describedby="[^"]+">Reset to default<\/button>/);
});

// The guidance contract: every field is required. The daemon's answers satisfy it, and the
// dashboard's API turns an answer missing a field into a failure rather than filling it in.

test("an accepted save whose answer is not a whole guidance view is a failure, never an empty editor", async (t) => {
  const { api } = await import("../src/web/lib/api.ts");
  const { ReportGuidanceViewSchema } = await import("../src/shared/protocol.ts");
  const whole = view("Only post when a pull request is ready.");
  assert.deepEqual(ReportGuidanceViewSchema.parse(whole), whole);
  const answers: unknown[] = [];
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = (async () => new Response(JSON.stringify(answers.shift()), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

  answers.push(whole);
  assert.deepEqual(await api.saveReportGuidance(whole.guidance), { ok: true, view: whole });
  // The old fallback would have drawn an editor with an empty default and a 0-character limit.
  answers.push({ guidance: null, effective: DEFAULT_REPORT_GUIDANCE });
  const partial = await api.saveReportGuidance(null);
  assert.equal(partial.ok, false);
  assert.match(partial.ok ? "" : partial.error, /did not answer with it/);
  answers.push({ guidance: null, effective: DEFAULT_REPORT_GUIDANCE, defaultGuidance: DEFAULT_REPORT_GUIDANCE });
  assert.deepEqual(await api.reportGuidance(), { ok: false, definite: true }, "a read missing the limit is a failed read");
  answers.push(whole);
  assert.deepEqual(await api.reportGuidance(), { ok: true, value: whole });
});
