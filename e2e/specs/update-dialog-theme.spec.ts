import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { UPDATE_COPY } from "../../src/shared/update-copy.ts";
import { UPDATE_DIALOGS, type UpdateDialogRequest } from "../../src/shared/update-dialog.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { expect, test } from "../fixtures/test.ts";
import type { Page } from "@playwright/test";

/**
 * The updater's questions, asked in the app's own clothes.
 *
 * Every one of these used to be `dialog.showMessageBox`, and no layer in this repository
 * could see what that looked like: a platform sheet is not in the DOM, has no accessible
 * name the dashboard owns, and carries none of the panel, border or type ramp the rest of
 * the product does. This spec drives the real modal through the real bridge shape - a
 * pushed request, a clicked answer, the id travelling back - and measures the laid-out
 * result against the panel border, which is the one thing markup cannot show.
 */

interface DialogBridge {
  /** Requests the shell has pushed, in order. */
  push(request: UpdateDialogRequest): void;
  /** The answers the dashboard sent back. */
  answers(): { id: string; choice: string }[];
}

declare global {
  interface Window {
    updateDialogFixture: DialogBridge;
  }
}

/**
 * Stand the preload bridge up in the page, then reload so the dashboard mounts against it.
 *
 * The shape is the preload's, not a convenience: `onDialog` both subscribes and stands in for
 * the readiness announcement, and `answerDialog` records what the dashboard sent back, which
 * is how these tests can assert that an answer carries the id of the question it answers.
 */
async function installDialogBridge(dashboard: Page): Promise<void> {
  await dashboard.addInitScript(() => {
    const listeners = new Set<(request: unknown) => void>();
    const answered: { id: string; choice: string }[] = [];
    Object.defineProperty(window, "missionDesktop", {
      value: {
        isDesktop: true,
        onOpenSettings: () => () => {},
        updates: {
          getState: async () => null,
          onState: () => () => {},
          onDialog: (cb: (request: unknown) => void) => {
            listeners.add(cb);
            return () => listeners.delete(cb);
          },
          answerDialog: (id: string, choice: string) => answered.push({ id, choice }),
        },
      },
    });
    Object.defineProperty(window, "updateDialogFixture", {
      value: {
        push: (request: unknown) => {
          for (const listener of listeners) listener(request);
        },
        answers: () => answered,
      },
    });
  });
  await dashboard.reload();
}

test("the updater asks through a themed modal and its answer carries the question's id", async ({ dashboard }) => {
  await installDialogBridge(dashboard);

  const offer: UpdateDialogRequest = {
    ...UPDATE_DIALOGS.available({
      currentVersion: "1.9.0",
      newVersion: "1.9.1",
      name: "Mission Control 1.9.1",
      notes: "Faster launches and clearer update status.",
    }),
    id: "offer-1",
  };
  await dashboard.evaluate((request) => window.updateDialogFixture.push(request), offer);

  const modal = dashboard.getByRole("dialog", { name: "Mission Control update" });
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("Mission Control 1.9.1 is available");
  await expect(modal).toContainText("Faster launches and clearer update status.");

  // The app's own panel, not the platform's sheet: the themed shell is what draws it, and
  // the theme's panel background is what it is painted on.
  await expect(modal).toHaveClass(/\bmodal\b/);
  await expect(modal).toHaveCSS("background-color", "rgb(20, 24, 30)");
  await expectContentClearsBorder(modal);

  const capture = async (name: string): Promise<void> => {
    if (process.env.MC_E2E_EVIDENCE !== "1") return;
    const evidence = join(process.cwd(), "e2e/.artifacts/update-dialog-theme");
    await mkdir(evidence, { recursive: true });
    await dashboard.screenshot({ path: join(evidence, name), fullPage: true });
  };
  await capture("available.png");

  // Both answers are ordinary dashboard buttons, tooltips and all.
  await modal.getByRole("button", { name: "Update Now" }).hover();
  await expect(dashboard.locator(".tooltip")).toHaveText(
    "Build Mission Control 1.9.1 now, then restart when it is ready",
  );
  await dashboard.mouse.move(1, 1);

  await modal.getByRole("button", { name: "Later" }).click();
  await expect(modal).toBeHidden();
  expect(await dashboard.evaluate(() => window.updateDialogFixture.answers())).toEqual([
    { id: "offer-1", choice: "dismiss" },
  ]);

  // The restart question, which is the one that closes the app, and the one the platform
  // sheet used to ask with a system button.
  await dashboard.evaluate(
    (request) => window.updateDialogFixture.push(request),
    { ...UPDATE_DIALOGS.ready("1.9.1"), id: "ready-1" } satisfies UpdateDialogRequest,
  );
  await expect(modal).toContainText(UPDATE_COPY.ready.title("1.9.1"));
  await expect(modal).toContainText(UPDATE_COPY.ready.detail);
  await expectContentClearsBorder(modal);
  await capture("ready.png");
  await modal.getByRole("button", { name: "Restart and Install" }).click();
  await expect(modal).toBeHidden();
  expect(await dashboard.evaluate(() => window.updateDialogFixture.answers())).toEqual([
    { id: "offer-1", choice: "dismiss" },
    { id: "ready-1", choice: "confirm" },
  ]);
});

