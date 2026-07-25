/**
 * What is at stake: the two workflow actions that cannot be taken back.
 *
 * `Restart full workflow` abandons an audited Inspector repair; `Discard and send new round`
 * prepares a packet the session may already be holding. The daemon demands an exact typed
 * phrase for both, and this dialog is where that phrase is produced - the server's refusal
 * is the last line, not the first, because by the time it fires the operator has decided.
 *
 * So the gate has to enforce what it SAYS. It compared a trimmed value against the phrase
 * and then sent the canonical string, which meant ` RESTART FULL WORKFLOW ` enabled a
 * control labelled as requiring the exact phrase and the daemon never saw the difference.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  WorkflowConfirmModal,
  confirmPhraseSatisfied,
  type WorkflowConfirmRequest,
} from "../src/web/workflows/WorkflowConfirmModal.tsx";
import { withOverlayHost } from "./helpers/overlay-host.ts";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PHRASE = "RESTART FULL WORKFLOW";

test("a phrase gate accepts the literal phrase and nothing that merely resembles it", () => {
  const gated = { requirePhrase: PHRASE };
  assert.equal(confirmPhraseSatisfied(gated, PHRASE), true);
  assert.equal(confirmPhraseSatisfied(gated, ` ${PHRASE} `), false);
  assert.equal(confirmPhraseSatisfied(gated, `${PHRASE}\n`), false);
  assert.equal(confirmPhraseSatisfied(gated, PHRASE.toLowerCase()), false);
  assert.equal(confirmPhraseSatisfied(gated, ""), false);
  // A request with no phrase is satisfied by anything, including nothing typed: an ordinary
  // confirm must not become unclickable because this helper exists.
  assert.equal(confirmPhraseSatisfied({}, ""), true);
  assert.equal(confirmPhraseSatisfied({ requirePhrase: undefined }, "anything"), true);
});

const render = (request: Partial<WorkflowConfirmRequest>): string => renderToStaticMarkup(
  withOverlayHost(createElement(WorkflowConfirmModal, {
    request: {
      title: "Restart the full workflow",
      body: "This abandons the Inspector-only repair.",
      confirmLabel: "Restart full workflow",
      confirmHint: "Abandons the Inspector-only repair and reruns every Persona",
      danger: true,
      onConfirm: () => {},
      ...request,
    },
    onClose: () => {},
  })),
);

test("a gated confirm names its phrase and opens refusing", () => {
  const html = render({ requirePhrase: PHRASE });
  assert.match(html, new RegExp(PHRASE));
  assert.match(html, /to confirm/);
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled/);
  // The hint says what to do about it rather than repeating the button.
  assert.match(html, new RegExp(`Type ${PHRASE} above to enable this`));
});

test("an ordinary confirm has no phrase field and is ready to click", () => {
  const html = render({});
  assert.doesNotMatch(html, /workflow-confirm-phrase/);
  assert.doesNotMatch(html, /<button[^>]*type="submit"[^>]*disabled/);
  assert.match(html, /Abandons the Inspector-only repair/);
});

// The gate the migration's final phase leaves behind, kept as a test rather than a one-off
// grep. `window.confirm` and `window.prompt` are native dialogs the overlay registry never
// sees, so while one is up `anyOpen` is false and the fleet's global key handler is still
// live behind it - `k` reaches the card underneath. Every workflow surface asks through the
// modal above instead, and this fails the moment one reaches for the browser again.
//
// It matches CALLS, not the word: the comments explaining why these went are the record of
// the decision and must stay readable.
test("no workflow surface raises a native dialog", () => {
  const dir = fileURLToPath(new URL("../src/web/workflows/", import.meta.url));
  const offenders: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
    const source = readFileSync(join(dir, name), "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      if (/(?:^|[^\w.])window\.(confirm|prompt)\s*\(/.test(line)) {
        offenders.push(`${name}:${index + 1}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `native dialog raised at ${offenders.join(", ")}`);
});
