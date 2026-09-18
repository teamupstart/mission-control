import { mkdirSync } from "node:fs";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";

for (const kind of ["jira", "github-issues"] as const) {
  test(`${kind} has a red Delete source footer button that removes only the selected source`, async ({
    page,
    daemon,
  }) => {
    const label = kind === "jira" ? "Jira triage" : "GitHub bugs";
    const seeded = await page.request.put(`${daemon.baseURL}/api/task-sources/config`, {
      data: {
        sources: [
          { id: "delete-me", kind, label, repoRoot: daemon.repo },
          { id: "keep-me", kind, label: "Keep this source", repoRoot: daemon.repo },
        ],
      },
    });
    expect(seeded.ok(), await seeded.text()).toBe(true);

    await page.goto(`${daemon.baseURL}/#/settings/task-sources`);
    const directory = page.getByRole("list", { name: "Configured task sources" });
    await directory.getByRole("button", { name: label }).click();
    await expect(page.getByLabel("What to call this source")).toHaveValue(label);

    const footer = page.locator(".ts-card-actions");
    const remove = footer.getByRole("button", { name: `Delete source: ${label}` });
    await expect(remove).toHaveText("Delete source");
    await expect(remove).toHaveCSS("background-color", "rgb(200, 53, 44)");
    await expect(page.locator(".ts-head").getByRole("button")).toHaveCount(0);
    await remove.scrollIntoViewIfNeeded();
    await expect(remove).toBeInViewport();
    await expect(footer.getByRole("button", { name: "Sweep now" })).toBeInViewport();
    await expect(footer.getByRole("button", { name: "Check it works" })).toBeInViewport();
    await expect(footer.getByRole("button", { name: "Forget seen items" })).toBeInViewport();

    if (process.env.MC_E2E_EVIDENCE) {
      const evidence = artifactsDir("task-source-delete");
      mkdirSync(evidence, { recursive: true });
      await page.mouse.move(0, 0);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.screenshot({ path: `${evidence}${kind}-footer.png` });
    }

    // Exercise both pointer and keyboard activation against the real configuration route.
    if (kind === "jira") {
      await remove.click();
    } else {
      await remove.focus();
      await page.keyboard.press("Enter");
    }
    await expect(directory.getByRole("button", { name: label })).toHaveCount(0);
    await expect(directory.getByRole("button", { name: "Keep this source" })).toBeVisible();
    await expect.poll(async () => {
      const response = await page.request.get(`${daemon.baseURL}/api/task-sources/config`);
      const config = await response.json() as { sources: { id: string }[] };
      return config.sources.map((source) => source.id);
    }).toEqual(["keep-me"]);

    await page.reload();
    await expect(directory.getByRole("button")).toHaveCount(1);
    await expect(page.getByLabel("What to call this source")).toHaveValue("Keep this source");
    await page.getByRole("button", { name: "Delete source: Keep this source" }).click();
    await expect(page.getByText("No sources yet - nothing is being swept.", { exact: false })).toBeVisible();
    await expect.poll(async () => {
      const response = await page.request.get(`${daemon.baseURL}/api/task-sources/config`);
      const config = await response.json() as { sources: unknown[] };
      return config.sources;
    }).toEqual([]);
    await page.reload();
    await expect(page.getByText("No sources yet - nothing is being swept.", { exact: false })).toBeVisible();
  });
}
