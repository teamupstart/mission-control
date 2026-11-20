// Settings > Task shaping: the markup the list draws in each state, and the pure helpers behind
// it. Whether the panel works end to end is `e2e/specs/task-shaping-settings.spec.ts`'s.
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskShapingView } from "../src/web/components/TaskShapingView.tsx";
import {
  SHAPING_CONFIG_DEFAULTS,
  ShapingConfigSchema,
  shapingConfigView,
  type ShapingConfigView,
  type ShapingIntent,
} from "../src/shared/shaping.ts";
import {
  moveShaper,
  previewShapingIntent,
  readShaperManifest,
  shaperEnvironmentNames,
  shaperReach,
  shaperReceives,
  shapingIntentReflected,
  shapingList,
} from "../src/web/lib/shaping-settings.ts";

const gatherer = (id: string, extra: Record<string, unknown> = {}) => ({
  id, label: `Gatherer ${id}`, stage: "gather",
  transport: { type: "command", command: "/usr/local/bin/repo-notes", args: ["--json", "two words"], env: ["NOTES_TOKEN", "NOTES_HOME"] },
  ...extra,
});
const remote = {
  id: "acme-guidance", label: "Acme guidance", stage: "select",
  transport: { type: "http", url: "https://context.acme.example/shape", headers: { authorization: "Bearer {env:ACME_TOKEN}", "x-user": "{caller.user}" } },
};
const unsupported = { id: "future", label: "Future shaper", stage: "route", transport: { type: "grpc" } };

function view(input: Record<string, unknown>): ShapingConfigView {
  return shapingConfigView(ShapingConfigSchema.parse(input));
}

function render(config: ShapingConfigView | null, references: Record<string, "set" | "unset"> = {}): string {
  return renderToStaticMarkup(createElement(TaskShapingView, {
    config, references, onSet: async () => true,
    onTest: async () => ({ ok: false as const, aborted: false, reason: "" }),
    repositories: async () => [],
  }));
}

