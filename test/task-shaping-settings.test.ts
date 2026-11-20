// Settings > Task shaping: the markup the list draws in each state, and the pure helpers behind
// it. Whether the panel works end to end is `e2e/specs/task-shaping-settings.spec.ts`'s.
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskShapingView } from "../src/web/components/TaskShapingView.tsx";
import { ShaperReview } from "../src/web/components/TaskShapingDialogs.tsx";
import { SHAPING_STAGES } from "../src/shared/shaping-registry.ts";
import {
  SHAPING_CONFIG_DEFAULTS,
  SHAPING_LIMITS,
  ShapingConfigSchema,
  ShapingIntentSchema,
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
  // One group per stage in the tuple, whatever stages a later build appends, then the unsupported ones.
  assert.deepEqual(groups.map((group) => group.stage), [...SHAPING_STAGES, null]);
  const [row] = groups[2]!.rows;
  assert.deepEqual({ ...row, shaper: null }, {
    id: "future", label: "Future shaper", origin: "registered", shaper: null, on: false,
    problem: "stage: This build does not support the stage this entry names.", path: null,
  });
});

test("moving a shaper rewrites only its stage and keeps every other stored id in place", () => {
  const config = view({ shapers: [gatherer("a"), gatherer("b"), remote], order: ["found-on-disk", "acme-guidance"] });
  assert.deepEqual(moveShaper(config, "b", -1), { ok: true, order: ["found-on-disk", "acme-guidance", "b", "a"] });
  assert.equal(moveShaper(config, "a", -1), null, "already first in its stage");
  assert.equal(moveShaper(config, "acme-guidance", 1), null, "alone in its stage");
  assert.equal(moveShaper(config, "nobody", 1), null);
  // The new order sorts exactly as the move drew it.
  const moved = moveShaper(config, "b", -1);
  assert.ok(moved?.ok);
  const after = shapingList({ ...config, order: moved.order });
  assert.deepEqual(after[0]!.rows.map((row) => row.id), ["b", "a"]);
  assert.deepEqual(after[1]!.rows.map((row) => row.id), ["acme-guidance"]);
});

test("a move within the order's bound drops only stored ids that place nothing, and says so when it cannot fit", () => {
  const unseen = Array.from({ length: SHAPING_LIMITS.choices }, (_, n) => `gone-${n}`);
  const config = view({ shapers: [gatherer("a"), gatherer("b")], order: unseen });
  // Before the folder has been read, no stored id is known to be absent, so none is dropped.
  const unread = moveShaper(config, "b", -1);
  assert.equal(unread?.ok, false);
  assert.match(unread && !unread.ok ? unread.reason : "", /The shapers folder has not been read yet, so no stored entry is dropped/);
  assert.deepEqual(moveShaper(config, "b", -1, null), unread);
  // Once it has been read and is empty: 128 stored ids that name no shaper, plus the two moved,
  // keep the oldest first and stay at 128.
  const moved = moveShaper(config, "b", -1, []);
  assert.ok(moved?.ok);
  assert.equal(moved.order.length, SHAPING_LIMITS.choices);
  assert.deepEqual(moved.order.slice(-2), ["b", "a"]);
  assert.deepEqual(moved.order.slice(0, -2), unseen.slice(0, SHAPING_LIMITS.choices - 2));
  assert.ok(ShapingIntentSchema.safeParse({ kind: "reorder", order: moved.order }).success, "the route accepts it");
  // A folder shaper the list does not draw keeps its place, wherever it sits.
  const withFolder = moveShaper(config, "b", -1, ["gone-127"]);
  assert.ok(withFolder?.ok);
  assert.equal(withFolder.order.length, SHAPING_LIMITS.choices);
  assert.ok(withFolder.order.includes("gone-127"));
  assert.ok(!withFolder.order.includes("gone-125"), "the newest id that places nothing makes the room");
  // Every stored id names a live shaper, so nothing can be dropped: the move is refused with why.
  const full = moveShaper(config, "b", -1, unseen);
  assert.deepEqual(full, {
    ok: false,
    reason: `The stored run order is full: it holds at most ${SHAPING_LIMITS.choices} shaper ids, and this move needs ${SHAPING_LIMITS.choices + 2}.`,
  });
});

