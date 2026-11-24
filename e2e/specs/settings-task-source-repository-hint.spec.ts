import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { recordsIn } from "../fixtures/records.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * What a GitHub issues source's blank Repository resolves to, shown under the field.
 *
 * A blank Repository used to leave the repository to `gh`, which prefers a remote called
 * `upstream`: on a fork, the parent, and an organization enforcing SAML SSO refuses it. The
 * daemon now resolves it itself - the gh default pin, else `origin` - and the editor says what
 * that resolved to. `test/github-issues-repository.test.ts` pins the resolution and the argv;
 * only this layer connects the view route's read-only field to the text under the input, and
 * that text to the `--repo` a sweep actually runs with.
 *
 * The fixture checkout gets an `upstream` beside its GitHub `origin`, which is the fork shape,
 * so saving the source also pins gh's default repository to `origin` for bare `gh` calls
 * (`test/gh-default-pin.test.ts` pins when). That pin names origin's own repository, so the
 * hint still says "(from origin)". Nothing reaches GitHub: `MISSION_GH_BIN` points every `gh` call at `FAKE_GH`, which records
 * its argv. No agent is dispatched.
 */

const ORIGIN = "mc-e2e-fixture/demo-repo";
const UPSTREAM = "mc-e2e-upstream/demo-repo";
const EVIDENCE = artifactsDir("task-source-repository-hint");

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/task-source-repository-hint/${name}.png`);
}

/** The `--repo` of every `gh issue list` the daemon has run so far, in order. */
function listedRepos(daemon: DaemonHandle): string[] {
  return recordsIn<{ argv: string[] }>(daemon.recordDir, (f) => f.startsWith("gh-"))
    .filter((r) => r.argv[0] === "issue" && r.argv[1] === "list")
    .map((r) => r.argv[r.argv.indexOf("--repo") + 1]!);
}

/** A git config value in the fixture checkout, or null when it is unset. */
function gitConfig(daemon: DaemonHandle, key: string): string | null {
  try {
    return execFileSync("git", ["-C", daemon.repo, "config", "--get", key]).toString().trim();
  } catch {
    return null;
  }
}

/** The stored config of the one source, as the daemon holds it. */
async function storedConfig(page: Page, daemon: DaemonHandle): Promise<Record<string, unknown>> {
  const res = await page.request.get(`${daemon.baseURL}/api/task-sources/config`);
  const body = (await res.json()) as { sources?: { config?: Record<string, unknown> }[] };
  return body.sources?.[0]?.config ?? {};
}

test("a blank Repository shows what it resolves to, and the sweep names that repository", async ({
  page,
  daemon,
}) => {
  execFileSync("git", ["-C", daemon.repo, "remote", "add", "upstream", `https://github.com/${UPSTREAM}.git`]);

  await page.goto(`${daemon.baseURL}/#/settings/task-sources`);
  await page.getByRole("button", { name: "Add source" }).click();
  await page.getByRole("combobox", { name: "What kind of source to add" }).selectOption("github-issues");
  await page.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  expect(gitConfig(daemon, "remote.origin.gh-resolved")).toBeNull();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  // Saving the source pinned gh's default to origin, and only origin.
  await expect.poll(() => gitConfig(daemon, "remote.origin.gh-resolved")).toBe("base");
  expect(gitConfig(daemon, "remote.upstream.gh-resolved")).toBeNull();

  const repository = page.getByLabel("Repository (optional)");
  await expect(repository).toHaveValue("");
  const fromOrigin = `Resolves to ${ORIGIN} (from origin)`;
  // Origin, not the `upstream` gh itself would have picked, and still origin with the pin.
  await expect(repository).toHaveAccessibleDescription(fromOrigin);
  await expect(page.getByText(fromOrigin)).toBeVisible();
  await shoot(page, "01-blank-resolves-to-origin");

  // The hint is what the sweep names.
  await page.getByRole("button", { name: "Sweep now" }).click();
  await expect(page.getByText(/Swept: filed 0/)).toBeVisible();
  expect(listedRepos(daemon)).toEqual([ORIGIN]);

  // A filled-in Repository shows nothing extra, from the first keystroke and once it is saved.
  await repository.fill("acme/chosen");
  await expect(page.getByText(fromOrigin)).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect.poll(() => storedConfig(page, daemon)).toMatchObject({ repo: "acme/chosen" });
  await expect(page.getByText(/^Resolves to /)).toHaveCount(0);
  await expect(repository).toHaveAccessibleDescription("");

  // Cleared and saved again: still blank in storage, and the hint is back after the save.
  await repository.fill("");
  await page.keyboard.press("Tab");
  await expect.poll(() => storedConfig(page, daemon)).toMatchObject({ repo: "" });
  await expect(repository).toHaveAccessibleDescription(fromOrigin);
  // A fresh page reads it from the daemon's view, not from component state.
  await page.reload();
  await expect(page.getByLabel("Repository (optional)")).toHaveAccessibleDescription(fromOrigin);
  await shoot(page, "02-after-save-still-origin");

  // The operator moves gh's default to `upstream`, as `gh repo set-default` does: unset the
  // pin, then set the new one. Nothing is stored on the source, so the next view resolves the
  // pin, and the hint names it as the gh default.
  execFileSync("git", ["-C", daemon.repo, "config", "--unset", "remote.origin.gh-resolved"]);
  execFileSync("git", ["-C", daemon.repo, "config", "remote.upstream.gh-resolved", "base"]);
  const fromPin = `Resolves to ${UPSTREAM} (from gh default)`;
  await expect(page.getByText(fromPin)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel("Repository (optional)")).toHaveAccessibleDescription(fromPin);
  await shoot(page, "03-pin-on-upstream-from-gh-default");

  await page.getByRole("button", { name: "Sweep now" }).click();
  await expect.poll(() => listedRepos(daemon)).toEqual([ORIGIN, UPSTREAM]);
  // The operator's pin is never overwritten, by that sweep or by another save.
  await page.getByLabel("Repository (optional)").fill("acme/chosen");
  await page.keyboard.press("Tab");
  await expect.poll(() => storedConfig(page, daemon)).toMatchObject({ repo: "acme/chosen" });
  expect(gitConfig(daemon, "remote.origin.gh-resolved")).toBeNull();
  expect(gitConfig(daemon, "remote.upstream.gh-resolved")).toBe("base");
});
