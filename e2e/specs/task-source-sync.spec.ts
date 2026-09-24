import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { Locator, Page } from "@playwright/test";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import type { Task } from "../../src/shared/types.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

const original = { number: 17, title: "Imported issue", body: "Original remote description",
  url: "https://github.com/acme/demo/issues/17", labels: [{name:"triage"}], discoverable: true };
function upstream(daemon: DaemonHandle, patch: Partial<typeof original> = {}) {
  writeFileSync(daemon.ghIssuesPath, JSON.stringify([{...original,...patch}]));
}
async function sweep(page: Page) {
  const response = page.waitForResponse(r => r.url().endsWith("/s/sweep") && r.request().method()==="POST");
  await page.getByRole("button",{name:"Sweep now",exact:true}).click();
  expect((await response).ok()).toBe(true);
  return (await response).json();
}
async function tasks(page: Page, daemon: DaemonHandle): Promise<Task[]> {
  return (await page.request.get(`${daemon.baseURL}/api/tasks`)).json();
}
async function configure(page: Page, daemon: DaemonHandle) {
  upstream(daemon);
  const res = await page.request.put(`${daemon.baseURL}/api/task-sources/config`,{data:{sources:[{
    id:"s",kind:"github-issues",label:"Sync test issues",repoRoot:daemon.repo,enabled:false,config:{repo:"acme/demo"},
  }]}});
  expect(res.ok()).toBe(true);
  await page.goto(`${daemon.baseURL}/#/settings/task-sources`);
  await expect(page.getByRole("checkbox",{name:"Keep imported backlog tasks updated"})).not.toBeChecked();
}
async function enable(page: Page, daemon: DaemonHandle) {
  await page.getByRole("checkbox",{name:"Keep imported backlog tasks updated"}).check();
  await expect.poll(async()=> (await (await page.request.get(`${daemon.baseURL}/api/task-sources/config`)).json()).sources[0].keepUpdated).toBe(true);
}

test("imported update setting matches the backlog autopilot typography and card", async ({ page, daemon }) => {
  await configure(page, daemon);
  const updates = page.getByRole("checkbox", { name: "Keep imported backlog tasks updated", exact: true });
  const autopilot = page.getByRole("checkbox", { name: "Allow backlog autopilot to schedule swept tasks" });
  const updateCard = page.locator("label").filter({ has: updates });
  const autopilotCard = page.locator("label").filter({ has: autopilot });
  const style = (locator: Locator, properties: string[]) => locator.evaluate((node, keys) => {
    const computed = getComputedStyle(node);
    return Object.fromEntries(keys.map((key) => [key, computed.getPropertyValue(key)]));
  }, properties);
  const textProperties = ["font-family", "font-size", "font-weight", "line-height", "color"];
  expect(await style(page.getByText("Keep imported backlog tasks updated", { exact: true }), textProperties))
    .toEqual(await style(page.getByText("Allow backlog autopilot", { exact: true }), textProperties));
  const description = updateCard.getByText(/On each sweep, refresh imported details/);
  await expect(description).toBeVisible();
  expect(await style(description, textProperties))
    .toEqual(await style(autopilotCard.getByText(/On, Foreman may schedule tasks/), textProperties));
  const cardProperties = ["padding", "border-width", "border-style", "border-color", "border-radius", "background-color", "gap", "align-items"];
  for (const checked of [false, true]) {
    await updates.setChecked(checked);
    await autopilot.setChecked(checked);
    await page.mouse.move(0, 0);
    await expect(async () => {
      expect(await style(updateCard, cardProperties)).toEqual(await style(autopilotCard, cardProperties));
    }).toPass();
  }
  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("task-source-sync"); mkdirSync(dir, { recursive: true });
    await updates.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${dir}matching-settings-cards.png` });
  }
});

test("source updates preserve task identity, arrive over SSE, and resolve local conflicts",async({page,context,daemon})=>{
  await configure(page,daemon);
  const updates = page.getByRole("checkbox", { name: "Keep imported backlog tasks updated" });
  const updateDescription = "Refresh imported details on each sweep while tasks have not started";
  await expect(updates).toHaveAccessibleDescription(updateDescription);
  await updates.hover();
  await expect(page.locator(".tooltip")).toHaveText(updateDescription);
  await page.mouse.move(0, 0);
  await sweep(page);
  const [task] = await tasks(page,daemon); expect(task).toBeTruthy();
  await page.request.put(`${daemon.baseURL}/api/ui/config`,{data:{layout:"board"}});
  const board = await context.newPage(); await board.goto(`${daemon.baseURL}/#/fleet`);
  const title = board.locator("section.board-backlog .bl-title");
  await expect(title).toHaveText("Imported issue");
  upstream(daemon,{title:"Updated remote issue",body:"Updated remote description"});
  await sweep(page); await expect(title).toHaveText("Imported issue");
  await enable(page,daemon);
  await page.reload(); await expect(page.getByRole("checkbox",{name:"Keep imported backlog tasks updated"})).toBeChecked();
  expect((await sweep(page)).sync.updated).toBe(1);
  await expect(title).toHaveText("Updated remote issue");
  expect((await tasks(page,daemon)).map(t=>t.id)).toEqual([task!.id]);

  expect((await page.request.post(`${daemon.baseURL}/api/tasks/${task!.id}/update`,{data:{intent:"Operator's local notes"}})).ok()).toBe(true);
  upstream(daemon,{title:"A new remote brief",body:"A conflicting description",discoverable:false});
  expect((await sweep(page)).sync.conflicted).toBe(1);
  const review = page.getByRole("article",{name:"Source update for acme/demo#17"});
  await expect(review.getByText("Operator's local notes",{exact:true})).toBeVisible();
  await expect(review.getByText(/A conflicting description/)).toBeVisible();
  for (const [name, description] of [
    ["Use source", "Apply the source values shown here and accept this source revision"],
    ["Keep local", "Keep local values and accept this source revision"],
  ] as const) {
    const action = review.getByRole("button", { name, exact: true });
    await expect(action).toHaveAccessibleDescription(description);
    await action.hover();
    await expect(page.locator(".tooltip")).toHaveText(description);
  }
  if(process.env.MC_E2E_EVIDENCE) {
    const dir=artifactsDir("task-source-sync"); mkdirSync(dir,{recursive:true});
    await page.screenshot({path:`${dir}conflict-review-tooltip.png`});
    await review.scrollIntoViewIfNeeded(); await page.mouse.move(0,0);
    await page.screenshot({path:`${dir}conflict-review.png`});
  }
  await review.getByRole("button",{name:"Keep local",exact:true}).click();
  await expect(review).toHaveCount(0);
  expect((await tasks(page,daemon))[0]!.intent).toBe("Operator's local notes");
  expect((await sweep(page)).sync.unchanged).toBe(1);
  upstream(daemon,{title:"Final source title",body:"Another remote update",discoverable:false});
  await sweep(page);
  await review.getByRole("button",{name:"Use source",exact:true}).click();
  await expect(review).toHaveCount(0); await expect(title).toHaveText("Final source title");
  expect((await tasks(page,daemon))[0]!.intent).toContain("Another remote update");

  expect((await page.request.delete(`${daemon.baseURL}/api/tasks/${task!.id}`)).ok()).toBe(true);
  upstream(daemon); await sweep(page);
  await expect(title).toHaveCount(0); expect(await tasks(page,daemon)).toHaveLength(0);
  await board.close();
});

