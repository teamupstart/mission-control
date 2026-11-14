import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StorageSettingsPanelView } from "../src/web/components/StorageSettingsPanel.tsx";
import { StorageBanner, storageNotificationsDue, storageWarnings } from "../src/web/components/StorageBanner.tsx";
import { storageDotTone } from "../src/web/lib/settings-dots.ts";
import {
  gibField,
  parseGibField,
  parseWholeField,
  STORAGE_TABS,
  storageTabForAnchor,
  type StorageTabId,
} from "../src/web/lib/storage-view.ts";
import {
  GIB,
  IDLE_ACTIONS,
  IDLE_PLAN,
  idleStateFixture,
  NOW,
  STORAGE_ACTIONS,
  storageHealthFixture,
  storageStateFixture,
} from "./helpers/storage-fixtures.ts";

function render(tab: StorageTabId, options: { plan?: typeof IDLE_PLAN | null } = {}): string {
  const anchor = STORAGE_TABS.find((entry) => entry.id === tab)!.anchor;
  return renderToStaticMarkup(createElement(StorageSettingsPanelView, {
    state: storageStateFixture(),
    actions: STORAGE_ACTIONS,
    idle: idleStateFixture(options.plan === undefined ? IDLE_PLAN : options.plan),
    idleActions: IDLE_ACTIONS,
    onNavigate: () => {},
    jumpAnchor: anchor,
    jumpRequestId: 1,
    now: NOW,
  }));
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

test("a deep link lands on the tab that holds its control, and problems live on Overview", () => {
  for (const tab of STORAGE_TABS) assert.equal(storageTabForAnchor(tab.anchor), tab.id);
  assert.equal(storageTabForAnchor("storage/problems"), "overview");
  assert.equal(storageTabForAnchor("worktrees/pools"), null);
});

test("GiB fields read empty as no limit and refuse what is not a positive number", () => {
  assert.equal(gibField(null), "");
  assert.equal(gibField(60 * GIB), "60");
  // Shown exactly, never rounded to a different threshold than the daemon enforces.
  assert.equal(gibField(GIB / 4), "0.25");
  for (const bytes of [GIB / 4, 280 * 1024 ** 2, 10 * GIB, 60 * GIB, 1_234_567_891]) {
    assert.equal(parseGibField(gibField(bytes)), bytes, `${bytes} round-trips through its field`);
  }
  assert.equal(parseGibField(""), null);
  assert.equal(parseGibField("60"), 60 * GIB);
  assert.equal(parseGibField("0.5"), GIB / 2);
  for (const bad of ["0", "-1", "lots"]) assert.equal(parseGibField(bad), undefined);
  assert.equal(parseWholeField(""), null);
  assert.equal(parseWholeField("7"), 7);
  assert.equal(parseWholeField("7.5"), undefined);
});

test("the tab strip is one tablist, the selected tab owns the panel, and badges carry sizes", () => {
  const html = render("overview");
  assert.match(html, /role="tablist" aria-label="Storage views"/);
  assert.equal(html.match(/role="tab"/g)?.length, STORAGE_TABS.length);
  assert.match(html, /id="storage-tab-overview"[^>]*aria-selected="true"/);
  assert.match(html, /role="tabpanel" id="storage-tabpanel-overview" aria-labelledby="storage-tab-overview" data-anchor="storage\/overview"/);
  assert.match(text(html), /Backups 2\.0 GiB/);
  assert.match(text(html), /Pool caches 31 GiB/);
  assert.match(text(html), /Cleanup 1\.0 GiB/);
  assert.match(html, /aria-label="A warning is standing"/);
});

test("Overview shows the warnings, the volume, Mission Control against its limit, and every category", () => {
  const body = text(render("overview"));
  assert.match(body, /Low free space The volume holding Mission Control has 8\.0 GiB free/);
  assert.match(body, /Near the storage limit/);
  assert.match(body, /8\.0 GiB free · warns below 10 GiB free/);
  assert.match(body, /54 GiB of 60 GiB limit · warns at 54 GiB/);
  for (const label of ["Native worktree pools", "Database backups", "App updates", "Live database", "Workflow evidence and output", "Disposable and check worktrees", "Archives", "Everything else"]) {
    assert.match(body, new RegExp(label), label);
  }
  assert.match(body, /Measured 2m ago, in 41s\./);
  assert.match(body, /Measure again/);
});

test("Backups offers count, age and size limits and names the copies that are always kept", () => {
  const html = render("backups");
  for (const label of [
    "Scheduled copies kept",
    "Pre-migration copies kept",
    "Scheduled maximum age in days",
    "Pre-migration maximum age in days",
    "Backup size budget in GiB",
  ]) {
    assert.match(html, new RegExp(`aria-label="${label}"`), label);
  }
  const body = text(html);
  assert.match(body, /Always kept Newest scheduled copy 2 newest pre-migration copies Newest manual copy/);
  assert.match(body, /Kept copies, newest first/);
  assert.match(body, /Back up now/);
});

test("the Always kept line follows the pre-migration count, never promising a copy it would delete", () => {
  const state = storageStateFixture();
  state.view = { ...state.view!, config: { ...state.view!.config, preMigrationCount: 1 } };
  const body = text(renderToStaticMarkup(createElement(StorageSettingsPanelView, {
    state,
    actions: STORAGE_ACTIONS,
    idle: idleStateFixture(),
    idleActions: IDLE_ACTIONS,
    onNavigate: () => {},
    jumpAnchor: "storage/backups",
    jumpRequestId: 1,
    now: NOW,
  })));
  assert.match(body, /Always kept Newest scheduled copy Newest pre-migration copy Newest manual copy/);
  assert.doesNotMatch(body, /2 newest pre-migration copies/);
  assert.match(body, /a pre-migration count of 1 keeps only the newest/);
});

test("Pool caches shows the budget against idle caches, each pool's slots, and the cost of removing warm caches", () => {
  const body = text(render("pools"));
  assert.match(body, /Idle caches across 1 pool 4\.0 GiB of 2\.0 GiB budget/);
  assert.match(body, /mission-control/);
  assert.match(body, /1 leased · 4 idle · 1 quarantined/);
  assert.match(body, /1 · 1\.0 GiB 1 blocked/);
  assert.match(body, /Removing a warm slot makes a later session slower/);
  assert.match(body, /never picks through a slot's ignored files/);
});

test("Cleanup names every slot it would remove, what blocks the rest, and what it never touches", () => {
  const body = text(render("cleanup"));
  assert.match(body, /Frees 1\.0 GiB Removes 1 idle slot Blocked 1 Idle caches after 3\.0 GiB of 2\.0 GiB budget/);
  assert.match(body, /mission-control-b5174d00f600a624\/16 Idle, last used 9d ago 1\.0 GiB/);
  assert.match(body, /mission-control-b5174d00f600a624\/14 slot is occupied/);
  assert.match(body, /1 leased slot/);
  assert.match(body, /1 quarantined slot/);
  assert.match(body, /Preview removal/);
});

test("Cleanup without a budget offers nothing and says where to set one", () => {
  const body = text(render("cleanup", { plan: { ...IDLE_PLAN, budgetBytes: null, remove: [], blocked: [], freesBytes: 0 } }));
  assert.match(body, /No idle-cache budget is set/);
  assert.match(body, /Set one in Pool caches/);
  assert.match(render("cleanup", { plan: { ...IDLE_PLAN, budgetBytes: null, remove: [], blocked: [], freesBytes: 0 } }), /<button[^>]*disabled=""[^>]*>Preview removal/);
});

test("Warnings shows the current readings and the limits, floor and channels", () => {
  const html = render("warnings");
  for (const label of ["Storage limit in GiB", "Warn at percent of the limit", "Free-space floor in GiB"]) {
    assert.match(html, new RegExp(`aria-label="${label}"`), label);
  }
  const body = text(html);
  assert.match(body, /Warnings now Low free space, Near the limit/);
  assert.match(body, /A banner on the fleet/);
  assert.match(body, /A desktop notification when a warning starts/);
  assert.match(body, /crossing it deletes nothing/);
});

test("the Storage rail dot is red for low space or a failed backup, amber near the limit, dark otherwise", () => {
  assert.equal(storageDotTone(null), null);
  assert.equal(storageDotTone(storageHealthFixture()), "failing");
  const nearOnly = storageHealthFixture();
  nearOnly.problems = nearOnly.problems.filter((problem) => problem.kind === "storage-limit");
  assert.equal(storageDotTone(nearOnly), "armed");
  assert.equal(storageDotTone(storageHealthFixture({ problems: [] })), null);
});

test("the fleet banner shows standing size warnings unless switched off, and ignores a failed backup", () => {
  const html = renderToStaticMarkup(createElement(StorageBanner, { health: storageHealthFixture() }));
  assert.match(html, /aria-label="Storage warning"/);
  assert.match(text(html), /Disk space is running low\./);
  assert.match(html, /href="#\/settings\/storage"/);

  const off = storageHealthFixture();
  off.limits = { ...off.limits, fleetBanner: false };
  assert.equal(renderToStaticMarkup(createElement(StorageBanner, { health: off })), "");

  const backupOnly = storageHealthFixture({
    problems: [{ id: "backup-failed:scheduled:1", kind: "backup-failed", message: "Scheduled database backup failed", link: { target: "backups" } }],
  });
  assert.deepEqual(storageWarnings(backupOnly), []);
  assert.equal(renderToStaticMarkup(createElement(StorageBanner, { health: backupOnly })), "");
});

test("a desktop notification is due once per new warning occurrence, and never when off or not permitted", () => {
  const health = storageHealthFixture();
  health.limits = { ...health.limits, desktopNotification: true };
  const ids = (problems: { id: string }[]) => problems.map((problem) => problem.id);

  // A new occurrence of each standing size or free-space warning: one notification each.
  assert.deepEqual(ids(storageNotificationsDue({ health, permission: "granted", notified: [] })), [
    "low-free-space:volume:1",
    "storage-limit:state:1",
  ]);
  // The same occurrences still standing, already notified: nothing more.
  assert.deepEqual(storageNotificationsDue({
    health,
    permission: "granted",
    notified: ["low-free-space:volume:1", "storage-limit:state:1"],
  }), []);
  // A warning that cleared and came back is a new occurrence with a new id, so it is due again.
  const returned = storageHealthFixture({
    problems: [{ ...health.problems[0]!, id: "low-free-space:volume:2" }],
  });
  returned.limits = health.limits;
  assert.deepEqual(ids(storageNotificationsDue({ health: returned, permission: "granted", notified: ["low-free-space:volume:1"] })), [
    "low-free-space:volume:2",
  ]);

  // Switched off, or the browser has not granted it, or has no notifications: nothing.
  assert.deepEqual(storageNotificationsDue({ health: storageHealthFixture(), permission: "granted", notified: [] }), []);
  for (const permission of ["denied", "default", null]) {
    assert.deepEqual(storageNotificationsDue({ health, permission, notified: [] }), [], String(permission));
  }
  // A failed backup is never a desktop notification.
  const backupOnly = storageHealthFixture({
    problems: [{ id: "backup-failed:scheduled:1", kind: "backup-failed", message: "Scheduled database backup failed", link: { target: "backups" } }],
  });
  backupOnly.limits = health.limits;
  assert.deepEqual(storageNotificationsDue({ health: backupOnly, permission: "granted", notified: [] }), []);
});

test("the kept-copies table marks exactly which copies the current limits delete on save", () => {
  const state = storageStateFixture();
  // Three scheduled copies in the fixture, and a count of 2: the oldest one goes.
  state.view = { ...state.view!, config: { ...state.view!.config, scheduledCount: 2 } };
  const html = renderToStaticMarkup(createElement(StorageSettingsPanelView, {
    state,
    actions: STORAGE_ACTIONS,
    idle: idleStateFixture(),
    idleActions: IDLE_ACTIONS,
    onNavigate: () => {},
    jumpAnchor: "storage/backups",
    jumpRequestId: 1,
    now: NOW,
  }));
  assert.match(html, /<th scope="col">On save<\/th>/);
  const rows = [...html.matchAll(/<tr( class="is-going")?><td>(Scheduled|Pre-migration|Manual)<\/td>.*?<\/tr>/g)];
  assert.deepEqual(rows.map((row) => [row[2], Boolean(row[1]), /Deleted/.test(row[0])]), [
    ["Scheduled", false, false],
    ["Scheduled", false, false],
    ["Scheduled", true, true],
    ["Pre-migration", false, false],
  ]);
});

test("unmeasured idle slots read as unknown on Cleanup, Pool caches and Overview, never as a fit", () => {
  const unmeasured = {
    ...IDLE_PLAN,
    idleBytes: 0,
    unmeasuredIdle: 4,
    remove: [],
    blocked: [],
    freesBytes: 0,
    afterIdleBytes: 0,
    pools: IDLE_PLAN.pools.map((pool) => ({ ...pool, idleBytes: 0, unmeasuredIdle: 4, remove: 0, removeBytes: 0, blocked: 0 })),
  };
  const cleanup = text(render("cleanup", { plan: unmeasured }));
  assert.match(cleanup, /4 idle slots have not been measured yet, so whether the idle caches fit the budget is unknown/);
  assert.match(cleanup, /Measure now/);
  assert.match(cleanup, /Nothing is offered until the unmeasured idle slots are sized/);
  assert.doesNotMatch(cleanup, /already fit the budget/);
  assert.match(cleanup, /Idle caches after at least 0 B of 2\.0 GiB budget/);

  const pools = text(render("pools", { plan: unmeasured }));
  assert.match(pools, /4 idle slots have not been measured yet/);
  assert.match(pools, /at least 0 B of 2\.0 GiB budget/);
  assert.match(pools, /size unknown/);

  assert.match(text(render("overview", { plan: unmeasured })), /Unknown until measured/);
});

test("a plan not read for the current inputs, or not readable at all, is never offered for removal", () => {
  const renderIdle = (idle: ReturnType<typeof idleStateFixture>) => renderToStaticMarkup(createElement(StorageSettingsPanelView, {
    state: storageStateFixture(),
    actions: STORAGE_ACTIONS,
    idle,
    idleActions: IDLE_ACTIONS,
    onNavigate: () => {},
    jumpAnchor: "storage/cleanup",
    jumpRequestId: 1,
    now: NOW,
  }));
  const previewButton = (html: string) => /<button[^>]*>(Preview removal|Previewing…)<\/button>/.exec(html)?.[0] ?? "";

  // Current: offered.
  assert.doesNotMatch(previewButton(renderIdle(idleStateFixture())), /disabled/);

  // Shown while it is read again for new inputs, but not offered.
  const refreshing = renderIdle({ ...idleStateFixture(), current: false, loading: true });
  assert.match(previewButton(refreshing), /disabled=""/);
  assert.match(text(refreshing), /Reading the plan again for the current limits and slots; removal waits for it/);

  // Could not be read again: dropped, with the reason, and nothing offered.
  const failed = renderIdle({
    ...idleStateFixture(null),
    loadError: "The pool-cache plan could not be read from the daemon, so nothing is offered for removal.",
  });
  assert.match(previewButton(failed), /disabled=""/);
  assert.match(text(failed), /could not be read from the daemon, so nothing is offered for removal/);
});

test("Cleanup says why nothing more is offered when warm or blocked slots keep the caches over the budget", () => {
  const stuck = { ...IDLE_PLAN, remove: [], freesBytes: 0, afterIdleBytes: 3 * GIB };
  const body = text(render("cleanup", { plan: stuck }));
  assert.doesNotMatch(body, /already fit the budget/);
  assert.match(body, /Nothing more can be removed, though the idle caches are 1\.0 GiB over the budget: what remains is the 2 most recently used slots each pool keeps warm and the 1 blocked slot below\./);
});
