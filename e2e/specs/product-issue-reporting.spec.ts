import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import {
  FAKE_GH_PRODUCT_ISSUE_URL,
  type FakeGhProductScript,
} from "../fixtures/fake-agents.ts";
import { recordsIn } from "../fixtures/records.ts";

/**
 * Public product reporting, driven the way a person actually meets it.
 *
 * This is the only layer that can see the whole thing. `product-issue-render.test.ts` pins
 * the dialog's markup, `product-issues-http.test.ts` pins the routes, and neither can tell
 * you whether a click on the topbar reaches a form that reaches a route that reaches `gh` -
 * or, more to the point, whether the browser quietly named a repository on the way.
 *
 * Two standing constraints hold here and are the reason the assertions look the way they do:
 *
 * - **Nothing is published.** Every `gh` call goes through the fixture fake (`MISSION_GH_BIN`),
 *   which records its argv and cwd and files nothing. That recorded argv is the assertion
 *   surface - "the browser did not choose the repository" is a claim about what reached the
 *   subprocess, so it is checked there rather than in the DOM.
 * - **No `data-testid`.** Every selector below is a role, a label, or a placeholder, which is
 *   also what keeps the accessible names honest.
 */

/** One recorded `gh` invocation, as the fake writes it. */
interface GhRecord {
  argv: string[];
  cwd: string;
}

/** Only the product-report creates: the fixed triage label is what marks one. */
function productCreates(daemon: DaemonHandle): GhRecord[] {
  return recordsIn<GhRecord>(daemon.recordDir, (file) => file.startsWith("gh-")).filter(
    (record) =>
      record.argv[0] === "issue" &&
      record.argv[1] === "create" &&
      record.argv.includes("status:needs-triage"),
  );
}

function script(daemon: DaemonHandle, next: FakeGhProductScript): void {
  writeFileSync(daemon.ghProductPath, JSON.stringify(next, null, 2));
}

/** The value that follows each `--label` in one `gh issue create` argv. */
function labelsOf(record: GhRecord): string[] {
  return record.argv.filter((_value, index) => record.argv[index - 1] === "--label");
}

/**
 * The dialog itself.
 *
 * Every field selector below is scoped to it rather than to the page, and that is not
 * fussiness: the fleet's own filter box is named "Filter sessions by title or status", so an
 * unscoped `name: "Title"` matches the page behind the modal too.
 */
const form = (page: Page) => page.getByRole("dialog", { name: "Report product feedback" });

/**
 * What the stand-in operator answers the next time the daemon asks.
 *
 * In the shipped app that question is a native dialog raised by the Electron shell over its
 * utility-process port, and the answer is a click. A daemon forked by this fixture has no shell
 * and so deliberately cannot publish at all; the suite gives it a program to ask instead, named
 * on the daemon's own environment at launch. See `writeProductConsentBin`.
 */
function consent(daemon: DaemonHandle, answer: "grant" | "refuse"): void {
  writeFileSync(daemon.productConsentPath, JSON.stringify({ answer }, null, 2));
}

/** Every publish question the daemon actually asked, in order. */
function consentQuestions(daemon: DaemonHandle): Array<{ target: string; title: string }> {
  if (!existsSync(daemon.productConsentAskedPath)) return [];
  return readFileSync(daemon.productConsentAskedPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { target: string; title: string });
}

async function openFromTopbar(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Report product feedback", exact: true }).click();
  await expect(form(page)).toBeVisible();
}

async function fill(page: Page, type: string, title: string, details: string): Promise<void> {
  const dialog = form(page);
  await dialog.getByRole("radio", { name: type, exact: true }).check();
  await dialog.getByRole("textbox", { name: "Title", exact: true }).fill(title);
  await dialog.getByRole("textbox", { name: "Details", exact: true }).fill(details);
  // The preview is debounced and trusted - it comes from the daemon - so waiting for the
  // target to appear is waiting for the confirmation a person would actually read.
  await expect(dialog.getByText("acme/public-issues").first()).toBeVisible();
}

