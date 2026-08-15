/* eslint-disable no-console */
// Builds the review worklist's visual record: one self-contained HTML page carrying the real
// browser captures, inline, beside the text the browser rendered at the moment of each.
//
//   MC_E2E_EVIDENCE=1 npm run test:e2e -- workflow-run-blocker-worklist
//   node scripts/workflow-worklist-evidence.mjs
//
// The captures are produced by the spec, from a real dispatch, a real published workflow and
// two real review rounds - never mocked up here. This script only assembles them, so the page
// cannot drift from what the browser actually drew: if a capture is missing it refuses rather
// than emitting a page with a hole in it.
//
// SELF-CONTAINED AND EMBEDDED, rather than a page that links four PNGs, because the point of
// the artifact is that it renders wherever it is opened - in a review, in the Files tab, from a
// checkout with no server running - and a relative <img src> stops being visual evidence the
// moment the file is read anywhere but its own directory.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const captures = join(repo, "e2e", ".artifacts", "workflow-run-blocker-worklist");
const out = join(repo, "docs", "reports", "workflow-runs-blocker-worklist", "worklist-views.html");

/**
 * The views this record has to carry, and what each one is proof of.
 *
 * Deliberately three of the four the spec captures. The stalemate card appears in the Archive
 * view as well, so the round-2 Blocking capture would restate it, and every embedded image is
 * permanent weight in the repository.
 */
const VIEWS = [
  {
    file: "01-blocking-leads-with-the-change.png",
    title: "Blocking, with the selected change in full",
    blurb:
      "The agenda. Two reviewers objected in the same words about the same file, so there are two"
      + " rows - the change key leads with the reviewer that raised it, and each row's actions"
      + " target that reviewer. The selected one is shown whole: its summary, confidence, runner"
      + " and model, the file it cites, the round it was first raised in, the rounds it has been"
      + " open, its rationale and the evidence behind it.",
  },
  {
    file: "02-passes-behind-the-count.png",
    title: "Passed, where an approval costs a count",
    blurb:
      "The same run, one click away. This is the 1,984 characters of header, summary, approval"
      + " rationale and evidence list the redesign was measured against - now one line, with the"
      + " whole verdict still reachable for the reader who asks for it.",
  },
  {
    file: "04-archive-tells-the-two-apart.png",
    title: "Archive, telling resolved from unconfirmed, beside the stalemate card",
    blurb:
      "The three-elements-agreeing case the design is built around. A green Resolved row naming"
      + " the round its own reviewer confirmed in; an amber Unconfirmed row claiming neither"
      + " outcome, because that reviewer ran again and did not pass; and the stalemate card"
      + " naming that same reviewer. Green on the second row would tell an operator a reviewer is"
      + " satisfied on the same rail as a card calling it a repeat offender.",
  },
];

const escape = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function embed(file) {
  try {
    return readFileSync(join(captures, file)).toString("base64");
  } catch {
    throw new Error(
      `Missing capture ${file}.\n`
      + "Produce the captures first, from a real run:\n"
      + "  MC_E2E_EVIDENCE=1 npm run test:e2e -- workflow-run-blocker-worklist",
    );
  }
}

const sections = VIEWS.map((view, index) => `
  <section>
    <h2>${index + 1}. ${escape(view.title)}</h2>
    <p>${escape(view.blurb)}</p>
    <img alt="${escape(view.title)}" src="data:image/png;base64,${embed(view.file)}">
    <p class="src">Captured as <code>${escape(view.file)}</code>.</p>
  </section>`).join("\n");

const page = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>The review worklist, as a browser drew it</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0 auto; padding: 32px 24px 64px; max-width: 980px;
    background: #0a0c0f; color: #e7ebf1;
    font: 15px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  h1 { font-size: 24px; margin: 0 0 6px; }
  h2 { font-size: 16px; margin: 40px 0 8px; }
  p { color: #939eae; max-width: 78ch; }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12.5px; color: #7c8798; }
  img {
    display: block; width: 100%; height: auto; margin: 14px 0 6px;
    border: 1px solid #232a33; border-radius: 10px; background: #14181e;
  }
  .lede { color: #e7ebf1; }
  .src { font-size: 12.5px; color: #7c8798; }
  .how { border-left: 3px solid #232a33; padding: 2px 0 2px 14px; margin: 22px 0; }
</style>
<h1>The review worklist, as a browser drew it</h1>
<p class="lede">
  Visual record of the Workflow runs reader pane after the Blocker Worklist replaced the
  Reviewer verdicts wall. Every image below is a browser capture of a real Workflow run, not a
  mock-up.
</p>
<div class="how">
  <p>
    Produced by <code>e2e/specs/workflow-run-blocker-worklist.spec.ts</code>: a real dispatch, a
    real published workflow, two real review rounds, driven through the dashboard by Playwright.
    The reviewers are scripted by <code>e2e/fixtures/fake-claude.mjs</code>, so no model tokens
    are spent. Assembled by <code>scripts/workflow-worklist-evidence.mjs</code>.
  </p>
  <p class="src">
    MC_E2E_EVIDENCE=1 npm run test:e2e -- workflow-run-blocker-worklist<br>
    node scripts/workflow-worklist-evidence.mjs
  </p>
</div>
${sections}
</html>
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page);
console.log(`WROTE ${out.slice(repo.length + 1)} (${Math.round(page.length / 1024)}KB)`);