test("scheduled refresh resumes after daemon restart without losing its baseline",async({page,daemon})=>{
  await configure(page,daemon); await sweep(page); await enable(page,daemon);
  const [before]=await tasks(page,daemon);
  upstream(daemon,{title:"Updated after restart",body:"A later revision",discoverable:false});
  const cfg=await (await page.request.get(`${daemon.baseURL}/api/task-sources/config`)).json();
  await page.request.put(`${daemon.baseURL}/api/task-sources/config`,{data:{sources:cfg.sources.map((s:Record<string,unknown>)=>({...s,enabled:true}))}});
  await daemon.crash(); await daemon.restart();
  await expect.poll(async()=> (await tasks(page,daemon))[0]?.title).toBe("Updated after restart");
  expect((await tasks(page,daemon))[0]!.id).toBe(before!.id);
});

test("older imports need adoption and missing source items leave a visible error", async ({ page, daemon }) => {
  await configure(page, daemon);
  await sweep(page);
  const [task] = await tasks(page, daemon);
  // Simulate an import made before content baselines existed.
  withDaemonDb(daemon, (db) => db.prepare("DELETE FROM task_source_sync WHERE task_id = ?").run(task!.id));
  await enable(page, daemon);
  await page.reload();
  await expect(page.getByText(/1 older item needs a sweep before adoption review/)).toBeVisible();
  upstream(daemon, { title: "Changed before adoption" });
  await sweep(page);
  const review = page.getByRole("article", { name: "Source update for acme/demo#17" });
  await expect(review.getByText("Review this older task before enabling updates for it.")).toBeVisible();
  expect((await tasks(page, daemon))[0]!.title).toBe("Imported issue");
  await page.getByRole("checkbox", { name: "Keep imported backlog tasks updated" }).uncheck();
  await expect(review.getByRole("button", { name: "Use source", exact: true })).toBeDisabled();
  await enable(page, daemon);
  await review.getByRole("button", { name: "Use source", exact: true }).click();
  await expect(review).toHaveCount(0);
  expect((await tasks(page, daemon))[0]!.title).toBe("Changed before adoption");
  writeFileSync(daemon.ghIssuesPath, "[]");
  expect((await sweep(page)).sync.skipped).toBe(1);
  await expect(review.locator(".settings-error")).toBeVisible();
  expect((await tasks(page, daemon))[0]!.title).toBe("Changed before adoption");
});