/**
 * The primary control, under whichever of its two names it is currently wearing.
 *
 * Both presses go through the same button, and it renames itself between them - "Report
 * publicly" asks the daemon to confirm what is on screen, and "Publish to acme/public-issues"
 * spends that confirmation. Selecting on the regex keeps `toBeDisabled` assertions honest
 * whichever state the form is in.
 */
const submit = (page: Page) =>
  form(page).getByRole("button", { name: /^(Report publicly|Publish to )/ });
/** The confirming press only. */
const confirmButton = (page: Page) =>
  form(page).getByRole("button", { name: "Report publicly", exact: true });
/** The publishing press only - present solely once a confirmation is held. */
const publishButton = (page: Page) =>
  form(page).getByRole("button", { name: "Publish to acme/public-issues", exact: true });

/**
 * Take both presses.
 *
 * Publishing deliberately cannot be reached in one click, so every test that files an issue
 * goes through here - and the assertion between the two clicks is the invariant itself: the
 * first press files nothing, it arms a control that names where the second press will write.
 */
async function publish(page: Page): Promise<void> {
  await confirmButton(page).click();
  await expect(page.getByText(/Ready to publish in acme\/public-issues/)).toBeVisible();
  await publishButton(page).click();
}
const titleBox = (page: Page) =>
  form(page).getByRole("textbox", { name: "Title", exact: true });

test.beforeEach(({ daemon }) => {
  script(daemon, { preflight: "ok", issueCreate: "created" });
  // Somebody is at the machine and says yes, unless a test says otherwise.
  consent(daemon, "grant");
});

test.describe("the default public issue target", () => {
  test.use({ daemonEnv: { MISSION_PRODUCT_ISSUES_REPO: "" } });

  test("names mancej-cyc/mission-control-issues in the feedback dialog", async ({ dashboard }) => {
    await openFromTopbar(dashboard);
    await form(dashboard)
      .getByRole("textbox", { name: "Title", exact: true })
      .fill("The issue target is incorrect");
    await form(dashboard)
      .getByRole("textbox", { name: "Details", exact: true })
      .fill("The public repository shown here should be the product issue tracker.");

    const target = form(dashboard).getByText("mancej-cyc/mission-control-issues").first();
    await expect(target).toBeVisible();
    if (process.env.MC_E2E_EVIDENCE === "1") {
      const evidenceDir = join(process.cwd(), "e2e", ".artifacts", "product-issue-default-target");
      mkdirSync(evidenceDir, { recursive: true });
      await target.scrollIntoViewIfNeeded();
      await form(dashboard).screenshot({
        path: join(evidenceDir, "correct-default-target-preview.png"),
      });
    }
  });
});

/**
 * The two doorways, and the one draft behind them.
 *
 * A second opener would eventually become a second modal with a second draft, which is the
 * exact retention bug this form is built to avoid - so what is proved is that words typed
 * through one entry point come back through the other.
 */
test("the topbar and the palette open the same retained draft", async ({ dashboard }) => {
  await openFromTopbar(dashboard);
  await titleBox(dashboard).fill("Tiles freeze after reconnect");
  await form(dashboard)
    .getByRole("textbox", { name: "Details", exact: true })
    .fill("Killed the daemon, reconnected, counts never moved again.");
  await dashboard.getByRole("button", { name: "Close", exact: true }).click();
  await expect(form(dashboard)).toBeHidden();

  // In through the palette this time, typed by the word someone in this state reaches for.
  // `Meta+k` and not `ControlOrMeta+k`: `chordFromEvent` derives the Command modifier from
  // `e.metaKey` alone, so the ControlOrMeta spelling arrives as "ctrl+k" and matches nothing.
  await dashboard.keyboard.press("Meta+k");
  const palette = dashboard.getByRole("dialog", { name: "Search everything" });
  await expect(palette).toBeVisible();
  await dashboard.keyboard.type("bug");
  await palette.getByRole("option", { name: /Report product feedback/ }).first().click();

  const dialog = form(dashboard);
  await expect(dialog).toBeVisible();
  await expect(titleBox(dashboard)).toHaveValue("Tiles freeze after reconnect");
  await expect(dialog.getByRole("textbox", { name: "Details", exact: true })).toHaveValue(
    "Killed the daemon, reconnected, counts never moved again.",
  );

  // Clear is the deliberate act, and the only one besides a confirmed creation that empties it.
  await dialog.getByRole("button", { name: "Clear" }).click();
  await expect(titleBox(dashboard)).toHaveValue("");
});

