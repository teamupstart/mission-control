import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AdvisorNote, advisorNoteLabel } from "../src/web/components/AdvisorNote.tsx";
import { RuntimeMetaRow } from "../src/web/components/session-bits.tsx";
import { meta } from "./helpers/session-fixture.ts";

// The two advisor surfaces as markup: the conversation's note for one advisor call, and the
// read-only chip on the runtime row. `e2e/specs/advisor-visibility.spec.ts` drives both in a
// browser; these pin the exact wording and the elements a reader navigates by.

test("each advisor outcome reads as Claude Code words it", () => {
  assert.equal(
    advisorNoteLabel({ model: "claude-opus-5-5", outcome: "advised", text: "x" }),
    "Advisor (Opus 5.5) reviewed the conversation",
  );
  assert.equal(
    advisorNoteLabel({ model: "claude-opus-5-5", outcome: "redacted" }),
    "Advisor (Opus 5.5) reviewed the conversation",
  );
  assert.equal(advisorNoteLabel({ model: null, outcome: "redacted" }), "Advisor reviewed the conversation");
  assert.equal(
    advisorNoteLabel({ model: "claude-opus-5-5", outcome: "declined" }),
    "Advisor declined to advise on this request",
  );
  assert.equal(
    advisorNoteLabel({ model: "claude-opus-5-5", outcome: "error", errorCode: "overloaded" }),
    "Advisor unavailable (overloaded)",
  );
  assert.equal(advisorNoteLabel({ model: null, outcome: "error" }), "Advisor unavailable (unknown)");
});

test("advice with words sits behind a closed disclosure; everything else is one line", () => {
  const advised = renderToStaticMarkup(
    createElement(AdvisorNote, { advisor: { model: "claude-opus-5-5", outcome: "advised", text: "Check the null case." } }),
  );
  assert.match(advised, /^<details class="advisor-note"><summary aria-describedby="[^"]+">Advisor \(Opus 5\.5\) reviewed the conversation<\/summary>/);
  assert.match(advised, /class="tt-desc">Show what the advisor told Claude</, "the disclosure says what opening it does");
  assert.doesNotMatch(advised, /<details[^>]* open/, "closed by default");
  assert.match(advised, /Check the null case\./);

  const redacted = renderToStaticMarkup(
    createElement(AdvisorNote, { advisor: { model: "claude-opus-5-5", outcome: "redacted" } }),
  );
  assert.equal(redacted, '<p class="advisor-note">Advisor (Opus 5.5) reviewed the conversation</p>');

  const error = renderToStaticMarkup(
    createElement(AdvisorNote, { advisor: { model: null, outcome: "error", errorCode: "too_many_requests" } }),
  );
  assert.equal(error, '<p class="advisor-note advisor-note-error">Advisor unavailable (too_many_requests)</p>');
});

test("the runtime row draws a named, read-only advisor chip only when meta has one", () => {
  const withAdvisor = renderToStaticMarkup(
    createElement(RuntimeMetaRow, { meta: meta({ advisorModel: "claude-opus-5-5" }) }),
  );
  assert.match(
    withAdvisor,
    /<span class="rt-pill rt-advisor" role="group" aria-label="Advisor model"[^>]*>Advisor: Opus 5\.5<\/span>/,
  );
  assert.doesNotMatch(withAdvisor, /<button[^>]*rt-advisor/, "a readout, not a picker");

  const without = renderToStaticMarkup(createElement(RuntimeMetaRow, { meta: meta() }));
  assert.doesNotMatch(without, /rt-advisor/);

  // The advisor alone still draws the row, rather than being lost to the early return.
  const only = renderToStaticMarkup(
    createElement(RuntimeMetaRow, {
      meta: meta({ model: null, thinkingLevel: null, contextPct: null, advisorModel: "claude-sonnet-5-5" }),
    }),
  );
  assert.match(only, /Advisor: Sonnet 5\.5/);
});
