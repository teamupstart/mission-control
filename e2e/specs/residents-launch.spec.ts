import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { settled } from "../fixtures/settle.ts";

// A resident authored on #/residents, launched from Dispatch > Resident with the fake agents,
// carrying its persona as standing instructions, and ended by Complete & close. No model
// tokens are spent: every agent binary is the fake from `fixtures/fake-agents.ts`.

const PERSONA = "Code Risk Reviewer";
const PROFILE = "Triage Bot";
const PROFILE_BRIEF = "Summarize blockers before anything else.";
const RUN_BRIEF = "Focus on the release branch today.";
const EVIDENCE = artifactsDir("residents");

/** Behind `MC_E2E_EVIDENCE`, like every other spec's capture: an ordinary run writes nothing. */
async function capture(target: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
}

async function api<T>(daemon: DaemonHandle, path: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`);
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

function options(select: Locator): Promise<string[]> {
  return select.evaluate((element) =>
    [...(element as HTMLSelectElement).options].map((option) => option.value),
  );
}

async function authorProfile(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.goto(`${daemon.baseURL}/#/residents`);
  const rail = page.getByRole("complementary", { name: "Resident profiles" });
  await expect(rail).toContainText("No resident profiles yet");
  await rail.getByRole("button", { name: "New" }).click();

  const editor = page.getByRole("region", { name: "New resident profile" });
  await expect(editor.getByRole("button", { name: "Save" })).toBeDisabled();
  await editor.getByLabel("Name").fill(PROFILE);
  const persona = editor.getByRole("combobox", { name: "Persona" });
  await persona.selectOption({ label: `${PERSONA} · built-in` });
  await editor.getByLabel("Profile instructions").fill(PROFILE_BRIEF);
  // Pi is not offered: residents run on Claude Code or Codex only.
  expect(await options(editor.getByRole("combobox", { name: "Harness" }))).toEqual(["claude", "codex"]);
  await editor.getByLabel("Default repository").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await editor.getByRole("button", { name: "Save" }).click();

  await expect(rail.getByRole("button", { name: new RegExp(PROFILE) })).toHaveAttribute("aria-current", "true");
  await expect(page).toHaveURL(/#\/residents\/(?!new$)[^/]+$/);
  await expect(page.getByRole("region", { name: `Resident profile ${PROFILE}` })).toContainText("Revision 1");
  await capture(page.locator("main.residents-page"), "residents-page");
}

test("a resident authored on #/residents launches from Dispatch > Resident with its persona, and ends on Complete & close", async ({
  dashboard,
  daemon,
}) => {
  await authorProfile(dashboard, daemon);

  // The page's Launch opens Dispatch in Resident mode on this profile, its repository filled in.
  await dashboard.getByRole("region", { name: `Resident profile ${PROFILE}` })
    .getByRole("button", { name: "Launch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog.getByRole("radio", { name: "Resident" })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByRole("radio", { name: new RegExp(PROFILE) })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByLabel("Repository")).toHaveValue(daemon.repo);
  await expect(dialog).toContainText(`persona ${PERSONA}`);
  await expect(dialog).toContainText("profile instructions");
  await expect(dialog.getByRole("button", { name: "Edit profile" })).toBeVisible();
  await dialog.getByLabel("Instructions for this run").fill(RUN_BRIEF);
  await expectContentClearsBorder(dialog);
  await capture(dialog, "dispatch-resident-mode");

  await dialog.getByRole("button", { name: "Launch resident" }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });

  // The launch is a `resident` task on the profile's harness, with no after-work Workflow.
  let task: { id: string; kind: string; agent: string; status: string; workflowId: string | null; sessionId: string | null } | null = null;
  await expect.poll(async () => {
    task = (await api<NonNullable<typeof task>[]>(daemon, "/api/tasks")).find((t) => t.kind === "resident") ?? null;
    return task?.status ?? null;
  }, { timeout: 60_000 }).toBe("running");
  if (!task) throw new Error("the resident task did not appear");
  expect(task).toMatchObject({ kind: "resident", agent: "claude", workflowId: null });

  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  await expect(card).toBeVisible();
  await expect(card.getByText("resident", { exact: true })).toBeVisible();
  // A resident stays in the Agent SDK: Continue in terminal is not offered.
  await expect(card.getByRole("button", { name: "terminal", exact: true })).toBeDisabled();

  // The persona arrived as standing instructions, recorded once at launch.
  await card.getByRole("button", { name: "See standing instructions" }).click();
  const received = dashboard.getByRole("dialog", { name: "Standing instructions this session received" });
  await expect(received).toContainText(`Resident role: ${PERSONA}`);
  await expect(received).toContainText("Reviews the risk the changed code introduces");
  await expect(received).toContainText(PROFILE_BRIEF);
  await expect(received).toContainText(RUN_BRIEF);
  await capture(received, "standing-instructions");
  await received.getByRole("button", { name: "Close" }).click();
  await expect(received).toBeHidden();

  // Complete & close is the one way a resident ends.
  const complete = card.getByRole("button", { name: "Complete" });
  await settled(complete);
  await complete.click();
  const completeDialog = dashboard.getByRole("dialog", { name: "Complete task and close session" });
  await completeDialog.getByRole("button", { name: "Complete & close" }).click();
  await expect(completeDialog).toBeHidden();
  await expect.poll(async () =>
    (await api<Array<{ id: string; status: string }>>(daemon, "/api/tasks"))
      .find((t) => t.id === task!.id)?.status ?? null,
  ).toBe("done");
});

test("Single agent Dispatch does not offer resident as a kind, and Resident mode with no profiles points at the page", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
  expect(await options(kind)).not.toContain("resident");

  await dialog.getByRole("radio", { name: "Resident" }).click();
  await expect(dialog.getByRole("button", { name: "Launch resident" })).toBeDisabled();
  await expect(dialog).toContainText("No resident profiles yet");
  await expectContentClearsBorder(dialog);
  await dialog.getByRole("button", { name: "Create a profile" }).click();
  await expect(dialog).toBeHidden();
  await expect(dashboard).toHaveURL(`${daemon.baseURL}/#/residents`);
  await expect(dashboard.getByRole("heading", { name: "Residents", level: 2 })).toBeVisible();
});

test("a profile saves a nondefault harness, model and effort, edits to a new revision, and archives out of the page and Dispatch", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/residents`);
  const rail = dashboard.getByRole("complementary", { name: "Resident profiles" });
  await rail.getByRole("button", { name: "New" }).click();
  const editor = dashboard.getByRole("region", { name: "New resident profile" });
  await editor.getByLabel("Name").fill("Docs Gardener");
  await editor.getByRole("combobox", { name: "Persona" }).selectOption({ label: `${PERSONA} · built-in` });

  // Codex, a model from its catalog, and an effort other than the default.
  await editor.getByRole("combobox", { name: "Harness" }).selectOption("codex");
  const model = editor.getByRole("combobox", { name: "Model" });
  const models = (await options(model)).filter((value) => value !== "");
  expect(models.length).toBeGreaterThan(0);
  await model.selectOption(models[0]!);
  await editor.getByRole("combobox", { name: "Effort" }).selectOption("high");
  await editor.getByRole("button", { name: "Save" }).click();

  const saved = dashboard.getByRole("region", { name: "Resident profile Docs Gardener" });
  await expect(saved).toContainText("Revision 1");
  const persisted = async () =>
    (await api<Array<{ id: string; name: string; revision: number; settings: { execution: unknown; instructions: { markdown: string } } }>>(
      daemon,
      "/api/residents/profiles",
    )).find((profile) => profile.name === "Docs Gardener");
  expect((await persisted())?.settings.execution).toEqual({ agent: "codex", model: models[0], effort: "high" });

  // An edit writes revision 2, and the page reseeds on it.
  await saved.getByLabel("Profile instructions").fill("Prune stale pages weekly.");
  await expect(saved).toContainText("unsaved changes");
  await saved.getByRole("button", { name: "Save" }).click();
  await expect(saved).toContainText("Revision 2");
  await expect.poll(async () => (await persisted())?.revision).toBe(2);
  expect((await persisted())?.settings.instructions.markdown).toBe("Prune stale pages weekly.");
  expect((await persisted())?.settings.execution).toEqual({ agent: "codex", model: models[0], effort: "high" });
  await capture(dashboard.locator("main.residents-page"), "residents-page-codex-revision-2");

  // Archive removes it from the rail, from the catalog, and from Dispatch > Resident.
  await saved.getByRole("button", { name: "Archive" }).click();
  await expect(rail.getByRole("button", { name: /Docs Gardener/ })).toHaveCount(0);
  await expect(rail).toContainText("No resident profiles yet");
  await expect.poll(async () => (await persisted()) ?? null).toBeNull();
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByRole("radio", { name: "Resident" }).click();
  await expect(dialog.getByRole("radio", { name: /Docs Gardener/ })).toHaveCount(0);
  await expect(dialog).toContainText("No resident profiles yet");
});

test("a revision saved in another window never discards unsaved edits: it is held as a conflict with an explicit choice", async ({
  dashboard,
  daemon,
}) => {
  await authorProfile(dashboard, daemon);
  type Profile = { id: string; revision: number; settings: { instructions: { markdown: string } } & Record<string, unknown> };
  const current = async () =>
    (await api<Profile[]>(daemon, "/api/residents/profiles")).find((p) => p.settings.instructions !== undefined)!;
  /** Another window's save: a PATCH straight to the daemon. */
  const saveElsewhere = async (markdown: string) => {
    const profile = await current();
    const response = await fetch(`${daemon.baseURL}/api/residents/profiles/${profile.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: profile.revision,
        settings: { ...profile.settings, instructions: { markdown } },
      }),
    });
    expect(response.status).toBe(200);
  };
  const editor = dashboard.getByRole("region", { name: `Resident profile ${PROFILE}` });
  const instructions = editor.getByLabel("Profile instructions");

  // A clean editor simply moves to the newer revision.
  await saveElsewhere("Saved in another window.");
  await expect(editor).toContainText("Revision 2");
  await expect(instructions).toHaveValue("Saved in another window.");

  // A dirty one keeps the operator's text and says what happened.
  await instructions.fill("My unsaved edit.");
  await saveElsewhere("Saved elsewhere again.");
  const conflict = editor.getByRole("alert");
  await expect(conflict).toContainText("Revision 3 of this profile was saved elsewhere");
  await expect(instructions).toHaveValue("My unsaved edit.");
  await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await capture(dashboard.locator("main.residents-page"), "residents-page-conflict");

  // Keeping mine writes the revision after the newer one.
  await conflict.getByRole("button", { name: "Save mine over it" }).click();
  await expect(editor).toContainText("Revision 4");
  await expect(conflict).toHaveCount(0);
  await expect.poll(async () => (await current()).settings.instructions.markdown).toBe("My unsaved edit.");

  // Or load theirs, discarding mine.
  await instructions.fill("Edit I will discard.");
  await saveElsewhere("Their latest.");
  await editor.getByRole("button", { name: "Load revision 5" }).click();
  await expect(instructions).toHaveValue("Their latest.");
  await expect(editor).toContainText("Revision 5");
  await expect(editor.getByRole("alert")).toHaveCount(0);
});

