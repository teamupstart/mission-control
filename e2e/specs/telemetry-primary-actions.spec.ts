import { mkdirSync } from "node:fs";
import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const EVIDENCE = artifactsDir("telemetry-primary-actions");
function captured(daemon: DaemonHandle, name: string) {
  return withDaemonDb(daemon, (db) => (db.prepare("SELECT facts_json, actor_json, refs_json FROM telemetry_journal WHERE name = ? ORDER BY seq").all(name) as { facts_json: string; actor_json: string; refs_json: string }[])
    .map((r) => ({ facts: JSON.parse(r.facts_json), actor: JSON.parse(r.actor_json), refs: JSON.parse(r.refs_json) })));
}
async function enable(daemon: DaemonHandle) {
  const response = await fetch(`${daemon.baseURL}/api/telemetry/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });
  expect(response.ok).toBe(true);
}

test("search, reconnect and renderer loops produce bounded private facts without duplicating navigation", async ({ dashboard, daemon }) => {
  test.setTimeout(180_000);
  await enable(daemon);
  await dashboard.keyboard.press("Meta+k");
  const search = dashboard.getByRole("combobox", { name: "Search everything" });
  await search.fill("telemetry");
  await expectContentClearsBorder(dashboard.getByRole("dialog", { name: "Search everything" }));
  await dashboard.getByRole("option", { name: /Collect telemetry on this machine/ }).click();
  await expect(dashboard).toHaveURL(/#\/settings\/telemetry$/);
  const entries = () => captured(daemon, "mission.feature.entry");
  await expect.poll(() => entries().filter((e) => e.facts.action === "select" && e.facts.feature === "search").length).toBe(1);
  await expect.poll(() => entries().filter((e) => e.facts.action === "enter" && e.facts.feature === "settings").length).toBe(1);

  // A reconnect remains in one page visit; SSE snapshots are not navigation.
  await dashboard.context().setOffline(true);
  await dashboard.keyboard.press("Meta+k");
  await search.fill("PRIVATE_SENTINEL_no_result_7fe97");
  await expect(dashboard.getByText(/Nothing matches/i)).toBeVisible();
  await dashboard.keyboard.press("Escape");
  await expect(search).toBeHidden();
  await dashboard.context().setOffline(false);
  await dashboard.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => entries().filter((e) => e.facts.action === "no_results").length, { timeout: 20_000 }).toBe(1);
  expect(entries().filter((e) => e.facts.feature === "settings" && e.facts.action === "enter")).toHaveLength(1);
  await expect(dashboard.getByLabel("Collect Mission Control telemetry on this machine")).toBeChecked();

  const invalid = await dashboard.request.post(`${daemon.baseURL}/api/telemetry/ingress`, { data: { records: Array.from({ length: 9 }, () => ({ event: "mission.feature.entry", facts: { feature: "files", action: "enter" } })) } });
  expect(invalid.status()).toBe(400);
  const extra = await dashboard.request.post(`${daemon.baseURL}/api/telemetry/ingress`, { data: { records: [{ event: "mission.feature.entry", facts: { feature: "files", action: "enter", path: "PRIVATE_SENTINEL" } }] } });
  expect((await extra.json()).rejected[0].reason).toBe("invalid_facts");

  await dashboard.clock.install();
  await dashboard.evaluate(() => {
    const shared = new Error("PRIVATE_SENTINEL message /Users/private/file");
    shared.stack = `Error: PRIVATE_SENTINEL\n    at privateName (${location.origin}/assets/private-bundle.js:12:34)`;
    window.dispatchEvent(new ErrorEvent("error", { error: shared }));
    window.dispatchEvent(new ErrorEvent("error", { error: shared }));
    const hostile = new Error("PRIVATE_SENTINEL accessor");
    Object.defineProperty(hostile, "stack", { get() { throw new Error("PRIVATE_SENTINEL getter"); } });
    window.dispatchEvent(new ErrorEvent("error", { error: hostile }));
    for (let i = 0; i < 40; i++) {
      const error = new Error("PRIVATE_SENTINEL"); error.stack = shared.stack;
      window.dispatchEvent(new ErrorEvent("error", { error }));
    }
  });
  await dashboard.clock.runFor(200);
  const errors = () => captured(daemon, "mission.renderer.error").filter((e) => e.facts.code === "exception");
  await expect.poll(() => errors().length).toBe(1);
  expect(errors()[0]!.facts).toMatchObject({ fingerprint: "app:12:34", handled: false, suppressed: 0 });
  await dashboard.clock.fastForward(60_000);
  await dashboard.clock.runFor(200);
  await expect.poll(() => errors().length).toBe(2);
  expect(errors()[1]!.facts.suppressed).toBe(40);
  expect(JSON.stringify([...entries(), ...errors()])).not.toContain("PRIVATE_SENTINEL");
  mkdirSync(EVIDENCE, { recursive: true });
  await dashboard.screenshot({ path: `${EVIDENCE}bounded-error-recovery.png`, animations: "disabled" });
});

test("a failed library save stays editable and a successful retry records the actual owner once", async ({ dashboard, daemon }) => {
  await enable(daemon);
  const response = await dashboard.request.post(`${daemon.baseURL}/api/session-actions`, { data: { name: "Phase five action", promptMarkdown: "PRIVATE_SENTINEL", requiredSkillId: "pull-request" } });
  expect(response.ok()).toBe(true);
  const action = await response.json();
  await dashboard.goto(`${daemon.baseURL}/#/library/actions/${action.id}`);
  const name = dashboard.getByPlaceholder("Untitled session action");
  await name.fill("Recovered action");
  let fail = true;
  await dashboard.route(`**/api/session-actions/${action.id}`, async (route) => {
    if (route.request().method() === "PATCH" && fail) { fail = false; await route.abort("connectionfailed"); }
    else await route.continue();
  });
  const save = dashboard.getByRole("button", { name: "Save", exact: true });
  await save.click();
  await expect(dashboard.getByRole("alert").filter({ hasText: /fetch|network/i })).toBeVisible();
  await expect(name).toHaveValue("Recovered action");
  await save.click();
  await expect(dashboard.getByRole("alert").filter({ hasText: /fetch|network/i })).toBeHidden();
  await expect.poll(() => captured(daemon, "mission.action.result").filter((e) => e.facts.action === "library.action_edit" && e.facts.outcome === "applied").length).toBe(1);
  const recorded = captured(daemon, "mission.action.result").find((e) => e.facts.action === "library.action_edit")!;
  expect(recorded.actor).toMatchObject({ kind: "human", basis: "app_context", origin: "dashboard" });
  expect(JSON.stringify(recorded)).not.toContain("PRIVATE_SENTINEL");
  await expect.poll(() => captured(daemon, "mission.renderer.error").filter((e) => e.facts.code === "disconnected").length).toBe(1);
  mkdirSync(EVIDENCE, { recursive: true });
  await dashboard.screenshot({ path: `${EVIDENCE}library-save-recovered.png`, animations: "disabled" });
});

