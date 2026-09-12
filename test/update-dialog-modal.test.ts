import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { UPDATE_COPY } from "../src/shared/update-copy.ts";
import { UPDATE_DIALOGS, type UpdateDialogRequest } from "../src/shared/update-dialog.ts";
import { UpdateDialog } from "../src/web/components/UpdateDialog.tsx";
import { queueUpdateDialog } from "../src/web/useUpdateDialog.ts";
import { withOverlayHost } from "./helpers/overlay-host.ts";

const render = (request: UpdateDialogRequest | null): string =>
  renderToStaticMarkup(
    withOverlayHost(createElement(UpdateDialog, { request, onAnswer: () => {} })),
  );

test("the update modal renders through the themed shell, not a platform sheet", () => {
  const html = render({ ...UPDATE_DIALOGS.ready("1.9.1"), id: "d1" });

  assert.match(
    html,
    /(?=.*modal-backdrop)(?=.*class="modal update-dialog update-dialog-success")(?=.*modal-head)(?=.*modal-foot)/s,
    html,
  );
  // The words are the shared owner's, and both answers are reachable as buttons.
  assert.match(html, new RegExp(UPDATE_COPY.ready.title("1\\.9\\.1")));
  assert.ok(html.includes(UPDATE_COPY.ready.detail));
  assert.match(html, /<button[^>]*class="btn btn-primary"[^>]*>Restart and Install<\/button>/);
  assert.match(html, /<button[^>]*class="btn btn-ghost"[^>]*>Later<\/button>/);
});

test("the modal names itself for assistive tech and offers a close", () => {
  const html = render({ ...UPDATE_DIALOGS.error("gh is not authenticated"), id: "d2" });

  assert.match(
    html,
    /(?=.*role="dialog")(?=.*aria-label="Mission Control update")(?=.*aria-modal="true")(?=.*aria-label="Close")/s,
    html,
  );
  assert.match(html, /update-dialog update-dialog-error/);
  assert.ok(html.includes("gh is not authenticated"));
});

test("a dialog with nothing under its headline renders no empty paragraph", () => {
  // `upToDate` is the one whose title is the whole of it. An always-rendered `<p>` would
  // leave a gap under the headline that reads as a sentence that failed to load.
  const html = render({ ...UPDATE_DIALOGS.upToDate("1.9.1"), id: "d3" });

  assert.ok(!html.includes("update-dialog-detail"), html);
  assert.match(html, /<button[^>]*class="btn btn-primary"[^>]*>OK<\/button>/);
  assert.equal((html.match(/class="btn /g) ?? []).length, 1);
});

test("nothing is drawn when the updater is not asking", () => {
  assert.equal(render(null), "");
});

test("a re-offered question replaces its entry rather than stacking a duplicate", () => {
  // Main re-sends everything unanswered when the dashboard announces itself, so a reload
  // delivers the same ids again. Appending them would leave a modal the operator has to
  // dismiss twice, with the second one asking a question already answered.
  const first: UpdateDialogRequest = { ...UPDATE_DIALOGS.ready("1.9.1"), id: "d1" };
  const second: UpdateDialogRequest = { ...UPDATE_DIALOGS.upToDate("1.9.1"), id: "d2" };

  const queued = queueUpdateDialog(queueUpdateDialog([first], second), first);
  assert.deepEqual(queued.map((entry) => entry.id), ["d1", "d2"]);
  // Oldest first: the question that has been waiting is the one on screen.
  assert.equal(queued[0]!.kind, "ready");
});

test("two outstanding questions are drawn one at a time, oldest first", () => {
  // The shell can legitimately have two open - the outcome notice at launch, and a manual
  // check started while it is up - so the dashboard holds a queue rather than one slot. Only
  // the head is drawn: two modals stacked on one backdrop would leave the operator answering
  // the newer question while the older one waits invisibly behind it.
  const outcome: UpdateDialogRequest = {
    ...UPDATE_DIALOGS.outcome({
      result: "success",
      targetVersion: "1.9.1",
      recordedAt: "2026-09-11T00:00:00Z",
    }),
    id: "outcome-1",
  };
  const offer: UpdateDialogRequest = {
    ...UPDATE_DIALOGS.available({
      currentVersion: "1.9.1",
      newVersion: "1.9.2",
      name: "1.9.2",
      notes: "",
    }),
    id: "offer-1",
  };

  const queue = queueUpdateDialog([outcome], offer);
  assert.deepEqual(queue.map((entry) => entry.id), ["outcome-1", "offer-1"]);

  const head = render(queue[0] ?? null);
  assert.ok(head.includes("Mission Control was updated to 1.9.1"), head);
  assert.ok(!head.includes("1.9.2 is available"), head);
  // One backdrop, one dialog: the second question is queued, not stacked.
  assert.equal((head.match(/modal-backdrop/g) ?? []).length, 1);

  // Answering the head by its own id leaves the other exactly where it was, and it is then
  // the one drawn.
  const remaining = queue.filter((entry) => entry.id !== "outcome-1");
  assert.deepEqual(remaining.map((entry) => entry.id), ["offer-1"]);
  assert.ok(render(remaining[0] ?? null).includes("Mission Control 1.9.2 is available"));
});
