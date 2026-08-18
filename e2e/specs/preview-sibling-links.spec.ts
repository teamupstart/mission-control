import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const EVIDENCE = artifactsDir("preview-sibling-links");

/**
 * Photograph the state the fix bought, on the same run whose assertions proved it.
 * Behind `MC_E2E_EVIDENCE` like every other capture: an ordinary run would rewrite a
 * binary for no added signal. Same `OBSERVED` / `CAPTURED` vocabulary as the rest.
 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/preview-sibling-links/${name}.png`);
}

function observed(what: string): void {
  if (!process.env.MC_E2E_EVIDENCE) return;
  // eslint-disable-next-line no-console
  console.log(`OBSERVED ${what}`);
}

/**
 * Links between checkout HTML files, followed INSIDE the preview.
 *
 * The HTML preview is a sandboxed srcdoc iframe, and a srcdoc document resolves
 * relative hrefs against the dashboard's own URL. Before this seam was covered,
 * clicking `<a href="b.html">` navigated the iframe to `<daemon>/b.html`, the SPA
 * fallback answered with the dashboard shell, and the sandbox's opaque origin
 * CORS-blocked every asset that shell needs - a white pane, reproducible on any
 * multi-page mockup. Only a browser can assert this: the click starts in a
 * cross-origin frame, the claim crosses a postMessage bridge, and the proof is the
 * sibling document rendering where the white pane used to be.
 */

const TASK = "follow a sibling link in the html preview";

const ALPHA_HTML = `<!doctype html>
<html><body>
  <h1>Mock page alpha</h1>
  <a href="b.html">Continue to beta</a>
  <a href="https://example.com/">External site</a>
  <a href="#100%">Jump to target</a>
  <div style="height: 2000px"></div>
  <h2 id="100%">Fragment target</h2>
</body></html>
`;

const BETA_HTML = `<!doctype html>
<html><body>
  <h1>Mock page beta</h1>
  <a href="a.html">Back to alpha</a>
</body></html>
`;

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the Task field and reopens on every
  // keystroke; without this the next fill lands on a covered control.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");

  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/** See diff-open-in-files.spec.ts - the Files TAB lives in the Console layout. */
async function useConsoleLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "console" }),
  });
  const body = (await response.json()) as { config?: { layout?: string } };
  expect(body.config?.layout, "the daemon accepted the Console layout").toBe("console");
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Sessions" })).toBeVisible();
}

async function sessionCwd(daemon: DaemonHandle): Promise<string> {
  await expect
    .poll(async () => {
      const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as {
        cwd: string | null;
      }[];
      return sessions[0]?.cwd ?? null;
    }, { message: "the dispatched session never reported a working directory" })
    .not.toBeNull();

  const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as {
    cwd: string | null;
  }[];
  return sessions[0]!.cwd!;
}

/** Dispatch, seed the two-page mockup, and land on its rendered alpha preview. */
async function openAlphaPreview(page: Page, daemon: DaemonHandle): Promise<void> {
  await dispatch(page, daemon);
  const cwd = await sessionCwd(daemon);

  // In a subdirectory on purpose: `href="b.html"` must resolve against the DOCUMENT's
  // directory, and files at the checkout root would pass even with that base wrong.
  mkdirSync(join(cwd, "docs"), { recursive: true });
  writeFileSync(join(cwd, "docs", "a.html"), ALPHA_HTML);
  writeFileSync(join(cwd, "docs", "b.html"), BETA_HTML);

  await useConsoleLayout(page, daemon);

  await page
    .getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: /Follow a Sibling Link/i })
    .click();
  await page
    .getByRole("tablist", { name: "Session detail" })
    .getByRole("tab", { name: /Files$/ })
    .click();

  await page
    .getByRole("listbox", { name: "Session files" })
    .getByRole("option", { name: "docs/a.html" })
    .click();
  await expect(
    page.frameLocator('iframe[title="Preview of docs/a.html"]').getByRole("heading", {
      name: "Mock page alpha",
    }),
  ).toBeVisible();
}

test("a sibling link inside the HTML preview opens that file in the preview", async ({
  dashboard,
  daemon,
}) => {
  await openAlphaPreview(dashboard, daemon);

  await dashboard
    .frameLocator('iframe[title="Preview of docs/a.html"]')
    .getByRole("link", { name: "Continue to beta" })
    .click();

  // The sibling rendered where the white pane used to be...
  await expect(
    dashboard.frameLocator('iframe[title="Preview of docs/b.html"]').getByRole("heading", {
      name: "Mock page beta",
    }),
  ).toBeVisible();
  // ...and the workspace followed: this is a real file selection, not an iframe drifting
  // away from the toolbar that describes it.
  await expect(
    dashboard
      .getByRole("listbox", { name: "Session files" })
      .getByRole("option", { name: "docs/b.html" }),
  ).toHaveAttribute("aria-selected", "true");
  observed('clicking "Continue to beta" inside the sandboxed preview rendered docs/b.html, and the file list selection followed');
  await shoot(dashboard, "preview-sibling-link");

  // And back, because a one-way bridge would strand every mockup's "all six" index link.
  await dashboard
    .frameLocator('iframe[title="Preview of docs/b.html"]')
    .getByRole("link", { name: "Back to alpha" })
    .click();
  await expect(
    dashboard.frameLocator('iframe[title="Preview of docs/a.html"]').getByRole("heading", {
      name: "Mock page alpha",
    }),
  ).toBeVisible();
});

test("an external link cannot navigate the preview away", async ({ dashboard, daemon }) => {
  await openAlphaPreview(dashboard, daemon);
  const alpha = dashboard.frameLocator('iframe[title="Preview of docs/a.html"]');

  await alpha.getByRole("link", { name: "External site" }).click();

  // The document the click happened in is still the one on screen - not example.com,
  // not the SPA fallback's white pane. Proving the frame is still OURS and still live
  // takes more than a visibility re-check, which could pass during a slow navigation:
  // the same document's sibling link must still work afterwards.
  await expect(alpha.getByRole("heading", { name: "Mock page alpha" })).toBeVisible();
  await alpha.getByRole("link", { name: "Continue to beta" }).click();
  await expect(
    dashboard.frameLocator('iframe[title="Preview of docs/b.html"]').getByRole("heading", {
      name: "Mock page beta",
    }),
  ).toBeVisible();
});

test("a same-document fragment link scrolls to and keeps rendering its target", async ({
  dashboard,
  daemon,
}) => {
  await openAlphaPreview(dashboard, daemon);
  const alpha = dashboard.frameLocator('iframe[title="Preview of docs/a.html"]');

  await alpha.getByRole("link", { name: "Jump to target" }).click();

  await expect(alpha.getByRole("heading", { name: "Fragment target" })).toBeInViewport();
  await shoot(dashboard, "preview-fragment-target");
});