test("development remounts do not repeat entry and a copied report records completion", async ({ dashboard, daemon }) => {
  const { startDevDashboard } = await import("../fixtures/dev-dashboard.ts");
  await enable(daemon);
  const dev = await startDevDashboard(daemon);
  try {
    await dashboard.goto(`${dev.origin}/#/settings/telemetry`);
    await expect(dashboard.getByLabel("Collect Mission Control telemetry on this machine")).toBeChecked();
    await expect.poll(() => captured(daemon, "mission.feature.entry").filter((e) => e.facts.feature === "settings" && e.facts.action === "enter").length).toBe(1);
    // A settings status event causes a render, not another visit.
    await dashboard.request.put(`${daemon.baseURL}/api/ui/config`, { data: { richText: false } });
    await dashboard.getByLabel("Collect Mission Control telemetry on this machine").focus();
    expect(captured(daemon, "mission.feature.entry").filter((e) => e.facts.feature === "settings").length).toBe(1);
    await dashboard.evaluate(() => { location.hash = "#/fleet"; });
    await expect(dashboard.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
    await dashboard.keyboard.press("Shift+P");
    const report = dashboard.getByRole("dialog", { name: "Sitrep" });
    await expectContentClearsBorder(report);
    await dashboard.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await report.getByRole("button", { name: "Copy as markdown" }).click();
    await expect(report.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
    await expect.poll(() => captured(daemon, "mission.feature.entry").filter((e) => e.facts.feature === "reports" && e.facts.action === "complete").length).toBe(1);
    await report.getByRole("button", { name: "Close", exact: true }).click();
    await expect(report).toBeHidden();

    await dashboard.request.put(`${daemon.baseURL}/api/ui/config`, { data: { layout: "console" } });
    const created = await dashboard.request.post(`${daemon.baseURL}/api/tasks`, { data: {
      repoRoot: daemon.repo, kind: "chat", agent: "claude", intent: "Reader revisit fixture", workflowId: null,
    } });
    expect(created.ok()).toBe(true);
    await dashboard.getByRole("navigation", { name: "Sessions" }).getByRole("button", { name: /Reader Revisit Fixture/ }).click();
    const tabs = dashboard.getByRole("tablist", { name: "Session detail" });
    await expect(tabs).toBeVisible();
    const readerEntries = () => captured(daemon, "mission.feature.entry").filter((e) => e.facts.feature === "conversation" && e.facts.action === "enter");
    await expect.poll(() => readerEntries().length).toBe(1);
    await dashboard.evaluate(() => { location.hash = "#/library"; });
    await expect(tabs).toBeHidden();
    await dashboard.evaluate(() => { location.hash = "#/fleet"; });
    await expect(tabs).toBeVisible();
    await expect.poll(() => readerEntries().length).toBe(2);
    mkdirSync(EVIDENCE, { recursive: true });
    await dashboard.screenshot({ path: `${EVIDENCE}reader-reentered.png`, animations: "disabled" });
  } finally { dev.stop(); }
});


test("a transient ingress failure recovers without another user gesture", async ({ dashboard, daemon }) => {
  await enable(daemon);
  const attempts: Array<{ id: string; body: string }> = [];
  await dashboard.route("**/api/telemetry/ingress", async (route) => {
    const body = route.request().postDataJSON();
    if (!body.records.some((r: { facts: { feature?: string } }) => r.facts.feature === "library")) return route.continue();
    attempts.push({ id: route.request().headers()["x-mission-operation-id"]!, body: route.request().postData()! });
    if (attempts.length === 1) await route.fulfill({ status: 503, body: "temporarily unavailable" });
    else await route.continue();
  });
  await dashboard.getByRole("button", { name: /Library/ }).first().click();
  await expect(dashboard).toHaveURL(/#\/library/);
  await expect.poll(() => captured(daemon, "mission.feature.entry").filter((e) => e.facts.feature === "library" && e.facts.action === "enter").length).toBe(1);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
});
