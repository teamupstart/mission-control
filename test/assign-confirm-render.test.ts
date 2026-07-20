import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssignResetModal } from "../src/web/components/AssignResetModal.tsx";
import { withOverlayHost } from "./helpers/overlay-host.ts";
import { mkSession } from "./helpers/session-fixture.ts";
import type { AssignResetConfirm } from "../src/shared/types.ts";

// The dialog standing between a dragged backlog card and an agent that is holding
// something the handover would take.
//
// What is at stake is a destruction nobody agreed to. Dropping a card onto an idle agent
// resets its checkout, and the reset drops its work queue, wipes its context and releases
// its branch - none of it recoverable from origin, none of it previously announced, while
// the identical operation behind the card's own reset control has a confirm dialog and a
// loss preview. So the dialog has to NAME what it is about to spend, and it has to name
// what the daemon actually saw rather than a generic warning: an operator who reads
// "queued work" and loses a branch has been told the wrong thing.
//
// createElement, not JSX, because the runner's glob only matches .test.ts.

const render = (confirm: AssignResetConfirm, taskTitle: string | null = "Wire it up"): string =>
  renderToStaticMarkup(
    withOverlayHost(
      createElement(AssignResetModal, {
        session: mkSession({ name: "atlas" }),
        taskId: "t1",
        taskTitle,
        confirm,
        onClose: () => {},
      }),
    ),
  );

test("the confirm lists exactly what the refusal said would be lost", () => {
  const html = render({ queuedItems: 2, clearsContext: true, branch: "feature/held" });
  assert.match(html, /2<\/strong> queued work items/);
  assert.match(html, /feature\/held/);
  assert.match(html, /\/clear/);
  // The task and the agent are both named: this is a decision about a specific pairing,
  // and a dialog that says neither is one you have to guess at.
  assert.match(html, /Wire it up/);
  assert.match(html, /atlas/);
});

test("a loss the daemon did not report is not invented", () => {
  // The breakdown is rendered, never re-derived - so an agent with a queue and no branch
  // must not be warned about a branch, and the reverse. A dialog that overstates gets
  // dismissed on reflex, which is how the one that matters gets clicked through too.
  const queueOnly = render({ queuedItems: 1, clearsContext: false, branch: null });
  assert.match(queueOnly, /1<\/strong> queued work item/);
  assert.doesNotMatch(queueOnly, /detached/);
  assert.doesNotMatch(queueOnly, /\/clear/);

  const branchOnly = render({ queuedItems: 0, clearsContext: true, branch: "feature/held" });
  assert.doesNotMatch(branchOnly, /queued work item/);
  assert.match(branchOnly, /feature\/held/);
});

test("an untitled card still reads as a sentence about a task", () => {
  assert.match(render({ queuedItems: 1, clearsContext: true, branch: null }, null), /this task/);
});