/**
 * Every approved type derives its own triage labels - and the browser derives none of them.
 *
 * The labels are read off the recorded argv rather than the preview panel on purpose: the
 * panel is what a person was SHOWN, and the argv is what actually reached GitHub. A defect
 * that made those two disagree is precisely the one worth catching.
 */
test("all five types file their own labels, and the browser chooses none of them", async ({
  dashboard,
  daemon,
}) => {
  const cases: Array<[string, string]> = [
    ["Bug", "bug"],
    ["Feature request", "feature-request"],
    ["Documentation", "documentation"],
    ["Usability", "usability"],
    ["Other", "other"],
  ];

  for (const [index, [label, wire]] of cases.entries()) {
    await openFromTopbar(dashboard);
    await fill(dashboard, label, `Report about ${wire}`, `Details for the ${wire} case.`);
    await publish(dashboard);
    await expect(form(dashboard).getByRole("link", { name: "View GitHub issue" })).toBeVisible();
    await dashboard.getByRole("button", { name: "Close", exact: true }).click();

    await expect.poll(() => productCreates(daemon).length).toBe(index + 1);
    const record = productCreates(daemon)[index]!;
    expect(labelsOf(record)).toEqual([wire, "status:needs-triage", "source:dashboard"]);
    // The fixed target, from configuration, and the ONLY repository named anywhere in the
    // argv. The request that produced it had no repository field at all.
    expect(record.argv.slice(0, 4)).toEqual([
      "issue",
      "create",
      "--repo",
      "acme/public-issues",
    ]);
    // `source:agent` belongs to the MCP path and cannot be reached from a browser at all.
    expect(record.argv).not.toContain("source:agent");
  }

  // A confirmed creation is the one automatic reset - those words are filed, and reopening
  // on top of them is how the same thing gets reported twice.
  await openFromTopbar(dashboard);
  await expect(titleBox(dashboard)).toHaveValue("");
});

/**
 * The request the browser sends, inspected as bytes.
 *
 * Not a duplicate of the argv check above: that one proves the daemon chose correctly, this
 * one proves the browser never offered an opinion. A route that started honouring a
 * caller-supplied repository would still pass the first and fail this.
 */
test("the submission carries reporter content and nothing that steers GitHub", async ({
  dashboard,
}) => {
  const bodies: string[] = [];
  await dashboard.route("**/api/product-issues", async (route) => {
    bodies.push(route.request().postData() ?? "");
    await route.continue();
  });

  await openFromTopbar(dashboard);
  await fill(dashboard, "Usability", "The rail hides its own scroll", "I could not find it.");
  await publish(dashboard);
  await expect(form(dashboard).getByRole("link", { name: "View GitHub issue" })).toBeVisible();

  expect(bodies).toHaveLength(1);
  const sent = JSON.parse(bodies[0]!) as Record<string, unknown>;
  expect(Object.keys(sent).sort()).toEqual([
    "attachmentUploadIds",
    "client",
    "confirmationToken",
    "details",
    "requestId",
    "title",
    "type",
  ]);
  expect(sent.attachmentUploadIds).toEqual([]);
  // No repository, no labels, no source, no environment, no local path.
  expect(bodies[0]).not.toContain("acme/public-issues");
  expect(bodies[0]).not.toContain("status:needs-triage");
  expect(bodies[0]).not.toContain("source:");
});

/**
 * Publishing takes two presses, and nothing is fetched between the second and the publish.
 *
 * This is the regression guard on three real defects, each caught after the one before it was
 * fixed. The first revision authorized with `draftIdentity`, a hash of the request anything
 * holding the draft could recompute. The second took a random token, but the PREVIEW reply
 * handed it out - and the modal previews on every settled keystroke, so publishing authority
 * arrived by typing rather than by anyone deciding. A third fetched its preview inside the
 * click handler and submitted it in the same promise chain, so React never rendered what was
 * published.
 *
 * So three things are asserted here. The preview reply carries no token at all. The confirming
 * press mints one, against the identity that is on screen. And between the publishing press
 * and the publish there is exactly one network event - the publish - carrying that token.
 */
