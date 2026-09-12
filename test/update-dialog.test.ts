import assert from "node:assert/strict";
import test from "node:test";

import { UPDATE_COPY } from "../src/shared/update-copy.ts";
import {
  isUpdateDialogRequest,
  UPDATE_DIALOGS,
  updateDialogDismissal,
  type UpdateDialogRequest,
} from "../src/shared/update-dialog.ts";
import { UpdateDialogPresenter, type UpdateDialogPort } from "../src/main/update-dialog.ts";

/**
 * The updater's questions moved from the platform's message box into the dashboard's own
 * modal, and this file pins both halves of that: one owner for what every conversation says
 * and offers, and a presenter that routes each one to the dashboard without leaving a second,
 * unthemed surface behind - or an update wedged on an answer that can never arrive.
 */

test("the two-answer dialogs offer confirm first and dismiss last", () => {
  const offer = UPDATE_DIALOGS.available({
    currentVersion: "1.9.0",
    newVersion: "1.9.1",
    name: "1.9.1",
    notes: "Fixes the thing.",
  });

  assert.deepEqual(
    offer.actions.map((action) => [action.choice, action.label, action.tone]),
    [
      ["confirm", "Update Now", "primary"],
      ["dismiss", "Later", "ghost"],
    ],
  );
  // Escape and the backdrop answer with the LAST action, so a two-answer dialog must never
  // end on the one that starts an install.
  assert.equal(updateDialogDismissal(offer).choice, "dismiss");
  assert.equal(updateDialogDismissal(UPDATE_DIALOGS.ready("1.9.1")).choice, "dismiss");
  assert.equal(updateDialogDismissal(UPDATE_DIALOGS.upToDate("1.9.1")).choice, "dismiss");
});

test("the three build phases take their words from the shared copy", () => {
  assert.deepEqual(
    [
      UPDATE_DIALOGS.preparing("1.9.1", "Building the new version"),
      UPDATE_DIALOGS.ready("1.9.1"),
      UPDATE_DIALOGS.applying("1.9.1"),
    ].map((content) => [content.title, content.detail]),
    [
      [
        UPDATE_COPY.preparing.title("1.9.1"),
        `Building the new version. ${UPDATE_COPY.preparing.detail}`,
      ],
      [UPDATE_COPY.ready.title("1.9.1"), UPDATE_COPY.ready.detail],
      [UPDATE_COPY.applying.title("1.9.1"), UPDATE_COPY.applying.detail],
    ],
  );
});

test("a finished update reports its result, and only a failure carries a reason", () => {
  const failed = UPDATE_DIALOGS.outcome({
    result: "failure",
    targetVersion: "1.9.1",
    recordedAt: "2026-09-11T00:00:00Z",
    message: "The bundle was replaced while it was being verified.",
  });
  const succeeded = UPDATE_DIALOGS.outcome({
    result: "success",
    targetVersion: "1.9.1",
    recordedAt: "2026-09-11T00:00:00Z",
  });

  assert.deepEqual(
    [
      [failed.tone, failed.title, failed.detail],
      [succeeded.tone, succeeded.title, succeeded.detail],
    ],
    [
      [
        "error",
        "Mission Control 1.9.1 could not be installed",
        "The bundle was replaced while it was being verified.",
      ],
      ["success", "Mission Control was updated to 1.9.1", null],
    ],
  );
});

test("a malformed push is not drawn as a modal", () => {
  const good: UpdateDialogRequest = { ...UPDATE_DIALOGS.upToDate("1.9.1"), id: "d1" };
  assert.equal(isUpdateDialogRequest(good), true);
  // A modal with no buttons cannot be answered and cannot be dismissed, which is the one
  // shape that would strand an operator behind a backdrop.
  assert.equal(isUpdateDialogRequest({ ...good, actions: [] }), false);
  assert.equal(isUpdateDialogRequest({ ...good, id: "" }), false);
  assert.equal(isUpdateDialogRequest({ ...good, kind: "some-future-phase" }), false);
  assert.equal(isUpdateDialogRequest({ ...good, tone: "warning" }), false);
  assert.equal(isUpdateDialogRequest(null), false);
});

