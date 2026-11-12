import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { writeGhIssueListRefusal } from "../fixtures/fake-agents.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * A GitHub issues source refused by an organization's SAML SSO says so on the source.
 *
 * gh prints the refusal as a raw GraphQL line and puts the authorize link on the line after
 * it, which the source used to drop by keeping the first line. It now names the repository it
 * resolved, the refusing organization, gh's authorize link and what to change - and, when a gh
 * default pin on another remote chose that repository, the pin. `test/github-issues-repository.test.ts`
 * pins the wording on every verb; only this layer shows that sentence is what the card renders.
 *
 * The fixture checkout gets an `upstream` beside its GitHub `origin`, the fork shape. Nothing
 * reaches GitHub: `MISSION_GH_BIN` points every `gh` call at `FAKE_GH`, and every
 * `gh issue list` it answers prints the stderr captured from `teamupstart/mission-control`.
 */

const ORIGIN = "mc-e2e-fixture/demo-repo";
const UPSTREAM = "mc-e2e-upstream/demo-repo";
const AUTHORIZE = "https://github.com/orgs/teamupstart/sso?authorization_request=AAM6F5EXAMPLE";
const GRAPHQL_SSO_STDERR =
  "GraphQL: Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization. (repository)\n" +
  `Authorize in your web browser:  ${AUTHORIZE}\n`;
const REMEDY = "To use your fork instead, set Repository on this source or pin `gh repo set-default`.";
const EVIDENCE = artifactsDir("task-source-sso-refusal");

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/task-source-sso-refusal/${name}.png`);
}

/** The classified sentence for `target` is on the card, and the raw GraphQL line is not. */
async function expectClassified(page: Page, target: string): Promise<void> {
  const refused = `GitHub refused ${target}: the teamupstart organization requires SAML SSO and this gh token is not authorized for it.`;
  const sentence = page.getByText(refused, { exact: false }).last();
  await expect(sentence).toBeVisible();
  await expect(sentence).toContainText(`Authorize: ${AUTHORIZE}.`);
  await expect(sentence).toContainText(REMEDY);
  await expect(page.getByText("GraphQL:", { exact: false })).toHaveCount(0);
  await sentence.scrollIntoViewIfNeeded();
}

test("a source refused by SAML SSO shows the classified message, not the raw GraphQL line", async ({
  page,
  daemon,
}) => {
  execFileSync("git", ["-C", daemon.repo, "remote", "add", "upstream", `https://github.com/${UPSTREAM}.git`]);
  writeGhIssueListRefusal(daemon.home, GRAPHQL_SSO_STDERR);

  await page.goto(`${daemon.baseURL}/#/settings/task-sources`);
  await page.getByRole("button", { name: "Add source" }).click();
  await page.getByRole("combobox", { name: "What kind of source to add" }).selectOption("github-issues");
  await page.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByLabel("Repository (optional)")).toHaveAccessibleDescription(
    `Resolves to ${ORIGIN} (from origin)`,
  );

  // The preflight names origin's repository, which the blank Repository resolved to.
  await page.getByRole("button", { name: "Check it works" }).click();
  await expectClassified(page, ORIGIN);
  await shoot(page, "01-preflight-names-origin");

  // The operator pins gh's default on `upstream`, as `gh repo set-default` does. The sweep now
  // reaches the parent, and the message names the pin that sent it there.
  execFileSync("git", ["-C", daemon.repo, "config", "--unset", "remote.origin.gh-resolved"]);
  execFileSync("git", ["-C", daemon.repo, "config", "remote.upstream.gh-resolved", "base"]);
  await page.getByRole("button", { name: "Sweep now" }).click();
  await expectClassified(page, `${UPSTREAM} (this checkout's gh default pin, not origin)`);
  await shoot(page, "02-sweep-names-the-gh-default-pin");
});
