import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FixContext, NomistakesFixLog } from "../src/web/components/NomistakesFixLog.tsx";
import type { NmFixAttribution, NmFixDetail, NmFixSummary } from "@shared/types.ts";

// What the fix log's byline actually SAYS, rendered.
//
// These are about wording and restraint, not layout. The foreman is an autonomous
// actor that can change your branch while you're away, so the lane naming it is a
// claim - and the one failure mode that matters is overclaiming: the foreman never
// calls `axi respond`, it types into a pane and the AGENT decides what to answer,
// and is free to ignore the nudge. So the card may say the foreman spoke about a
// gate; it may never say the foreman wrote the reply.
//
// Rendered rather than driven through a browser: the dashboard's SSE stream holds
// the connection open, which hangs headless automation. Static markup is enough
// for a question about words.

function detail(over: Partial<NmFixDetail> = {}): NmFixDetail {
  return {
    sha: "abc1234",
    step: "review",
    summary: "fix the guard",
    committedAt: Date.now(),
    decision: "replied",
    reply: "Apply all four.",
    attribution: null,
    findings: [],
    findingCount: 0,
    files: [{ path: "src/a.ts", added: 3, removed: 1 }],
    filesChanged: 1,
    added: 3,
    removed: 1,
    ...over,
  };
}

function attribution(over: Partial<NmFixAttribution> = {}): NmFixAttribution {
  return { source: "foreman", text: "This looks safe - apply them.", at: 1, ...over };
}

function render(d: NmFixDetail): string {
  return renderToStaticMarkup(createElement(FixContext, { detail: d, onOpenDiff: () => {} }));
}

test("a foreman-attributed fix shows the nudge as its own block, not as the reply", () => {
  const html = render(detail({ attribution: attribution() }));
  // Both sentences are present, by both authors...
  assert.match(html, /Apply all four\./, "the reply the agent actually sent");
  assert.match(html, /This looks safe - apply them\./, "the foreman's own words");
  // ...and the foreman's is labelled as being ABOUT the gate, never as the answer to it.
  assert.match(html, /the foreman said this about this gate/);
  assert.match(html, /nm-reply-foreman/);
});

/**
 * The wording is the whole feature. "by the foreman" would assert the foreman
 * wrote the reply above, which it did not and cannot - it nudged, and the agent
 * chose what to say, possibly ignoring it entirely.
 */
test("the foreman byline claims a nudge, never authorship of the reply", () => {
  const html = render(detail({ attribution: attribution() }));
  assert.match(html, /after a nudge from the foreman/);
  assert.doesNotMatch(html, /by the foreman/);
});

test("a you-attributed fix names you and does not repeat itself", () => {
  const html = render(detail({ attribution: attribution({ source: "you", text: "Apply all four." }) }));
  assert.match(html, /by you, in the dashboard/);
  assert.doesNotMatch(html, /the foreman said/);
  // The "you" lane's text IS the reply already quoted, so it must not be echoed
  // a second time under a second label.
  assert.equal(html.match(/Apply all four\./g)?.length, 1);
});

/**
 * The common case: the agent drove its own gate via the `/no-mistakes` skill, which
 * no-mistakes records identically to a human reply and which nothing witnessed. The
 * card must read exactly as it did before bylines existed.
 */
test("an unattributed reply names nobody rather than guessing", () => {
  const html = render(detail({ attribution: null }));
  assert.match(html, /replied/);
  assert.match(html, /Apply all four\./);
  assert.doesNotMatch(html, /foreman/);
  assert.doesNotMatch(html, /by you/);
});

test("an auto-fixed fix stays in the auto lane with no byline", () => {
  const html = render(detail({ decision: "auto", reply: null, attribution: null }));
  assert.match(html, /auto-fixed/);
  assert.match(html, /nobody was asked/);
  assert.doesNotMatch(html, /foreman/);
});

/**
 * A foreman that nudged and typed nothing quotable still colours the lane, but
 * there is no block to show - an empty quote box under "the foreman said this"
 * would be worse than none.
 */
test("a foreman byline with no text shows no empty quote block", () => {
  const html = render(detail({ attribution: attribution({ text: null }) }));
  assert.match(html, /after a nudge from the foreman/);
  assert.doesNotMatch(html, /the foreman said this about this gate/);
});

// ---- the collapsed row ----

function summary(over: Partial<NmFixSummary> = {}): NmFixSummary {
  return {
    sha: "abc1234",
    step: "review",
    summary: "fix the guard",
    committedAt: Date.now(),
    filesChanged: 1,
    added: 3,
    removed: 1,
    decision: "replied",
    repliedBy: null,
    findingCount: 0,
    ...over,
  };
}

function renderLog(fixes: NmFixSummary[]): string {
  return renderToStaticMarkup(
    createElement(NomistakesFixLog, { sessionId: "s1", fixes, onOpenDiff: () => {} }),
  );
}

test("the collapsed rollup carries no byline at all", () => {
  // Closed, the log is one rollup row. Whatever it says about bylines, it must not
  // say it before you've opened it.
  assert.doesNotMatch(renderLog([summary({ repliedBy: "foreman" })]), /foreman/);
});