test("a failed update is drawn in the error tone, and Escape answers it", async ({ dashboard }) => {
  await installDialogBridge(dashboard);

  await dashboard.evaluate(
    (request) => window.updateDialogFixture.push(request),
    {
      ...UPDATE_DIALOGS.outcome({
        result: "failure",
        targetVersion: "1.9.1",
        recordedAt: "2026-09-11T00:00:00.000Z",
        message: "The previous update did not finish. The existing app was left in place.",
      }),
      id: "outcome-1",
    } satisfies UpdateDialogRequest,
  );

  const modal = dashboard.getByRole("dialog", { name: "Mission Control update" });
  await expect(modal).toContainText("Mission Control 1.9.1 could not be installed");
  await expect(modal).toContainText("The existing app was left in place.");
  // The tone is the theme's own danger token, so a failure reads as one at a glance.
  await expect(modal.locator(".update-dialog-title")).toHaveCSS("color", "rgb(248, 81, 73)");
  await expectContentClearsBorder(modal);

  if (process.env.MC_E2E_EVIDENCE === "1") {
    const evidence = join(process.cwd(), "e2e/.artifacts/update-dialog-theme");
    await mkdir(evidence, { recursive: true });
    await dashboard.screenshot({ path: join(evidence, "failure.png"), fullPage: true });
  }

  // Escape answers with the dialog's own dismissal rather than leaving the shell waiting.
  await dashboard.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  expect(await dashboard.evaluate(() => window.updateDialogFixture.answers())).toEqual([
    { id: "outcome-1", choice: "dismiss" },
  ]);
});