test("publishing takes a confirming press first, and sends the token that press returned", async ({
  dashboard,
}) => {
  const wire: Array<{ kind: "preview" | "confirm" | "submit"; body: string }> = [];
  let previewCarriedToken = false;
  let grantedToken: string | null = null;

  await dashboard.route("**/api/product-issues/preview", async (route) => {
    wire.push({ kind: "preview", body: route.request().postData() ?? "" });
    const response = await route.fetch();
    const json = (await response.json()) as Record<string, unknown>;
    if ("confirmationToken" in json) previewCarriedToken = true;
    await route.fulfill({ response, json });
  });
  await dashboard.route("**/api/product-issues/confirm", async (route) => {
    wire.push({ kind: "confirm", body: route.request().postData() ?? "" });
    const response = await route.fetch();
    const json = (await response.json()) as { token?: string };
    if (json.token) grantedToken = json.token;
    await route.fulfill({ response, json });
  });
  await dashboard.route("**/api/product-issues", async (route) => {
    wire.push({ kind: "submit", body: route.request().postData() ?? "" });
    await route.continue();
  });

  await openFromTopbar(dashboard);
  await fill(
    dashboard,
    "Documentation",
    "The setup page skips the gh auth step",
    "Followed setup.md end to end and the daemon could not reach GitHub.",
  );

  // Reading has happened, repeatedly, and it granted nothing.
  expect(wire.some((entry) => entry.kind === "preview")).toBe(true);
  expect(
    previewCarriedToken,
    "a preview reply carrying a publish token is authority obtained by reading",
  ).toBe(false);
  // And the form does not offer to publish yet - only to check.
  await expect(publishButton(dashboard)).toBeHidden();

  await confirmButton(dashboard).click();
  await expect(dashboard.getByText(/Ready to publish in acme\/public-issues/)).toBeVisible();
  await expect(publishButton(dashboard)).toBeEnabled();
  expect(grantedToken, "the confirming press returned no grant").toBeTruthy();

  // From here the only network event a correct implementation produces is the publish.
  const beforeClick = wire.length;
  await publishButton(dashboard).click();
  await expect(form(dashboard).getByRole("link", { name: "View GitHub issue" })).toBeVisible();

  const afterClick = wire.slice(beforeClick);
  expect(
    afterClick.map((entry) => entry.kind),
    "anything fetched between the press and the publish is content that was never rendered",
  ).toEqual(["submit"]);
  const sent = JSON.parse(afterClick[0]!.body) as { confirmationToken: string };
  expect(sent.confirmationToken).toBe(grantedToken);
});

/**
 * Editing the report takes the confirmation back.
 *
 * The daemon would refuse a grant whose derivation moved anyway, so this is about what the
 * screen says: a button still offering to publish under words that have since changed is an
 * offer to publish something that is no longer written there. After an edit the control is
 * back to asking to check, and a second confirming press is required.
 */
test("editing after confirming disarms the publish and requires confirming again", async ({
  dashboard,
  daemon,
}) => {
  await openFromTopbar(dashboard);
  await fill(
    dashboard,
    "Bug",
    "Tiles freeze after reconnect",
    "Killed the daemon, reconnected, and the counts never moved again.",
  );
  await confirmButton(dashboard).click();
  await expect(publishButton(dashboard)).toBeVisible();

  await titleBox(dashboard).fill("Tiles freeze after reconnect, every time");
  await expect(publishButton(dashboard)).toBeHidden();
  await expect(dashboard.getByText(/Ready to publish/)).toBeHidden();
  await expect(confirmButton(dashboard)).toBeVisible();
  // Nothing was published by the edit, or by the confirmation it invalidated.
  expect(productCreates(daemon)).toHaveLength(0);

  // The way forward is the same two presses, now against what is actually written.
  await expect(confirmButton(dashboard)).toBeEnabled();
  await publish(dashboard);
  // Polled, like every other positive assertion on the recorder here: the fake writes its
  // record from a separate process, so the DOM can show the outcome before the file lands.
  await expect.poll(() => productCreates(daemon).length).toBe(1);
  expect(productCreates(daemon)[0]!.argv.join(" ")).toContain(
    "Tiles freeze after reconnect, every time",
  );
});