type StoredProfile = { id: string; revision: number; settings: Record<string, unknown> };

/** Another window's write: straight to the daemon, against the profile's current revision. */
async function writeElsewhere(
  daemon: DaemonHandle,
  method: "PATCH" | "DELETE",
  settings?: (current: StoredProfile["settings"]) => StoredProfile["settings"],
): Promise<void> {
  const [profile] = await api<StoredProfile[]>(daemon, "/api/residents/profiles");
  if (!profile) throw new Error("no live profile");
  const response = await fetch(`${daemon.baseURL}/api/residents/profiles/${profile.id}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedRevision: profile.revision,
      ...(settings ? { settings: settings(profile.settings) } : {}),
    }),
  });
  expect(response.status).toBe(200);
}

test("Dispatch launches in the profile's current default repository, and keeps a repository the operator typed", async ({
  dashboard,
  daemon,
}) => {
  await authorProfile(dashboard, daemon);
  const editor = dashboard.getByRole("region", { name: `Resident profile ${PROFILE}` });
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  const repository = dialog.getByLabel("Repository");
  const moved = `${daemon.repo}-moved`;

  await editor.getByRole("button", { name: "Launch" }).click();
  await expect(repository).toHaveValue(daemon.repo);
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // The profile's default changes after the form was prefilled: reopening follows it.
  await writeElsewhere(daemon, "PATCH", (settings) => ({ ...settings, workspace: { defaultRepoRoot: moved } }));
  await expect(editor).toContainText("Revision 2");
  await editor.getByRole("button", { name: "Launch" }).click();
  await expect(repository).toHaveValue(moved);
  await expect(dialog).toContainText("revision 2");

  // A repository the operator chose is theirs, through a later default change.
  await repository.fill("/typed/by/operator");
  await dashboard.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await writeElsewhere(daemon, "PATCH", (settings) => ({ ...settings, workspace: { defaultRepoRoot: daemon.repo } }));
  await expect(editor).toContainText("Revision 3");
  await editor.getByRole("button", { name: "Launch" }).click();
  await expect(repository).toHaveValue("/typed/by/operator");
});

test("a profile archived in another window keeps this window's unsaved draft until the operator discards it", async ({
  dashboard,
  daemon,
}) => {
  await authorProfile(dashboard, daemon);
  const editor = dashboard.getByRole("region", { name: `Resident profile ${PROFILE}` });
  const instructions = editor.getByLabel("Profile instructions");
  await instructions.fill("A draft worth copying.");

  await writeElsewhere(daemon, "DELETE");
  const notice = editor.getByRole("alert");
  await expect(notice).toContainText("This profile was archived elsewhere");
  await expect(instructions).toHaveValue("A draft worth copying.");
  await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(editor.getByRole("button", { name: "Launch" })).toBeDisabled();
  await capture(dashboard.locator("main.residents-page"), "residents-page-archived-elsewhere");

  await notice.getByRole("button", { name: "Discard changes" }).click();
  await expect(editor).toHaveCount(0);
  await expect(dashboard.getByRole("heading", { name: "This resident profile is not available" })).toBeVisible();
  await expect(dashboard.getByRole("complementary", { name: "Resident profiles" })).toContainText("No resident profiles yet");
});

test("leaving a profile with unsaved edits - New, the address bar, or another page - asks before discarding the draft", async ({
  dashboard,
  daemon,
}) => {
  await authorProfile(dashboard, daemon);
  const editor = dashboard.getByRole("region", { name: `Resident profile ${PROFILE}` });
  const instructions = editor.getByLabel("Profile instructions");
  await instructions.fill("A draft I am not done with.");
  const gate = dashboard.getByRole("dialog", { name: "Leave with unsaved changes" });

  // New on the rail is a route change, so the same gate holds it.
  await dashboard.getByRole("complementary", { name: "Resident profiles" }).getByRole("button", { name: "New" }).click();
  await expect(gate).toContainText("resident profile");
  await gate.getByRole("button", { name: "Cancel" }).click();
  await expect(instructions).toHaveValue("A draft I am not done with.");

  // Another page - the palette's, a shortcut's or Back's route change - is held the same way.
  await dashboard.evaluate(() => { window.location.hash = "#/fleet"; });
  await expect(gate).toBeVisible();
  await gate.getByRole("button", { name: "Cancel" }).click();
  await expect(dashboard).toHaveURL(/#\/residents\/(?!new$)[^/]+$/);
  await expect(instructions).toHaveValue("A draft I am not done with.");

  // Confirming discards the draft and goes.
  await dashboard.evaluate(() => { window.location.hash = "#/fleet"; });
  await gate.getByRole("button", { name: "Discard and leave" }).click();
  await expect(dashboard).toHaveURL(/#\/fleet$/);
  await expect(dashboard.locator("main.residents-page")).toHaveCount(0);
});

test("archiving a profile with unsaved edits asks first, and Cancel keeps both the draft and the profile", async ({
  dashboard,
  daemon,
}) => {
  await authorProfile(dashboard, daemon);
  const editor = dashboard.getByRole("region", { name: `Resident profile ${PROFILE}` });
  const instructions = editor.getByLabel("Profile instructions");
  await instructions.fill("An edit I have not saved.");

  await editor.getByRole("button", { name: "Archive" }).click();
  const confirm = dashboard.getByRole("dialog", { name: `Archive ${PROFILE}` });
  await expect(confirm).toContainText("Unsaved changes in the editor are discarded");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
  await expect(instructions).toHaveValue("An edit I have not saved.");
  expect((await api<Array<{ name: string }>>(daemon, "/api/residents/profiles")).map((p) => p.name)).toEqual([PROFILE]);

  await editor.getByRole("button", { name: "Archive" }).click();
  await confirm.getByRole("button", { name: "Discard changes and archive" }).click();
  await expect(editor).toHaveCount(0);
  await expect(dashboard.getByRole("complementary", { name: "Resident profiles" })).toContainText("No resident profiles yet");
  await expect.poll(async () => (await api<unknown[]>(daemon, "/api/residents/profiles")).length).toBe(0);
});

test.describe("a launch that is still starting when the daemon answers", () => {
  // Every launch answers "still starting" at once, so the in-progress path is the one taken.
  test.use({ daemonEnv: { MISSION_RESIDENT_LAUNCH_WAIT_MS: "0" } });

  test("keeps its request id and input through a lost response, close, reopen and retry - and makes one resident", async ({
    dashboard,
    daemon,
  }) => {
    await authorProfile(dashboard, daemon);
    const editor = dashboard.getByRole("region", { name: `Resident profile ${PROFILE}` });
    const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
    const residents = async () =>
      (await api<Array<{ kind: string }>>(daemon, "/api/tasks")).filter((task) => task.kind === "resident").length;

    // Every launch request this lifecycle sends, polling replays included.
    const sent: Array<Record<string, unknown>> = [];
    dashboard.on("request", (request) => {
      if (request.method() === "POST" && /\/api\/residents\/profiles\/[^/]+\/launch$/.test(request.url())) {
        sent.push(request.postDataJSON() as Record<string, unknown>);
      }
    });

    // The first launch REACHES the daemon - it is accepted - but its response is lost.
    let dropped = false;
    await dashboard.route(/\/api\/residents\/profiles\/[^/]+\/launch$/, async (route) => {
      if (dropped) {
        await route.continue();
        return;
      }
      dropped = true;
      await route.fetch();
      await route.abort("failed");
    });

    await editor.getByRole("button", { name: "Launch" }).click();
    await dialog.getByLabel("Instructions for this run").fill(RUN_BRIEF);
    await dialog.getByRole("button", { name: "Launch resident" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog).toBeVisible();

    // Close and reopen: the lost launch is still recorded, with its id and input. Launching again
    // replays it - whether the daemon still reports it starting (the form waits it out, as the
    // next test pins) or it has already started - and never starts a second resident. The
    // replay's answer is deliberately not assumed: how fast the agent starts is the runner's.
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
    await editor.getByRole("button", { name: "Launch" }).click();
    await expect(dialog.getByLabel("Instructions for this run")).toHaveValue(RUN_BRIEF);
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Launch resident" }).click();
    await expect(dialog).toBeHidden({ timeout: 60_000 });

    await expect.poll(residents, { timeout: 30_000 }).toBe(1);
    await expect.poll(async () =>
      (await api<Array<{ kind: string; status: string }>>(daemon, "/api/tasks"))
        .find((task) => task.kind === "resident")?.status ?? null,
    { timeout: 60_000 }).toBe("running");
    expect(await residents()).toBe(1);

    // One request id and one input across the whole lifecycle.
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sent.map((body) => body.requestId)).size).toBe(1);
    expect(new Set(sent.map((body) => JSON.stringify(body))).size).toBe(1);
    expect(sent[0]).toMatchObject({ repoRoot: daemon.repo, instructions: RUN_BRIEF });
  });
});

test.describe("a pending launch closed while its profile's default changes", () => {
  test.use({ daemonEnv: { MISSION_RESIDENT_LAUNCH_WAIT_MS: "0" } });

  test("reopening replays the launch in the repository it was sent with - one resident, no conflict", async ({
    dashboard,
    daemon,
  }) => {
    await authorProfile(dashboard, daemon);
    const editor = dashboard.getByRole("region", { name: `Resident profile ${PROFILE}` });
    const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
    const sent: Array<Record<string, unknown>> = [];
    dashboard.on("request", (request) => {
      if (request.method() === "POST" && /\/api\/residents\/profiles\/[^/]+\/launch$/.test(request.url())) {
        sent.push(request.postDataJSON() as Record<string, unknown>);
      }
    });

    await editor.getByRole("button", { name: "Launch" }).click();
    await expect(dialog.getByLabel("Repository")).toHaveValue(daemon.repo);
    await dialog.getByRole("button", { name: "Launch resident" }).click();
    await expect(dialog.getByRole("status")).toContainText("Starting the resident");
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();

    // The default changes while the launch is outstanding.
    await writeElsewhere(daemon, "PATCH", (settings) => ({ ...settings, workspace: { defaultRepoRoot: `${daemon.repo}-moved` } }));
    await expect(editor).toContainText("Revision 2");

    // Reopening shows, and replays, the repository the launch was sent with.
    await editor.getByRole("button", { name: "Launch" }).click();
    await expect(dialog.getByLabel("Repository")).toHaveValue(daemon.repo);
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Launch resident" }).click();
    await expect(dialog).toBeHidden({ timeout: 60_000 });

    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sent.map((body) => JSON.stringify(body))).size, "every request identical").toBe(1);
    expect(sent[0]).toMatchObject({ repoRoot: daemon.repo });
    await expect.poll(async () =>
      (await api<Array<{ kind: string; repoRoot: string }>>(daemon, "/api/tasks"))
        .filter((task) => task.kind === "resident").map((task) => task.repoRoot),
    { timeout: 30_000 }).toEqual([daemon.repo]);
  });
});

test.describe("a changed launch after a lost response", () => {
  /** The first launch REACHES the daemon - it is accepted - but its response is lost. */
  async function dropFirstLaunchResponse(page: Page, sent: Array<Record<string, unknown>>): Promise<void> {
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/api\/residents\/profiles\/[^/]+\/launch$/.test(request.url())) {
        sent.push({ url: request.url(), ...(request.postDataJSON() as Record<string, unknown>) });
      }
    });
    let dropped = false;
    await page.route(/\/api\/residents\/profiles\/[^/]+\/launch$/, async (route) => {
      if (dropped) {
        await route.continue();
        return;
      }
      dropped = true;
      await route.fetch();
      await route.abort("failed");
    });
  }

  async function secondProfile(daemon: DaemonHandle): Promise<void> {
    const [first] = await api<StoredProfile[]>(daemon, "/api/residents/profiles");
    const response = await fetch(`${daemon.baseURL}/api/residents/profiles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        settings: { ...first!.settings, identity: { name: "Release Watch", description: "" } },
      }),
    });
    expect(response.status).toBe(201);
  }

  const residentTasks = async (daemon: DaemonHandle) =>
    (await api<Array<{ kind: string; title: string }>>(daemon, "/api/tasks")).filter((task) => task.kind === "resident");

  test("names the earlier launch, and Retry the earlier launch replays it exactly - one resident, one id", async ({
    dashboard,
    daemon,
  }) => {
    await authorProfile(dashboard, daemon);
    await secondProfile(daemon);
    const sent: Array<Record<string, unknown>> = [];
    await dropFirstLaunchResponse(dashboard, sent);
    const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });

    await dashboard.getByRole("region", { name: `Resident profile ${PROFILE}` }).getByRole("button", { name: "Launch" }).click();
    await dialog.getByRole("button", { name: "Launch resident" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();

    // A deliberate change: another profile. Nothing is sent until the operator chooses.
    await dialog.getByRole("radio", { name: /Release Watch/ }).click();
    const notice = dialog.getByRole("alert").filter({ hasText: "may already be running" });
    await expect(notice).toContainText(`An earlier launch of ${PROFILE}`);
    await expect(dialog.getByRole("button", { name: "Launch resident" })).toBeDisabled();
    expect(sent).toHaveLength(1);

    await notice.getByRole("button", { name: "Retry the earlier launch" }).click();
    await expect(dialog.getByRole("radio", { name: new RegExp(PROFILE) })).toHaveAttribute("aria-checked", "true");
    await dialog.getByRole("button", { name: "Launch resident" }).click();
    await expect(dialog).toBeHidden({ timeout: 60_000 });

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    await expect.poll(async () => (await residentTasks(daemon)).map((task) => task.title)).toEqual([PROFILE]);
  });

  test("Launch as a new resident starts a separate one under a new id, without a conflict, and the earlier one is still there", async ({
    dashboard,
    daemon,
  }) => {
    await authorProfile(dashboard, daemon);
    await secondProfile(daemon);
    const sent: Array<Record<string, unknown>> = [];
    await dropFirstLaunchResponse(dashboard, sent);
    const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });

    await dashboard.getByRole("region", { name: `Resident profile ${PROFILE}` }).getByRole("button", { name: "Launch" }).click();
    await dialog.getByRole("button", { name: "Launch resident" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();

    await dialog.getByRole("radio", { name: /Release Watch/ }).click();
    await dialog.getByRole("button", { name: "Launch as a new resident" }).click();
    await expect(dialog).toBeHidden({ timeout: 60_000 });

    expect(sent).toHaveLength(2);
    expect(sent[1]!.requestId).not.toBe(sent[0]!.requestId);
    expect(sent[1]!.url).not.toBe(sent[0]!.url);
    await expect.poll(async () => (await residentTasks(daemon)).map((task) => task.title).sort())
      .toEqual([PROFILE, "Release Watch"].sort());
  });

  test("a profile archived in another window after a lost response can still retry that launch exactly - one resident, one id", async ({
    dashboard,
    daemon,
  }) => {
    await authorProfile(dashboard, daemon);
    const sent: Array<Record<string, unknown>> = [];
    await dropFirstLaunchResponse(dashboard, sent);
    const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });

    await dashboard.getByRole("region", { name: `Resident profile ${PROFILE}` }).getByRole("button", { name: "Launch" }).click();
    await dialog.getByLabel("Instructions for this run").fill(RUN_BRIEF);
    await dialog.getByRole("button", { name: "Launch resident" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();

    // Another window archives the profile: its card leaves the live catalog, but the launch it
    // sent may be running, and the daemon still answers that request id.
    await writeElsewhere(daemon, "DELETE");
    await expect(dialog.getByRole("radio", { name: new RegExp(PROFILE) })).toHaveCount(0);
    const notice = dialog.getByRole("status").filter({ hasText: "was archived after this launch was sent" });
    await expect(notice).toContainText(PROFILE);
    const retry = dialog.getByRole("button", { name: "Launch resident" });
    await expect(retry).toBeEnabled();
    await capture(dialog, "resident-dispatch-archived-retry");
    await retry.click();
    await expect(dialog).toBeHidden({ timeout: 60_000 });

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[0]).toMatchObject({ repoRoot: daemon.repo, instructions: RUN_BRIEF });
    await expect.poll(async () => (await residentTasks(daemon)).map((task) => task.title)).toEqual([PROFILE]);
  });
});