test("every auto-update modal wears the same theme, not just the ones with two answers", async ({ dashboard }) => {
  // The two tests above prove three of the seven conversations. This one walks ALL of them,
  // because "the update dialogs are themed" is a claim about the set: the four single-button
  // notices are exactly the ones a person meets without being asked to decide anything, and
  // they were just as grey as the rest. Every kind is asserted through the same three
  // properties - the themed shell, the theme's panel ground, and text clear of the border -
  // so a phase added later without a look at it fails here rather than shipping as a sheet.
  await installDialogBridge(dashboard);

  // One per kind, in the order a person meets them across an update's life.
  const conversations = [
    {
      frame: "check-available.png",
      headline: "Mission Control 1.9.1 is available",
      content: UPDATE_DIALOGS.available({
        currentVersion: "1.9.0",
        newVersion: "1.9.1",
        name: "Mission Control 1.9.1",
        notes: "Faster launches and clearer update status.",
      }),
    },
    {
      // The other half of what **Check for Updates…** can answer, and the one a person sees
      // most often: nothing to do.
      frame: "check-up-to-date.png",
      headline: "Mission Control 1.9.1 is up to date",
      content: UPDATE_DIALOGS.upToDate("1.9.1"),
    },
    {
      frame: "check-preparing.png",
      headline: UPDATE_COPY.preparing.title("1.9.1"),
      content: UPDATE_DIALOGS.preparing("1.9.1", "Building the new version"),
    },
    {
      frame: "check-ready.png",
      headline: UPDATE_COPY.ready.title("1.9.1"),
      content: UPDATE_DIALOGS.ready("1.9.1"),
    },
    {
      frame: "check-applying.png",
      headline: UPDATE_COPY.applying.title("1.9.1"),
      content: UPDATE_DIALOGS.applying("1.9.1"),
    },
    {
      frame: "check-error.png",
      headline: "The update could not be completed",
      content: UPDATE_DIALOGS.error("gh is not authenticated. Run `gh auth login` and try again."),
    },
    {
      frame: "check-outcome.png",
      headline: "Mission Control was updated to 1.9.1",
      content: UPDATE_DIALOGS.outcome({
        result: "success",
        targetVersion: "1.9.1",
        recordedAt: "2026-09-11T00:00:00.000Z",
      }),
    },
  ];

  const modal = dashboard.getByRole("dialog", { name: "Mission Control update" });
  const evidence = join(process.cwd(), "e2e/.artifacts/update-dialog-theme");
  if (process.env.MC_E2E_EVIDENCE === "1") await mkdir(evidence, { recursive: true });

  const seen: string[] = [];
  for (const [index, conversation] of conversations.entries()) {
    const request: UpdateDialogRequest = { ...conversation.content, id: `kind-${index}` };
    await dashboard.evaluate((pushed) => window.updateDialogFixture.push(pushed), request);

    await expect(modal).toBeVisible();
    await expect(modal).toContainText(conversation.headline);
    // The app's panel and the app's shell, for every one of them.
    await expect(modal).toHaveClass(/\bmodal\b/);
    await expect(modal).toHaveClass(new RegExp(`update-dialog-${conversation.content.tone}\\b`));
    await expect(modal).toHaveCSS("background-color", "rgb(20, 24, 30)");
    await expect(modal.locator(".modal-head")).toBeVisible();
    await expect(modal.locator(".modal-foot")).toBeVisible();
    await expectContentClearsBorder(modal);
    // Themed buttons rather than the platform's, and every dialog offers a way out.
    await expect(modal.locator("footer.modal-foot .btn")).toHaveCount(
      conversation.content.actions.length,
    );

    if (process.env.MC_E2E_EVIDENCE === "1") {
      await dashboard.screenshot({ path: join(evidence, conversation.frame), fullPage: true });
    }

    seen.push(conversation.content.kind);
    // Clear it the way a person would, so the next one is drawn from a clean screen.
    await dashboard.keyboard.press("Escape");
    await expect(modal).toBeHidden();
  }

  // Named rather than counted: a kind quietly dropped from the walk would otherwise still
  // pass a length check against a list this test also owns.
  expect(seen).toEqual([
    "available",
    "up-to-date",
    "preparing",
    "ready",
    "applying",
    "error",
    "outcome",
  ]);
});

test("two outstanding questions are answered one at a time, each by its own id", async ({ dashboard }) => {
  // The shell can have two open at once: the outcome notice fires seconds after launch, and a
  // manual check started from the menu bar while it is up is a second conversation rather than
  // a replacement for the first. The dashboard draws the head of the queue only - two modals
  // stacked on one backdrop would leave the operator answering the newer question while the
  // older one waited invisibly behind it - and each answer must carry its own question's id.
  await installDialogBridge(dashboard);

  const outcome: UpdateDialogRequest = {
    ...UPDATE_DIALOGS.outcome({
      result: "success",
      targetVersion: "1.9.1",
      recordedAt: "2026-09-11T00:00:00.000Z",
    }),
    id: "outcome-1",
  };
  const offer: UpdateDialogRequest = {
    ...UPDATE_DIALOGS.available({
      currentVersion: "1.9.1",
      newVersion: "1.9.2",
      name: "Mission Control 1.9.2",
      notes: "A second release, offered while the first notice is still up.",
    }),
    id: "offer-1",
  };

  await dashboard.evaluate((pushed) => window.updateDialogFixture.push(pushed), outcome);
  await dashboard.evaluate((pushed) => window.updateDialogFixture.push(pushed), offer);

  const modal = dashboard.getByRole("dialog", { name: "Mission Control update" });
  // The older question owns the screen, and the newer one is nowhere on it.
  await expect(modal).toHaveCount(1);
  await expect(modal).toContainText("Mission Control was updated to 1.9.1");
  await expect(modal).not.toContainText("1.9.2 is available");

  await modal.getByRole("button", { name: "OK" }).click();

  // Answering it hands the screen to the one that was waiting, which still offers its own
  // two answers rather than the acknowledgement the first one had.
  await expect(modal).toContainText("Mission Control 1.9.2 is available");
  await expect(modal).toContainText("A second release, offered while the first notice is still up.");
  await expectContentClearsBorder(modal);
  await modal.getByRole("button", { name: "Update Now" }).click();
  await expect(modal).toBeHidden();

  // Each answer named the question it was answering, in the order they were answered.
  expect(await dashboard.evaluate(() => window.updateDialogFixture.answers())).toEqual([
    { id: "outcome-1", choice: "dismiss" },
    { id: "offer-1", choice: "confirm" },
  ]);
});
