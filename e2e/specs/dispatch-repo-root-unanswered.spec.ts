import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * A dispatch whose `git rev-parse` is stopped tells the operator Mission Control could not
 * tell, not that their checkout is "not a git repository".
 *
 * The daemon's git is a pass-through that kills itself for exactly one call: `rev-parse
 * --show-toplevel` run against a checkout carrying the marker below. Every other git call the
 * daemon makes reaches real git untouched, so the refusal under test is the only thing the
 * marker changes. A killed git is the same `outcomeUnknown` a stall past the 15s limit gives,
 * without spending that limit.
 */

const MARKER = "mc-e2e-rev-parse-dies";
const EVIDENCE = artifactsDir("dispatch-repo-root-unanswered");

const binDir = mkdtempSync(join(tmpdir(), "mc-e2e-git-dies-"));
const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const fakeGit = join(binDir, "git");
writeFileSync(
  fakeGit,
  [
    "#!/bin/sh",
    `if [ "$1" = "-C" ] && [ -e "$2/.git/${MARKER}" ] && [ "$3" = "rev-parse" ] && [ "$4" = "--show-toplevel" ]; then`,
    "  kill -9 $$",
    "fi",
    `exec '${realGit.replaceAll("'", "'\\''")}' "$@"`,
    "",
  ].join("\n"),
);
chmodSync(fakeGit, 0o755);

test.use({ daemonEnv: { MISSION_GIT_BIN: fakeGit } });
test.afterAll(() => rmSync(binDir, { recursive: true, force: true }));

test("a stopped rev-parse refuses the dispatch as 'could not tell', not 'not a git repository'", async ({
  dashboard,
  daemon,
}) => {
  // A real repository, outside the scanned workspace so only this dispatch asks git about it.
  const checkout = join(daemon.home, "stalled-checkout");
  mkdirSync(checkout, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", checkout], { stdio: "pipe" });
  writeFileSync(join(checkout, ".git", MARKER), "");

  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(checkout);
  // The repo combobox portals its listbox over the fields below; close it before the next fill.
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("check the repository probe");
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Add to backlog" }).click();

  const refusal = dialog.locator(".dispatch-error");
  await expect(refusal).toContainText(`could not tell whether ${checkout} is a git repository`);
  await expect(refusal).toContainText("`git rev-parse --show-toplevel` was stopped before it answered");
  await expect(refusal).toContainText("Try again.");
  await expect(dialog.getByText(/not a git repository/)).toHaveCount(0);
  await expect(dialog).toBeVisible();

  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await dialog.screenshot({ path: `${EVIDENCE}could-not-tell.png` });
    // oxlint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/dispatch-repo-root-unanswered/could-not-tell.png");
  }
});
