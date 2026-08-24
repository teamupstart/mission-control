import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SettingsRestoredEventSchema,
  type SettingsBackupsListResponse,
} from "../src/shared/settings-backups.ts";
import { RestoreSettingsPanelView } from "../src/web/components/RestoreSettingsPanel.tsx";
import { SettingsRestoredBanner } from "../src/web/components/SettingsRestoredBanner.tsx";
import { OverlayHost } from "../src/web/components/Overlay.tsx";
import {
  canSubmitSettingsRestore,
  initialSettingsRestoreState,
  settingsRestoreReducer,
  type SettingsRestoreActions,
  type SettingsRestoreState,
} from "../src/web/useSettingsRestore.ts";
import {
  abandonSettingsRestore,
  beginSettingsRestore,
  finishSettingsRestore,
  observeSettingsRestored,
  reloadAfterSettingsRestore,
  SETTINGS_RESTORE_PENDING_LIMIT,
  settingsRestoreMarkerChanged,
} from "../src/web/lib/settings-restore-coordinator.ts";

const digest = "a".repeat(64);
const list: SettingsBackupsListResponse = {
  status: "available",
  snapshots: [
    {
      status: "ready",
      id: "daily-2026-08-24",
      size: 2048,
      modifiedAt: "2026-08-24T12:00:00.000Z",
      kind: "daily",
      createdAt: "2026-08-24T12:00:00.000Z",
      localDate: "2026-08-24",
      appVersion: "1.1.0",
      counts: { personas: 1, sessionActions: 2, workflowCommands: 3, workflowDefinitions: 4, workflowVersions: 5 },
      digest,
    },
    {
      status: "corrupt",
      id: "daily-2026-08-23",
      size: 64,
      modifiedAt: "2026-08-23T12:00:00.000Z",
      reason: "Snapshot envelope is invalid",
    },
  ],
  retention: { daily: 90, preRestore: 10 },
  lastSuccessfulSnapshot: null,
  lastError: null,
};
const preview = {
  snapshotId: "daily-2026-08-24" as const,
  digest,
  settingsDomains: ["ui" as const, "personas" as const],
  personas: { added: 0, changed: 1, archived: 0, reactivated: 0 },
  sessionActions: { added: 0, changed: 0, archived: 0, reactivated: 0 },
  workflowCommandsChanged: 1,
  workflows: { added: 0, changed: 1, archived: 0, reactivated: 0 },
  workflowVersions: { inserted: 1, retained: 2 },
  externalEffects: ["skills" as const],
  exclusions: ["Tasks, runs, sessions, reviews, repositories, credentials, and archives"],
  warnings: ["One skill will be reconciled after commit"],
  blockers: [],
};
const actions: SettingsRestoreActions = {
  reload: () => {},
  select: () => {},
  preview: () => {},
  openDialog: () => {},
  closeDialog: () => {},
  setConfirmation: () => {},
  restore: () => {},
};

function renderPanel(state: SettingsRestoreState): string {
  return renderToStaticMarkup(createElement(OverlayHost, {
    value: {
      openEntries: [],
      anyOpen: false,
      onlyOpen: () => true,
      register: () => () => {},
    },
    children: createElement(RestoreSettingsPanelView, { state, actions }),
  }));
}