test("an untouched budget keeps its exact stored bytes when another setting is saved", () => {
  const precise = view({ limits: { totalBytes: 1025 } });
  const html = renderToStaticMarkup(createElement(TaskShapingView, {
    config: precise, onSet: async () => true,
    onTest: async () => ({ ok: false as const, aborted: false, reason: "" }), repositories: async () => [],
  }));
  // Shown to three decimals, never as a rounded whole that a save would read back as 1,024 bytes.
  assert.match(html, /id="shaping-total"[^>]*value="1.001"/);
  assert.match(html, /id="shaping-deadline"[^>]*step="1"/, "every whole millisecond is a valid deadline");
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

// Every transport's review, as a table: what the review promises is exactly what the shaper runs
// or calls, so each row names every part a reviewer must see - command, arguments, endpoint,
// headers, tool, context delivery, or the files a built-in reads - and the review renders each.
const TRANSPORT_REVIEWS: Array<{
  name: string;
  shaper: Record<string, unknown>;
  reach: Array<{ label: string; value: string }>;
  environment: string[];
  remote: boolean;
}> = [
  {
    name: "an MCP server started locally",
    shaper: { id: "mcp-local", label: "Local guidance", stage: "select", transport: {
      type: "mcp", tool: "get_guidance", contextDelivery: "argument",
      server: { type: "stdio", command: "/opt/acme/mcp-server", args: ["--port", "0", "two words"], env: ["ACME_MCP_TOKEN"] },
    } },
    reach: [
      { label: "Runs MCP server", value: '/opt/acme/mcp-server --port 0 "two words"' },
      { label: "Tool", value: "get_guidance" },
      { label: "Context", value: "As a fourth argument, context" },
    ],
    environment: ["ACME_MCP_TOKEN"],
    remote: false,
  },
  {
    name: "an MCP server reached over HTTP",
    shaper: { id: "mcp-remote", label: "Remote guidance", stage: "select", transport: {
      type: "mcp", tool: "get_guidance",
      server: { type: "http", url: "https://mcp.acme.example/mcp", headers: { authorization: "Bearer {env:ACME_MCP_TOKEN}", "x-acme-user": "{caller.user}" } },
    } },
    reach: [
      { label: "Calls MCP server", value: "https://mcp.acme.example/mcp" },
      { label: "Header authorization", value: "Bearer {env:ACME_MCP_TOKEN}" },
      { label: "Header x-acme-user", value: "{caller.user}" },
      { label: "Tool", value: "get_guidance" },
      { label: "Context", value: "Folded into the task argument" },
    ],
    environment: ["ACME_MCP_TOKEN"],
    remote: true,
  },
  {
    name: "the built-in repository-files gatherer",
    shaper: { id: "files", label: "Repository files", stage: "gather", transport: {
      type: "builtin", builtin: "repository-files",
      options: { include: [{ path: "README.md" }, { path: "docs/guide.md", maxBytes: 2048 }], summary: "docs/summary.md", facts: "facts.json" },
    } },
    reach: [
      { label: "Built in", value: "repository-files" },
      { label: "Reads", value: "README.md, docs/guide.md, docs/summary.md, facts.json" },
    ],
    environment: [],
    remote: false,
  },
  {
    name: "the built-in gatherer with no files named",
    shaper: { id: "no-files", label: "No files", stage: "gather", transport: { type: "builtin", builtin: "repository-files" } },
    reach: [{ label: "Built in", value: "repository-files" }, { label: "Reads", value: "No files" }],
    environment: [],
    remote: false,
  },
];

for (const row of TRANSPORT_REVIEWS) {
  test(`the review of ${row.name} states exactly what it runs or calls`, () => {
    const read = readShaperManifest(JSON.stringify(row.shaper));
    assert.equal(read.ok, true, read.ok ? "" : read.reason);
    if (!read.ok) return;
    assert.deepEqual(shaperReach(read.shaper), row.reach);
    assert.deepEqual(shaperEnvironmentNames(read.shaper), row.environment);
    const receives = shaperReceives(read.shaper);
    assert.equal(receives.remote, row.remote);
    const html = renderToStaticMarkup(createElement(ShaperReview, { shaper: read.shaper }));
    for (const line of row.reach) {
      const value = line.value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      assert.ok(html.includes(`<dt>${line.label}</dt><dd><code>${value}</code></dd>`), `${row.name}: the review omits ${line.label} ${line.value}`);
    }
    for (const name of row.environment) assert.ok(html.includes(`<code>${name}</code>`), `${row.name}: the review omits ${name}`);
    if (row.environment.length === 0) assert.match(html, /<dt>Environment variables<\/dt><dd>None<\/dd>/);
    assert.match(html, row.remote ? /<h4>What it is sent<\/h4>/ : /<h4>What it can reach<\/h4>/);
    if (row.remote) assert.match(html, /Never sent: local paths/);
  });
}
