import { join } from "node:path";
import { recordsIn } from "../fixtures/records.ts";
import { expect, test } from "../fixtures/test.ts";

test.use({ daemonEnv: { MC_E2E_BACKGROUND_EFFORT: "1" } });

test("background reasoning effort follows the preview and reaches the next model call", async ({
  dashboard,
  context,
  daemon,
}) => {
  const models = await context.newPage();
  await models.goto(`${daemon.baseURL}/#/settings/models`);
  const provider = models.getByRole("combobox", { name: "Task title provider" });
  const title = models.getByRole("combobox", { name: "Task title effort" });
  const review = models.getByRole("combobox", { name: "Foreman Review effort" });
  const verify = models.getByRole("combobox", { name: "Foreman Verify effort" });
  const inspector = models.getByRole("combobox", { name: "Inspector Review effort" });
  await expect(provider).toBeEnabled();
  await expect(title).toHaveCount(0);

  const putConfig = (group: string, data: Record<string, unknown>) => models.request.put(
    `${daemon.baseURL}/api/${group}/config`, { data },
  );
  expect((await putConfig("llm", { efforts: { "task-title": "high" } })).status()).toBe(404);
  expect((await putConfig("foreman", { efforts: { review: "high" } })).status()).toBe(404);
  expect((await putConfig("inspector", { effort: "high" })).status()).toBe(404);

  await dashboard.goto(`${daemon.baseURL}/#/settings/feature-flags`);
  const preview = dashboard.getByRole("button", { name: /^Background reasoning effort:/ });
  await expect(preview).toHaveAttribute("aria-pressed", "false");
  await preview.click();
  await expect(title).toBeEnabled();
  await expect(models.getByRole("columnheader", { name: "Reasoning effort" })).toHaveCount(3);
  for (const control of [title, review, verify]) {
    await expect(control).toHaveValue("");
    await expect(control.getByRole("option", { name: "Provider default" })).toHaveCount(1);
  }
  // Nobody has chosen an Inspector effort yet, so the control shows what a review runs at.
  await expect(inspector).toHaveValue("xhigh");
  await expect(inspector.getByRole("option", { name: "Provider default" })).toHaveCount(1);

  const stored = async (group: string) => (await models.request.get(
    `${daemon.baseURL}/api/${group}/config`,
  )).json();
  await provider.selectOption("codex");
  await expect.poll(async () => (await stored("llm")).runners["task-title"]).toBe("codex");
  await title.selectOption("high");
  await expect.poll(async () => (await stored("llm")).efforts?.["task-title"]).toBe("high");

  await review.selectOption("high");
  await verify.selectOption("low");
  await inspector.selectOption("medium");
  await expect.poll(async () => (await stored("foreman")).efforts).toEqual({ review: "high", verify: "low" });
  await expect.poll(async () => (await stored("inspector")).effort).toBe("medium");
  await models.reload();
  await expect(title).toHaveValue("high");
  await expect(review).toHaveValue("high");
  await expect(verify).toHaveValue("low");
  await expect(inspector).toHaveValue("medium");

  // Provider default is a choice of its own: it is stored, and it survives a reload instead
  // of falling back to the review default.
  await inspector.selectOption("");
  await expect.poll(async () => (await stored("inspector")).effort).toBe(null);
  await models.reload();
  await expect(inspector).toHaveValue("");

  const titleCalls = () => recordsIn<{ argv: string[] }>(
    join(daemon.recordDir, "codex"), (file) => file.startsWith("invocation-"),
  ).filter(({ argv }) => argv[0] === "exec");
  const queueUntitledTask = async () => {
    const response = await models.request.post(`${daemon.baseURL}/api/tasks`, {
      data: { repoRoot: daemon.repo, intent: "Verify reasoning on this new work item", backlog: true, workflowId: null },
    });
    expect(response.ok()).toBe(true);
  };
  await queueUntitledTask();
  await expect.poll(() => titleCalls().length).toBe(1);
  expect(titleCalls()[0].argv).toContain("model_reasoning_effort=high");

  await preview.click();
  await expect(title).toHaveCount(0);
  expect((await stored("llm")).efforts["task-title"]).toBe("high");
  await queueUntitledTask();
  await expect.poll(() => titleCalls().length).toBe(2);
  expect(titleCalls()[1].argv.some((arg) => arg.startsWith("model_reasoning_effort="))).toBe(false);

  await preview.click();
  await expect(title).toHaveValue("high");
  await title.selectOption("");
  await expect.poll(async () => (await stored("llm")).efforts?.["task-title"]).toBe(null);
  await queueUntitledTask();
  await expect.poll(() => titleCalls().length).toBe(3);
  expect(titleCalls()[2].argv.some((arg) => arg.startsWith("model_reasoning_effort="))).toBe(false);
});