/**
 * The reported bypass, driven end to end against the real daemon.
 *
 * A local process previews, confirms and publishes over the loopback API - the exact sequence
 * in the finding, with no browser involved at all. It reads the public content, which is a read
 * and was never the problem, and then stops: the confirming call reaches a person who says no,
 * and there is no grant to publish with. Nothing that a caller could have SENT would have
 * changed that, which is the property four revisions of this feature were trying to reach.
 */
test("a local caller can preview but cannot publish when the operator says no", async ({
  dashboard,
  daemon,
}) => {
  consent(daemon, "refuse");
  const body = {
    type: "bug",
    title: "Filed by a local script",
    details: "Straight at the loopback API, in the same order the dashboard calls it.",
    attachmentUploadIds: [] as string[],
    requestId: "9f1d2c3b-4a5e-4f60-8b71-2c3d4e5f6a7b",
    client: "browser",
  };
  const previewed = await dashboard.request.post(`${daemon.baseURL}/api/product-issues/preview`, {
    data: body,
  });
  expect(previewed.status()).toBe(200);
  const preview = (await previewed.json()) as Record<string, unknown>;
  expect("confirmationToken" in preview).toBe(false);

  const confirmed = await dashboard.request.post(`${daemon.baseURL}/api/product-issues/confirm`, {
    data: body,
  });
  expect(confirmed.status()).toBe(409);
  // And the attempt was not silent: it put the question in front of somebody, naming the
  // repository it wanted to write to. A script cannot do this quietly.
  expect(consentQuestions(daemon)).toContainEqual({
    target: "acme/public-issues",
    title: "Filed by a local script",
  });

  const published = await dashboard.request.post(`${daemon.baseURL}/api/product-issues`, {
    data: { ...body, confirmationToken: preview.draftIdentity },
  });
  expect(published.status()).toBe(502);
  expect(productCreates(daemon)).toHaveLength(0);
});

/**
 * The same refusal, met through the form rather than through curl.
 *
 * The person pressed Report publicly, read the dialog, and said no. The draft survives - the
 * words were never the problem - and the button is back to asking rather than stuck armed.
 */
test("declining the publish dialog keeps the draft and publishes nothing", async ({
  dashboard,
  daemon,
}) => {
  consent(daemon, "refuse");
  await openFromTopbar(dashboard);
  await fill(
    dashboard,
    "Bug",
    "Tiles freeze after reconnect",
    "Killed the daemon, reconnected, and the counts never moved again.",
  );
  await confirmButton(dashboard).click();

  await expect(form(dashboard).getByRole("alert")).toContainText(/not confirmed/i);
  await expect(publishButton(dashboard)).toBeHidden();
  await expect(titleBox(dashboard)).toHaveValue("Tiles freeze after reconnect");
  expect(productCreates(daemon)).toHaveLength(0);

  // Saying yes on the second ask publishes the same words, with no retyping.
  consent(daemon, "grant");
  await publish(dashboard);
  await expect.poll(() => productCreates(daemon).length).toBe(1);
});

/**
 * A confirmation the daemon did not mint publishes nothing./**
 * A confirmation the daemon did not mint publishes nothing.
 *
 * The browser is not the boundary here and this proves it: the request is rewritten on the
 * wire, exactly as a local script could write it, and the daemon refuses. The draft survives,
 * because nothing was published and the words were never the problem.
 */