interface Recorder {
  port: UpdateDialogPort;
  sent: UpdateDialogRequest[];
  /** How many times the window was revealed, which must stay at zero while it is up. */
  revealed: number;
  /** Whether a dashboard is already on screen, as the port reports it. */
  visible: boolean;
  /** Fire whatever the presenter is waiting on, as the host timeout would. */
  expire(): void;
}

function recorder(options: { deliverable?: boolean; visible?: boolean } = {}): Recorder {
  const sent: UpdateDialogRequest[] = [];
  const timers: (() => void)[] = [];
  let ids = 0;
  const state: Recorder = {
    sent,
    revealed: 0,
    visible: options.visible ?? false,
    expire: () => {
      const timer = timers.shift();
      timer?.();
    },
    port: {
      canPresent: () => state.visible,
      reveal: () => {
        state.revealed += 1;
        state.visible = true;
      },
      send: (request) => {
        if (options.deliverable === false) return false;
        sent.push(request);
        return true;
      },
      newId: () => `dialog-${(ids += 1)}`,
      delay: (_ms, fn) => {
        timers.push(fn);
        return () => {
          const at = timers.indexOf(fn);
          if (at >= 0) timers.splice(at, 1);
        };
      },
    },
  };
  return state;
}

test("a dashboard that is already up is never revealed for a question", async () => {
  // The pre-existing flow moved the window in exactly two places - before `preparing`, and
  // after an accepted `available` - and both still live in the handlers that own them. The
  // presenter must add none of its own, or every manual check would start pulling the
  // window forward at a moment the old one left it alone.
  const rec = recorder({ visible: true });
  const presenter = new UpdateDialogPresenter(rec.port);
  presenter.attach();

  const asked = presenter.present(UPDATE_DIALOGS.upToDate("1.9.1"));
  await Promise.resolve();

  assert.equal(rec.revealed, 0);
  assert.equal(rec.sent.length, 1);
  presenter.answer(rec.sent[0]!.id, "dismiss");
  assert.equal(await asked, "dismiss");
});

test("a question waits for the dashboard, then is answered by it", async () => {
  const rec = recorder();
  const presenter = new UpdateDialogPresenter(rec.port);
  const asked = presenter.present(UPDATE_DIALOGS.ready("1.9.1"));

  // Nothing was on screen, so the one thing that can carry a modal to a person happens:
  // the window is shown. This is what stands in for the parentless platform sheet.
  assert.equal(rec.revealed, 1);
  assert.equal(rec.sent.length, 0);

  presenter.attach();
  await Promise.resolve();
  assert.equal(rec.sent.length, 1);
  assert.equal(rec.sent[0]!.title, UPDATE_COPY.ready.title("1.9.1"));

  presenter.answer(rec.sent[0]!.id, "confirm");
  assert.equal(await asked, "confirm");
  assert.equal(presenter.outstanding, 0);
});

test("two questions can be open at once and are answered by id, in any order", async () => {
  // The outcome notice fires seconds after launch, and a manual check started from the menu
  // bar while it is still up is a second conversation rather than a replacement for the
  // first. Each `present()` holds its own promise, so answering the SECOND one first must
  // settle the second caller and leave the first still waiting - an implementation that
  // kept one slot, or matched answers by arrival order, passes every single-question test
  // above and silently hands one caller the other's choice here.
  const rec = recorder({ visible: true });
  const presenter = new UpdateDialogPresenter(rec.port);
  presenter.attach();

  const outcome = presenter.present(UPDATE_DIALOGS.outcome({
    result: "success",
    targetVersion: "1.9.1",
    recordedAt: "2026-09-11T00:00:00Z",
  }));
  const offer = presenter.present(UPDATE_DIALOGS.available({
    currentVersion: "1.9.1",
    newVersion: "1.9.2",
    name: "1.9.2",
    notes: "",
  }));
  await Promise.resolve();

  // Both are live, each with its own id, and neither replaced the other.
  assert.equal(presenter.outstanding, 2);
  assert.deepEqual(rec.sent.map((request) => request.kind), ["outcome", "available"]);
  const [outcomeId, offerId] = rec.sent.map((request) => request.id);
  assert.notEqual(outcomeId, offerId);

  // Answer the SECOND one first, with the choice only it offers.
  presenter.answer(offerId, "confirm");
  assert.equal(await offer, "confirm");
  assert.equal(presenter.outstanding, 1);

  // The first is untouched by that, and still gets its own answer.
  presenter.answer(outcomeId, "dismiss");
  assert.equal(await outcome, "dismiss");
  assert.equal(presenter.outstanding, 0);
});