test("an empty config says how to add a shaper and still offers the identity and budgets", () => {
  const html = render(shapingConfigView(SHAPING_CONFIG_DEFAULTS));
  assert.match(html, /No shapers registered\. Import a manifest to add one\./);
  assert.match(html, /<span class="settings-pane-count">0<\/span>/);
  assert.match(html, /aria-label="Caller identity and budgets"/);
  assert.match(html, /id="shaping-deadline"[^>]*value="10000"/);
  assert.match(html, /id="shaping-total"[^>]*value="32"/);
  assert.doesNotMatch(html, /data-anchor="task-shaping\/[a-z]+-/, "no rows");
});

test("before the config arrives the list says it is loading and every control waits", () => {
  const html = render(null);
  assert.match(html, /Loading shapers…/);
  assert.match(html, /<button type="button" class="btn" disabled=""[^>]*>Import manifest…<\/button>/);
  assert.doesNotMatch(html, /Caller identity and budgets/);
});

test("a populated list draws each stage in run order with what each shaper runs or calls", () => {
  const html = render(view({
    shapers: [gatherer("second"), remote, gatherer("first")],
    overrides: { first: true, "acme-guidance": false },
    order: ["first", "second"],
  }));
  // Stage order, then the stored order within a stage.
  const at = (text: string) => html.indexOf(text);
  assert.ok(at('aria-label="Gather"') < at('data-anchor="task-shaping/first"'));
  assert.ok(at('data-anchor="task-shaping/first"') < at('data-anchor="task-shaping/second"'));
  assert.ok(at('data-anchor="task-shaping/second"') < at('aria-label="Select"'));
  assert.ok(at('aria-label="Select"') < at('data-anchor="task-shaping/acme-guidance"'));
  // The resolver's own rule: a stored on runs, and no stored choice is off for a registered shaper.
  assert.match(html, /aria-label="Gatherer first: on" aria-pressed="true"/);
  assert.match(html, /aria-label="Gatherer second: off" aria-pressed="false"/);
  assert.match(html, /aria-label="Acme guidance: off"/);
  assert.match(html, /Runs: \/usr\/local\/bin\/repo-notes --json &quot;two words&quot;/);
  assert.match(html, /Calls: POST https:\/\/context\.acme\.example\/shape/);
  assert.match(html, /<span class="shaping-chip">Registered<\/span>/);
  // The first of a stage cannot move up, the last cannot move down.
  assert.match(html, /aria-label="Move Gatherer first up" disabled=""/);
  assert.match(html, /aria-label="Move Gatherer second down" disabled=""/);
  assert.doesNotMatch(html, /aria-label="Move Gatherer first down" disabled=""/);
});

test("an unsupported entry is marked with its reason, can be removed, and cannot be switched on, moved or dry-run", () => {
  const html = render(view({ shapers: [unsupported, gatherer("known")] }));
  assert.match(html, /Not supported by this build/);
  assert.match(html, /stage: This build does not support the stage this entry names\./);
  const row = html.slice(html.indexOf('data-anchor="task-shaping/future"'));
  assert.match(row, /aria-label="Remove Future shaper"/);
  assert.match(row, /disabled="" aria-label="Future shaper: off"/);
  assert.doesNotMatch(row.slice(0, row.indexOf("</div></div>")), /Move Future shaper|Dry-run Future shaper/);
  // Switched on by an older build, it may still be switched off.
  const on = render(view({ shapers: [unsupported], overrides: { future: true } }));
  assert.doesNotMatch(on, /disabled="" aria-label="Future shaper: on"/);
  assert.match(on, /aria-label="Future shaper: on"/);
});

test("a row names each environment variable, set or not set where the reply says, never a value", () => {
  const html = render(view({ shapers: [gatherer("notes"), remote] }), { NOTES_TOKEN: "set", ACME_TOKEN: "unset" });
  assert.match(html, /<li class="is-set"><code>NOTES_TOKEN<\/code><span>set<\/span><\/li>/);
  assert.match(html, /<li class="is-unset"><code>ACME_TOKEN<\/code><span>not set<\/span><\/li>/);
  // A name the reply does not mention is listed without a status.
  assert.match(html, /<li><code>NOTES_HOME<\/code><\/li>/);
});

test("rows carry data-anchor task-shaping/<id> and no data-testid", () => {
  const html = render(view({ shapers: [gatherer("alpha"), remote] }));
  assert.ok(html.includes('data-anchor="task-shaping/alpha"'));
  assert.ok(html.includes('data-anchor="task-shaping/acme-guidance"'));
  assert.doesNotMatch(html, /data-testid/);
});

test("the list groups unsupported entries last and shapes rows for both origins", () => {
  const groups = shapingList(view({ shapers: [unsupported, gatherer("a"), remote] }));
  assert.deepEqual(groups.map((group) => group.stage), ["gather", "select", null]);
  const [row] = groups[2]!.rows;
  assert.deepEqual({ ...row, shaper: null }, {
    id: "future", label: "Future shaper", origin: "registered", shaper: null, on: false,
    problem: "stage: This build does not support the stage this entry names.", path: null,
  });
});

test("moving a shaper writes every listed id in its new order and keeps ids the list does not draw", () => {
  const config = view({ shapers: [gatherer("a"), gatherer("b"), remote], order: ["found-on-disk"] });
  assert.deepEqual(moveShaper(config, "b", -1), ["b", "a", "acme-guidance", "found-on-disk"]);
  assert.equal(moveShaper(config, "a", -1), null, "already first in its stage");
  assert.equal(moveShaper(config, "acme-guidance", 1), null, "alone in its stage");
  assert.equal(moveShaper(config, "nobody", 1), null);
});

test("a preview draws each intent the way the daemon applies it, and recognises it once reflected", () => {
  const config = view({ shapers: [gatherer("a")], overrides: { a: true }, order: ["a"] });
  const intents: ShapingIntent[] = [
    { kind: "enable", id: "a", enabled: false },
    { kind: "reorder", order: ["a", "a"] },
    { kind: "settings", caller: { user: "me" }, limits: { deadlineMs: 2_000 } },
    { kind: "remove", id: "a" },
  ];
  assert.equal(previewShapingIntent(config, intents[0]!).overrides.a, false);
  assert.deepEqual(previewShapingIntent(config, intents[1]!).order, ["a"]);
  assert.equal(previewShapingIntent(config, intents[2]!).limits.deadlineMs, 2_000);
  assert.deepEqual(previewShapingIntent(config, intents[3]!).shapers, []);
  // An upsert is drawn switched off, a replacement as much as a new one.
  const upserted = previewShapingIntent(config, { kind: "upsert", shaper: gatherer("a", { label: "Renamed" }) as never });
  assert.equal(upserted.overrides.a, false);
  assert.equal(upserted.shapers[0]!.label, "Renamed");
  assert.equal(shapingIntentReflected(config, { kind: "enable", id: "a", enabled: true }), true);
  assert.equal(shapingIntentReflected(config, intents[0]!), false);
});

test("reading a manifest takes a folder manifest as it is, ignores its enabled, and refuses what a registration cannot hold", () => {
  const read = readShaperManifest(JSON.stringify({ ...gatherer("notes"), enabled: true }));
  assert.equal(read.ok, true);
  assert.equal(read.ok && read.ignoredEnabled, true);
  assert.equal(read.ok && "enabled" in read.shaper, false);
  const dotSlash = readShaperManifest(JSON.stringify(gatherer("local", { transport: { type: "command", command: "./run" } })));
  assert.equal(dotSlash.ok, false);
  assert.match(dotSlash.ok ? "" : dotSlash.reason, /^transport\.command: A registered shaper has no folder/);
  const literal = readShaperManifest(JSON.stringify({ ...remote, transport: { ...remote.transport, headers: { authorization: "Bearer sk-live-x" } } }));
  assert.equal(literal.ok, false);
  assert.match(literal.ok ? "" : literal.reason, /must be a reference such as \{env:NAME\}/);
  assert.match((readShaperManifest("{ nope") as { reason: string }).reason, /^This is not JSON/);
  assert.match((readShaperManifest("  ") as { reason: string }).reason, /Paste a shaper manifest/);
});

test("the review states what a shaper runs or calls, the variables it names and what it is sent", () => {
  const [local, http] = [view({ shapers: [gatherer("a")] }).shapers[0]!, view({ shapers: [remote] }).shapers[0]!] as const;
  assert.ok(!("unsupported" in local) && !("unsupported" in http));
  if ("unsupported" in local || "unsupported" in http) return;
  assert.deepEqual(shaperReach(local), [{ label: "Runs", value: '/usr/local/bin/repo-notes --json "two words"' }]);
  assert.deepEqual(shaperReach(http), [
    { label: "Calls", value: "POST https://context.acme.example/shape" },
    { label: "Header authorization", value: "Bearer {env:ACME_TOKEN}" },
    { label: "Header x-user", value: "{caller.user}" },
  ]);
  assert.deepEqual(shaperEnvironmentNames(local), ["NOTES_TOKEN", "NOTES_HOME"]);
  assert.deepEqual(shaperEnvironmentNames(http), ["ACME_TOKEN"]);
  assert.equal(shaperReceives(local).remote, false);
  const sent = shaperReceives(http);
  assert.equal(sent.remote, true);
  assert.match(sent.never ?? "", /Never sent: local paths/);
});