test("a forged confirmation is refused by the daemon and reaches no gh", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.route("**/api/product-issues", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    await route.continue({
      postData: JSON.stringify({ ...body, confirmationToken: "d".repeat(64) }),
    });
  });

  await openFromTopbar(dashboard);
  await fill(dashboard, "Other", "Forged confirmation", "This must not reach GitHub.");
  await publish(dashboard);

  await expect(form(dashboard).getByRole("alert")).toContainText(/not confirmed/i);
  expect(productCreates(daemon)).toHaveLength(0);
  await expect(titleBox(dashboard)).toHaveValue("Forged confirmation");
});

/**
 * Screenshots are drawn and inert, and the DOM's `disabled` is not what makes that true.
 *
 * The gesture under test is the one someone actually performs - ⌃⇧⌘4 then paste into the
 * details box - and the claim is that no local path can reach `gh` through it. The server
 * gate is the boundary; this proves the browser never even builds the attempt.
 */
test("the screenshot region explains itself and cannot upload", async ({
  dashboard,
  daemon,
}) => {
  await openFromTopbar(dashboard);
  const dialog = form(dashboard);
  await expect(
    dialog.getByText("Screenshot upload is waiting for first-party GitHub CLI support"),
  ).toBeVisible();
  await expect(dialog.getByRole("link", { name: "cli/cli#13256" })).toBeVisible();
  await expect(dialog.getByLabel("Add screenshots")).toBeDisabled();

  // Paste a real image file onto the details box. The enabled hook would upload it.
  await dialog.getByRole("textbox", { name: "Details", exact: true }).click();
  await dashboard.evaluate(() => {
    const area = document.querySelector<HTMLTextAreaElement>(".feedback-field textarea");
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png" }),
    );
    area?.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(dialog.getByRole("button", { name: /^Remove / })).toHaveCount(0);

  await fill(dashboard, "Bug", "Something visual went wrong", "Described in words instead.");
  await publish(dashboard);
  await expect(form(dashboard).getByRole("link", { name: "View GitHub issue" })).toBeVisible();

  await expect.poll(() => productCreates(daemon).length).toBe(1);
  const record = productCreates(daemon)[0]!;
  expect(record.argv).not.toContain("--attach");
  expect(record.argv.join(" ")).not.toContain("shot.png");
});

/**
 * The two failure shapes a person has to be able to tell apart.
 *
 * A refusal provably published nothing, so the draft and the button both stay. An unknown
 * outcome could not tell, so retrying is how a duplicate public issue gets filed - and the
 * only recovery that answers the question is to go and look at the repository.
 */
test("a refusal is safely retryable, and an unknown outcome is not", async ({
  dashboard,
  daemon,
}) => {
  script(daemon, { preflight: "ok", issueCreate: "refused" });
  await openFromTopbar(dashboard);
  await fill(dashboard, "Bug", "Refused once", "The CLI will say no to this one.");
  await publish(dashboard);
  await expect(form(dashboard).getByRole("alert")).toContainText(/refused/i);
  // The words survive, and so does the way forward.
  await expect(titleBox(dashboard)).toHaveValue("Refused once");
  await expect(submit(dashboard)).toBeEnabled();

  script(daemon, { preflight: "ok", issueCreate: "created" });
  await publish(dashboard);
  await expect(form(dashboard).getByRole("link", { name: "View GitHub issue" })).toBeVisible();
  await dashboard.getByRole("button", { name: "Close", exact: true }).click();

  script(daemon, { preflight: "ok", issueCreate: "unknown" });
  await openFromTopbar(dashboard);
  await fill(dashboard, "Other", "Uncertain result", "The CLI will succeed without a URL.");
  await publish(dashboard);
  await expect(form(dashboard).getByRole("alert")).toContainText(/check the target repository/i);
  await expect(submit(dashboard)).toBeDisabled();
  // The draft is kept - the report may still need filing - but this opening will not send
  // it again, so a second click cannot become a second public issue.
  await expect(titleBox(dashboard)).toHaveValue("Uncertain result");
});

/**
 * A blocked preflight names the missing thing.
 *
 * "Reporting is unavailable" on its own is a dead end; "run `gh auth login`" is a next step.
 * Both failures below are ones an operator can actually fix, so both have to say which.
 */
test("missing GitHub auth and a missing label each produce actionable copy", async ({
  dashboard,
  daemon,
}) => {
  script(daemon, { preflight: "gh-auth", issueCreate: "created" });
  await openFromTopbar(dashboard);
  await expect(form(dashboard).getByRole("alert")).toContainText("gh auth login");
  await expect(submit(dashboard)).toBeDisabled();
  await dashboard.getByRole("button", { name: "Close", exact: true }).click();

  script(daemon, { preflight: "labels", issueCreate: "created" });
  await openFromTopbar(dashboard);
  await expect(form(dashboard).getByRole("alert")).toContainText(
    /Create the missing labels in acme\/public-issues: usability/,
  );
  await expect(submit(dashboard)).toBeDisabled();
  expect(productCreates(daemon)).toHaveLength(0);
});

/**
 * The topbar's own claim: the control survives the ladder.
 *
 * `topbar-one-row.spec.ts` remains the whole-bar geometry authority and is not duplicated
 * here. What this adds is the FEATURE assertion that measurement cannot make - that at a
 * width where the bar has shed most of its words, the button an unhappy person is hunting
 * for is still on screen, still named, and still opens the form.
 */
test("the Feedback control stays reachable when the bar is compressed", async ({
  dashboard,
}) => {
  await dashboard.setViewportSize({ width: 900, height: 800 });
  const bar = dashboard.locator(".topbar");
  await expect(bar).toBeVisible();
  // One row, at the width that fires most of the ladder.
  const height = await bar.evaluate((element) => element.getBoundingClientRect().height);
  expect(height).toBeLessThan(80);

  const feedback = dashboard.getByRole("button", { name: "Report product feedback", exact: true });
  await expect(feedback).toBeVisible();
  await feedback.click();
  await expect(dashboard.getByRole("dialog", { name: "Report product feedback" })).toBeVisible();
});

/**
 * Demo mode publishes nothing at all.
 *
 * The demo fleet is shown to people who did not build it, and a form that files real public
 * issues from a demonstration is a trap. The daemon refuses before the runner, so what is
 * asserted is the absence of any record - not a message.
 */
test.describe("demo mode", () => {
  test.use({ daemonEnv: { MISSION_DEMO_SCENARIO_DIR: join(process.cwd(), "scripts/demo") } });

  test("reporting is inert and reaches no gh at all", async ({ dashboard, daemon }) => {
    await openFromTopbar(dashboard);
    await expect(form(dashboard).getByRole("alert")).toContainText(/demo mode/i);
    await expect(submit(dashboard)).toBeDisabled();
    expect(productCreates(daemon)).toHaveLength(0);
  });
});

/**
 * The agent doorway, from the outside.
 *
 * Phase 1 owns its confirmation flow; what is checked here is the one property that has to
 * remain true once the dashboard route exists beside it - an agent's report is marked
 * `source:agent`, and it travels on the token-guarded transport rather than the loopback
 * route the browser uses. The unit suite covers the review gate itself.
 */
test("the agent path is separately marked and separately guarded", async ({ daemon }) => {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const request = {
    type: "bug" as const,
    title: "Reported by an agent",
    details: "Filed through the MCP transport.",
    attachmentUploadIds: [],
    requestId: crypto.randomUUID(),
    client: "browser" as const,
  };

  // Without the daemon token there is no agent path at all.
  const unauthorized = await fetch(`${daemon.baseURL}/mcp/product-issues/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...request, env: {} }),
  });
  expect(unauthorized.status).toBe(401);

  // And with it, but with no live attributed session, still nothing.
  const unattributed = await fetch(`${daemon.baseURL}/mcp/product-issues`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({ ...request, env: {} }),
  });
  expect(unattributed.status).toBe(404);
  expect(productCreates(daemon)).toHaveLength(0);

  // The dashboard route, meanwhile, refuses a submission that carries no confirmation.
  const unconfirmed = await fetch(`${daemon.baseURL}/api/product-issues`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  expect(unconfirmed.status).toBe(400);
  expect(productCreates(daemon)).toHaveLength(0);
  expect(FAKE_GH_PRODUCT_ISSUE_URL).toContain("acme/public-issues");
});