test("an answer that names no live question is ignored rather than guessed at", async () => {
  const rec = recorder({ visible: true });
  const presenter = new UpdateDialogPresenter(rec.port);
  presenter.attach();
  const asked = presenter.present(UPDATE_DIALOGS.available({
    currentVersion: "1.9.0",
    newVersion: "1.9.1",
    name: "1.9.1",
    notes: "",
  }));
  await Promise.resolve();

  presenter.answer("a-stale-id", "confirm");
  presenter.answer(rec.sent[0]!.id, "maybe");
  presenter.answer(undefined, "confirm");
  assert.equal(presenter.outstanding, 1);

  presenter.answer(rec.sent[0]!.id, "dismiss");
  assert.equal(await asked, "dismiss");
});

test("no dashboard within the wait settles the question as its own dismissal", async () => {
  // There is no platform sheet left to fall back to - a second unthemed auto-update surface
  // is the thing being removed. So an unaskable question settles exactly as "Later" does,
  // which the updater already handles, and the release is offered again at the next check.
  const rec = recorder();
  const presenter = new UpdateDialogPresenter(rec.port);
  const asked = presenter.present(UPDATE_DIALOGS.ready("1.9.1"));

  rec.expire();
  assert.equal(await asked, "dismiss");
  assert.equal(rec.sent.length, 0);
  assert.equal(presenter.outstanding, 0);
});

test("a dashboard that cannot take the push is not waited on", async () => {
  const rec = recorder({ deliverable: false, visible: true });
  const presenter = new UpdateDialogPresenter(rec.port);
  presenter.attach();

  assert.equal(await presenter.present(UPDATE_DIALOGS.error("gh is not authenticated")), "dismiss");
  assert.equal(presenter.outstanding, 0);
});

test("a reload re-offers the question instead of losing it", async () => {
  const rec = recorder({ visible: true });
  const presenter = new UpdateDialogPresenter(rec.port);
  presenter.attach();
  const asked = presenter.present(UPDATE_DIALOGS.ready("1.9.1"));
  await Promise.resolve();
  const id = rec.sent[0]!.id;

  // The renderer reloads: whatever was on screen is gone, and main is the only side that
  // still knows a question is outstanding.
  presenter.attach();
  assert.deepEqual(rec.sent.map((request) => request.id), [id, id]);

  presenter.answer(id, "confirm");
  assert.equal(await asked, "confirm");
});

test("a renderer that goes away settles every question it was holding", async () => {
  // Without this the updater's command promise waits forever on an answer that can never
  // arrive, and the update is wedged for the life of the process with nothing on screen.
  // Both open questions settle, not just the first.
  const rec = recorder({ visible: true });
  const presenter = new UpdateDialogPresenter(rec.port);
  presenter.attach();
  const ready = presenter.present(UPDATE_DIALOGS.ready("1.9.1"));
  const notice = presenter.present(UPDATE_DIALOGS.applying("1.9.1"));
  await Promise.resolve();
  assert.equal(presenter.outstanding, 2);

  presenter.detach();
  assert.equal(presenter.outstanding, 0);
  assert.deepEqual([await ready, await notice], ["dismiss", "dismiss"]);
});