test("restore panel renders bounded metadata, compatibility, preview, and exact confirmation", () => {
  const state: SettingsRestoreState = {
    ...initialSettingsRestoreState,
    loading: false,
    list,
    selectedId: "daily-2026-08-24",
    preview: { status: "ready", preview },
    dialogOpen: true,
  };
  const html = renderPanel(state);
  assert.match(html, /Settings snapshots, newest first/);
  assert.match(html, /90 daily \+ 10 safety/);
  assert.match(html, /aria-label="Select Daily snapshot from/);
  assert.match(html, /aria-label="Select Unavailable snapshot[^>]*disabled=""/);
  assert.match(html, /Verified preview/);
  assert.match(html, /Capture safety snapshot/);
  assert.match(html, /Tasks, runs, sessions, reviews/);
  assert.match(html, /role="dialog" aria-label="Confirm settings restore" aria-modal="true"/);
  assert.match(html, /Type <code>RESTORE SETTINGS<\/code>/);
  assert.match(html, /<span class="tt-anchor"><button[^>]+disabled=""[^>]*>Restore settings<\/button>/);
  assert.doesNotMatch(html, /\/Users\/|"payload"|guidanceMarkdown|promptMarkdown/);
});

test("restore reducer binds confirmation to the selected digest and invalidates changed rows", () => {
  let state = settingsRestoreReducer(initialSettingsRestoreState, { type: "load_success", value: list });
  state = settingsRestoreReducer(state, { type: "select", id: "daily-2026-08-24" });
  state = settingsRestoreReducer(state, { type: "preview_done", value: { status: "ready", preview } });
  state = settingsRestoreReducer(state, { type: "open_dialog" });
  state = settingsRestoreReducer(state, { type: "confirmation", value: "restore settings" });
  assert.equal(canSubmitSettingsRestore(state), false);
  state = settingsRestoreReducer(state, { type: "confirmation", value: "RESTORE SETTINGS" });
  assert.equal(canSubmitSettingsRestore(state), true);

  const stale = {
    ...list,
    snapshots: list.snapshots.map((item) => item.status === "ready" ? { ...item, digest: "b".repeat(64) } : item),
  } satisfies SettingsBackupsListResponse;
  state = settingsRestoreReducer(state, { type: "load_success", value: stale });
  assert.equal(state.selectedId, null);
  assert.equal(state.preview, null);
  assert.equal(state.dialogOpen, false);
});

test("restore events distinguish the initiating window and preserve external-window choice", () => {
  const own = {
    type: "settings_restored" as const,
    snapshotId: "daily-2026-08-24" as const,
    restoredAt: "2026-08-24T12:05:00.000Z",
    requestId: "00000000-0000-4000-8000-000000000001",
  };
  let reloads = 0;
  beginSettingsRestore(own.requestId, () => { reloads += 1; });
  assert.equal(observeSettingsRestored(own), "initiating");
  assert.equal(reloads, 1);
  assert.equal(observeSettingsRestored(own), "external");

  const other = { ...own, requestId: "00000000-0000-4000-8000-000000000002" };
  beginSettingsRestore(own.requestId, () => { reloads += 1; });
  assert.equal(observeSettingsRestored(other), "external");
  assert.equal(reloads, 1);
  finishSettingsRestore(own.requestId, true);
  assert.equal(reloads, 2);
  abandonSettingsRestore(own.requestId);

  const banner = renderToStaticMarkup(createElement(SettingsRestoredBanner, {
    event: other,
    onReload: () => {},
  }));
  assert.match(banner, /Settings were restored in another window/);
  assert.match(banner, /Unsaved drafts remain untouched/);
  assert.match(banner, />Reload now<\/button>/);
});

test("a retry cannot orphan an earlier restore with an ambiguous transport result", () => {
  const first = {
    type: "settings_restored" as const,
    snapshotId: "daily-2026-08-24" as const,
    restoredAt: "2026-08-24T12:05:00.000Z",
    requestId: "00000000-0000-4000-8000-000000000011",
  };
  const retryId = "00000000-0000-4000-8000-000000000012";
  let reloads = 0;
  beginSettingsRestore(first.requestId, () => { reloads += 1; });
  beginSettingsRestore(retryId, () => { reloads += 1; });

  // The retry receives a definite refusal after the first request's HTTP leg was ambiguous.
  abandonSettingsRestore(retryId);
  assert.equal(observeSettingsRestored(first), "initiating");
  assert.equal(reloads, 1);

  assert.equal(observeSettingsRestored({ ...first, requestId: retryId }), "external");
  assert.equal(reloads, 1);
});

test("ambiguous restore ownership retains a bounded recent window", () => {
  const requestIds = Array.from(
    { length: SETTINGS_RESTORE_PENDING_LIMIT + 1 },
    (_, index) => `ambiguous-${index}`,
  );
  let reloads = 0;
  for (const id of requestIds) beginSettingsRestore(id, () => { reloads += 1; });

  const event = {
    type: "settings_restored" as const,
    snapshotId: "daily-2026-08-24" as const,
    restoredAt: "2026-08-24T12:05:00.000Z",
  };
  assert.equal(observeSettingsRestored({ ...event, requestId: requestIds[0]! }), "external");
  assert.equal(observeSettingsRestored({ ...event, requestId: requestIds.at(-1)! }), "initiating");
  assert.equal(reloads, 1);

  for (const id of requestIds) abandonSettingsRestore(id);
});

test("a reconnect detects a restore missed during the stream gap without alerting a fresh window", () => {
  const restore = {
    type: "settings_restored" as const,
    snapshotId: "daily-2026-08-24" as const,
    restoredAt: "2026-08-24T12:05:00.000Z",
    requestId: "00000000-0000-4000-8000-000000000021",
  };
  assert.equal(settingsRestoreMarkerChanged(restore, null, false), false);
  assert.equal(settingsRestoreMarkerChanged(restore, restore.requestId, true), false);
  assert.equal(settingsRestoreMarkerChanged(restore, null, true), true);

  let reloads = 0;
  beginSettingsRestore(restore.requestId, () => { reloads += 1; });
  assert.equal(observeSettingsRestored(restore), "initiating");
  assert.equal(reloads, 1);
});

test("settings restore event stays strict, invalidation-only, and outside Line inputs", () => {
  assert.equal(SettingsRestoredEventSchema.safeParse({
    type: "settings_restored",
    snapshotId: "daily-2026-08-24",
    restoredAt: "2026-08-24T12:05:00.000Z",
    requestId: "00000000-0000-4000-8000-000000000001",
    payload: { ui: { layout: "board" } },
  }).success, false);
  const registrySource = readFileSync(new URL("../src/server/registry.ts", import.meta.url), "utf8");
  const lineInputs = registrySource.slice(
    registrySource.indexOf("const LINE_INPUT_EVENTS"),
    registrySource.indexOf("]);", registrySource.indexOf("const LINE_INPUT_EVENTS")) + 3,
  );
  assert.doesNotMatch(lineInputs, /settings_restored/);
  assert.match(registrySource, /`settings_restored` is deliberately absent/);
});

test("the initiating window hydrates before reload, including the failed-hydration fallback", async () => {
  const order: string[] = [];
  await reloadAfterSettingsRestore(
    async () => { order.push("hydrate"); },
    () => { order.push("reload"); },
  );
  assert.deepEqual(order, ["hydrate", "reload"]);

  await assert.rejects(reloadAfterSettingsRestore(
    async () => { order.push("hydrate-failed"); throw new Error("unreachable"); },
    () => { order.push("reload-after-failure"); },
  ));
  assert.deepEqual(order.slice(-2), ["hydrate-failed", "reload-after-failure"]);
});

test("restore layout keeps the table scrollable and stacks status, preview, and actions narrowly", () => {
  const css = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.restore-table-wrap\s*\{[^}]*overflow-x:\s*auto/s);
  const narrow = css.slice(css.indexOf("@media (max-width: 760px)", css.indexOf("Settings restore")));
  assert.match(narrow, /\.restore-status-grid,[\s\S]*grid-template-columns:\s*1fr/);
  assert.match(narrow, /\.restore-primary-action,[\s\S]*flex-direction:\s*column/);
});
