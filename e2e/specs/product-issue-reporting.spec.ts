import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import {
  FAKE_GH_PRODUCT_ISSUE_URL,
  type FakeGhProductScript,
  writeProductAuthorizationScript,
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
 * fussiness: the fleet's own filter box is named for session filtering, so an
 * unscoped `name: "Title"` matches the page behind the modal too.
 */
const form = (page: Page) => page.getByRole("dialog", { name: "Report product feedback" });

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

const submit = (page: Page) =>
  form(page).getByRole("button", { name: "Report publicly", exact: true });

/** Publish through the single Report press exposed to the person using the form. */
async function publish(page: Page): Promise<void> {
  await submit(page).click();
}
const titleBox = (page: Page) =>
  form(page).getByRole("textbox", { name: "Title", exact: true });

test.beforeEach(async ({ dashboard, daemon }) => {
  script(daemon, { preflight: "ok", issueCreate: "created" });
  writeProductAuthorizationScript(daemon.home, { answer: "grant" });
  await dashboard.addInitScript(() => {
    const capability = "playwright-product-issue-capability";
    let claimed = false;
    Object.defineProperty(window, "missionDesktop", {
      configurable: true,
      value: {
        isDesktop: true,
        onOpenSettings: () => () => {},
        claimProductIssueAuthorization: () => {
          if (claimed) return null;
          claimed = true;
          return capability;
        },
        authorizeProductIssue: (candidate: string) =>
          claimed && candidate === capability && navigator.userActivation.isActive,
      },
    });
  });
  await dashboard.reload();
});

test("a loopback caller cannot authorize itself, while one Report click publishes", async ({
  dashboard,
  daemon,
}) => {
  writeProductAuthorizationScript(daemon.home, { answer: "refuse" });
  const input = {
    type: "bug",
    title: "Unauthorized local publish",
    details: "A local process must not be able to mint its own public publishing grant.",
    attachmentUploadIds: [],
    requestId: randomUUID(),
    client: "electron",
  };
  const previewed = await dashboard.request.post(
    `${daemon.baseURL}/api/product-issues/preview`,
    { data: input },
  );
  expect(previewed.status()).toBe(200);
  const confirmed = await dashboard.request.post(
    `${daemon.baseURL}/api/product-issues/confirm`,
    { data: input },
  );
  expect(confirmed.status()).toBe(409);
  expect((await confirmed.json()).outcome).toBe("refused");
  expect(productCreates(daemon)).toHaveLength(0);

  writeProductAuthorizationScript(daemon.home, { answer: "grant" });
  await openFromTopbar(dashboard);
  await fill(
    dashboard,
    "Bug",
    "One click reports the issue",
    "The Report button should authorize and publish without another prompt.",
  );
  await publish(dashboard);
  await expect(form(dashboard).getByRole("link", { name: "View GitHub issue" })).toBeVisible();
  await expect(form(dashboard).locator("footer").getByRole("button", { name: "Close" })).toBeVisible();
  expect(productCreates(daemon)).toHaveLength(1);
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
  await dashboard.getByRole("button", { name: "Close feedback form", exact: true }).click();
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
    await form(dashboard).locator("footer").getByRole("button", { name: "Close", exact: true }).click();

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
 * Publishing takes one press while retaining the daemon's internal single-use grant.
 *
 * This is the regression guard on three real defects, each caught after the one before it was
 * fixed. The first revision authorized with `draftIdentity`, a hash of the request anything
 * holding the draft could recompute. The second took a random token, but the PREVIEW reply
 * handed it out - and the modal previews on every settled keystroke, so publishing authority
 * arrived by typing rather than by anyone deciding. A third fetched its preview inside the
 * click handler and submitted it in the same promise chain, so React never rendered what was
 * published.
 *
 * The preview reply carries no token. The Report press mints one against the identity on screen
 * and spends it immediately, without exposing an armed second-click state.
 */
test("one Report press confirms and publishes without an armed second-click state", async ({
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
  await expect(dashboard.getByText(/Ready to publish/)).toBeHidden();

  // One user action performs the bounded confirm/submit exchange and reaches the terminal result.
  const beforeClick = wire.length;
  await submit(dashboard).click();
  await expect(form(dashboard).getByRole("link", { name: "View GitHub issue" })).toBeVisible();
  await expect(dashboard.getByText(/Ready to publish in acme\/public-issues/)).toBeHidden();
  await expect(
    form(dashboard).locator("footer").getByRole("button", { name: "Close", exact: true }),
  ).toBeVisible();

  if (process.env.MC_E2E_EVIDENCE === "1") {
    const evidenceDir = join(process.cwd(), "e2e", ".artifacts", "product-issue-one-click");
    mkdirSync(evidenceDir, { recursive: true });
    await form(dashboard).locator("footer").scrollIntoViewIfNeeded();
    await dashboard.mouse.move(1, 1);
    await form(dashboard).screenshot({
      path: join(evidenceDir, "reported-with-close-action.png"),
    });
  }

  const afterClick = wire.slice(beforeClick);
  expect(
    afterClick.map((entry) => entry.kind),
    "one Report press must complete confirmation and publication",
  ).toEqual(["confirm", "submit"]);
  expect(grantedToken, "the Report press returned no grant").toBeTruthy();
  const sent = JSON.parse(afterClick[1]!.body) as { confirmationToken: string };
  expect(sent.confirmationToken).toBe(grantedToken);
});

test("forged and implicit submissions do not bypass the trusted Report control", async ({
  dashboard,
  daemon,
}) => {
  await openFromTopbar(dashboard);
  await fill(
    dashboard,
    "Bug",
    "Enter must not publish",
    "Only activating the Report control should authorize this public issue.",
  );
  await expect(submit(dashboard)).toBeEnabled();

  await dashboard.evaluate(() => {
    const report = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Report publicly"]',
    );
    if (!report?.form) throw new Error("missing Report control");
    const fake = document.createElement("button");
    fake.textContent = "Forged report control";
    fake.addEventListener("click", () => report.form?.requestSubmit(report));
    report.closest("footer")?.append(fake);
  });
  await dashboard.getByRole("button", { name: "Forged report control" }).click();
  expect(productCreates(daemon)).toHaveLength(0);

  await titleBox(dashboard).press("Enter");
  await expect(form(dashboard).getByRole("link", { name: "View GitHub issue" })).toHaveCount(0);
  expect(productCreates(daemon)).toHaveLength(0);

  await publish(dashboard);
  await expect(form(dashboard).getByRole("link", { name: "View GitHub issue" })).toBeVisible();
  expect(productCreates(daemon)).toHaveLength(1);
});

test("editing before reporting publishes the latest rendered draft in one press", async ({
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
  await titleBox(dashboard).fill("Tiles freeze after reconnect, every time");
  await expect(
    form(dashboard).getByRole("region", { name: "What will be published" }),
  ).toContainText("Tiles freeze after reconnect, every time");
  expect(productCreates(daemon)).toHaveLength(0);

  await expect(submit(dashboard)).toBeEnabled();
  await publish(dashboard);
  // Polled, like every other positive assertion on the recorder here: the fake writes its
  // record from a separate process, so the DOM can show the outcome before the file lands.
  await expect.poll(() => productCreates(daemon).length).toBe(1);
  expect(productCreates(daemon)[0]!.argv.join(" ")).toContain(
    "Tiles freeze after reconnect, every time",
  );
});

/**
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
 * A screenshot goes through the real browser upload route and reaches gh only as a
 * daemon-resolved path. The browser request carries the opaque upload id, never that path.
 */
test("the screenshot input uploads and publishes through one first-party attach argument", async ({
  dashboard,
  daemon,
}) => {
  const previewAttachmentIds: string[][] = [];
  await dashboard.route("**/api/product-issues/preview", async (route) => {
    const request = JSON.parse(route.request().postData() ?? "{}") as {
      attachmentUploadIds?: string[];
    };
    previewAttachmentIds.push(request.attachmentUploadIds ?? []);
    await route.continue();
  });

  await openFromTopbar(dashboard);
  const dialog = form(dashboard);
  await expect(
    dialog.getByText(/Choose, paste, or drop up to 5 PNG/),
  ).toBeVisible();
  await expect(dialog.getByLabel("Add screenshots")).toBeEnabled();
  await dialog.getByLabel("Add screenshots").setInputFiles(
    join(process.cwd(), "build", "trayTemplate.png"),
  );
  await expect(dialog.getByRole("button", { name: "Remove trayTemplate.png" })).toBeVisible();

  await fill(dashboard, "Bug", "Something visual went wrong", "The screenshot shows the state.");
  await expect.poll(() => previewAttachmentIds.at(-1)?.length ?? 0).toBe(1);
  const uploadId = previewAttachmentIds.at(-1)![0]!;
  expect(uploadId).toMatch(/^[A-Za-z0-9._-]+\.png$/);

  if (process.env.MC_E2E_EVIDENCE === "1") {
    const evidenceDir = join(process.cwd(), "e2e", ".artifacts", "product-issue-attachments");
    mkdirSync(evidenceDir, { recursive: true });
    await dialog.getByRole("region", { name: "Screenshots" }).scrollIntoViewIfNeeded();
    await dialog.screenshot({ path: join(evidenceDir, "screenshot-ready-to-publish.png") });
  }

  await publish(dashboard);
  await expect(form(dashboard).getByRole("link", { name: "View GitHub issue" })).toBeVisible();

  await expect.poll(() => productCreates(daemon).length).toBe(1);
  const record = productCreates(daemon)[0]!;
  const attachmentPaths = record.argv.filter((_value, index) => record.argv[index - 1] === "--attach");
  expect(attachmentPaths).toHaveLength(1);
  expect(attachmentPaths[0]).toContain(`${daemon.home}/uploads/`);
  expect(attachmentPaths[0]).toContain(uploadId);
  expect(record.argv).not.toContain(uploadId);
});

test("gh older than 2.99 keeps text reports available but disables screenshots", async ({
  dashboard,
  daemon,
}) => {
  script(daemon, { preflight: "gh-version", issueCreate: "created" });
  await openFromTopbar(dashboard);
  const dialog = form(dashboard);
  await expect(dialog.getByText(/Screenshot upload requires GitHub CLI 2\.99\.0 or newer/)).toBeVisible();
  await expect(dialog.getByText(/still submit a text-only report/)).toBeVisible();
  await expect(dialog.getByLabel("Add screenshots")).toBeDisabled();

  await fill(dashboard, "Documentation", "Text report on older gh", "No screenshot is needed.");
  await publish(dashboard);
  await expect(dialog.getByRole("link", { name: "View GitHub issue" })).toBeVisible();
  await expect.poll(() => productCreates(daemon).length).toBe(1);
  expect(productCreates(daemon)[0]!.argv).not.toContain("--attach");
});

test("a partial upload is reported as a created issue with a screenshot warning", async ({
  dashboard,
  daemon,
}) => {
  script(daemon, { preflight: "ok", issueCreate: "partial" });
  await openFromTopbar(dashboard);
  const dialog = form(dashboard);
  await expect(dialog.getByLabel("Add screenshots")).toBeEnabled();
  await dialog.getByLabel("Add screenshots").setInputFiles(
    join(process.cwd(), "build", "trayTemplate.png"),
  );
  await expect(dialog.getByRole("button", { name: "Remove trayTemplate.png" })).toBeVisible();
  await fill(dashboard, "Bug", "One screenshot failed", "The issue still exists.");
  await publish(dashboard);

  await expect(dialog.getByRole("link", { name: "View GitHub issue" })).toBeVisible();
  await expect(dialog.getByText(/one or more screenshots were not attached/)).toBeVisible();
  await expect.poll(() => productCreates(daemon).length).toBe(1);
});

test("an attachment failure without the target issue URL blocks a duplicate retry", async ({
  dashboard,
  daemon,
}) => {
  script(daemon, { preflight: "ok", issueCreate: "partial-no-url" });
  await openFromTopbar(dashboard);
  const dialog = form(dashboard);
  await expect(dialog.getByLabel("Add screenshots")).toBeEnabled();
  await dialog.getByLabel("Add screenshots").setInputFiles(
    join(process.cwd(), "build", "trayTemplate.png"),
  );
  await expect(dialog.getByRole("button", { name: "Remove trayTemplate.png" })).toBeVisible();
  await fill(dashboard, "Bug", "Attachment outcome is uncertain", "Do not file this twice.");
  await publish(dashboard);

  await expect(dialog.getByRole("alert")).toContainText(/issue may exist/i);
  await expect(dialog.getByText(/check GitHub before retrying/i)).toBeVisible();
  await expect(submit(dashboard)).toBeDisabled();
  await expect.poll(() => productCreates(daemon).length).toBe(1);
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
  await form(dashboard).locator("footer").getByRole("button", { name: "Close", exact: true }).click();

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
  await expect(form(dashboard).getByText(/still submit a text-only report/)).toHaveCount(0);
  await expect(submit(dashboard)).toBeDisabled();
  await dashboard.getByRole("button", { name: "Close feedback form", exact: true }).click();

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
