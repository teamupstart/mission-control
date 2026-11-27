import { expect, type Page } from "@playwright/test";
import type { DaemonHandle } from "./daemon.ts";

/** Read the revision for an initial task-source replacement in an isolated daemon. */
export async function taskSourcesRevision(page: Page, daemon: DaemonHandle): Promise<string> {
  const response = await page.request.get(`${daemon.baseURL}/api/task-sources/config`);
  expect(response.ok()).toBe(true);
  return (await response.json()).revision;
}
