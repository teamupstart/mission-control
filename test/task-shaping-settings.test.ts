// Settings > Task shaping: the markup the list draws in each state, and the pure helpers behind
// it. Whether the panel works end to end is `e2e/specs/task-shaping-settings.spec.ts`'s.
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { z } from "zod";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskShapingView } from "../src/web/components/TaskShapingView.tsx";
import { ShaperReview } from "../src/web/components/TaskShapingDialogs.tsx";
import { SHAPING_STAGES } from "../src/shared/shaping-registry.ts";
import {
  applyShapingIntent,
  moveInShapingOrder,
  registeredShaperRevision,
  SHAPING_CONFIG_DEFAULTS,
  SHAPING_LIMITS,
  ShaperSchema,
  ShapingConfigSchema,
  ShapingIntentSchema,
  shapingViewRevision,
  type ShapingConfigView,
  type ShapingIntent,
} from "../src/shared/shaping.ts";
import { daemonShapingView, shapingReviser } from "../src/server/shaping/revisions.ts";
import {
  moveIntent,
  previewShapingIntent,
  readShaperManifest,
  readShapingRun,
  shaperEnvironmentNames,
  shaperReach,
  shaperReceives,
  shapingIntentReflected,
  shapingIntentSuperseded,
  shapingList,
  shapingLockKeys,
  shapingRefusalText,
  shapingFrameIsReceipt,
  shapingLaterCommit,
  shapingReceiptBaseline,
  shapingRowsAhead,
  shapingViewCommit,
  shapingViewReached,
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
  return daemonShapingView(ShapingConfigSchema.parse(input));
}

function render(config: ShapingConfigView | null, references: Record<string, "set" | "unset"> = {}): string {
  return renderToStaticMarkup(createElement(TaskShapingView, {
    config, references, onSet: async () => "saved" as const,
    onTest: async () => ({ ok: false as const, aborted: false, reason: "" }),
    repositories: async () => [],
  }));
}

test("an empty config says how to add a shaper and still offers the identity and budgets", () => {
  const html = render(daemonShapingView(SHAPING_CONFIG_DEFAULTS));
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

test("the list groups shapers by stage and lists an unsupported entry last, with its reason", () => {
  const groups = shapingList(view({ shapers: [unsupported, gatherer("a"), remote] }));
  // One group per stage in the tuple, whatever stages a later build appends, then the unsupported ones.
  assert.deepEqual(groups.map((group) => group.stage), [...SHAPING_STAGES, null]);
  assert.deepEqual(groups[0]!.rows.map((row) => row.id), ["a"]);
  assert.deepEqual(groups[1]!.rows.map((row) => row.id), ["acme-guidance"]);
  assert.deepEqual(groups[2]!.rows, [{
    id: "future", label: "Future shaper", shaper: null, on: false,
    problem: "stage: This build does not support the stage this entry names.", revision: shapingReviser([unsupported as never]),
    duplicate: false, repeats: 0,
  }]);
});

test("a move is an intent naming where the shaper goes, and the panel draws it as the daemon applies it", () => {
  const config = view({ shapers: [gatherer("a"), gatherer("b"), gatherer("c"), remote], order: ["found-on-disk", "acme-guidance"] });
  // Each is bound to the revision of the definition shown, as a switch is.
  const { revisions } = config;
  assert.deepEqual(moveIntent(config, "b", -1), { kind: "place", id: "b", after: null, expect: revisions.b }, "up to first");
  assert.deepEqual(moveIntent(config, "a", 1), { kind: "place", id: "a", after: "b", expect: revisions.a }, "down past its neighbour");
  assert.deepEqual(moveIntent(config, "c", -1), { kind: "place", id: "c", after: "a", expect: revisions.c });
  assert.equal(moveIntent(config, "a", -1), null, "already first in its stage");
  assert.equal(moveIntent(config, "c", 1), null, "already last");
  assert.equal(moveIntent(config, "acme-guidance", 1), null, "alone in its stage");
  assert.equal(moveIntent(config, "nobody", 1), null);
  const drawn = previewShapingIntent(config, moveIntent(config, "b", -1)!);
  // Other stages and ids the list does not draw keep their slots; the moved stage follows them.
  assert.deepEqual(drawn.order, ["found-on-disk", "acme-guidance", "b", "a", "c"]);
  assert.deepEqual(shapingList(drawn)[0]!.rows.map((row) => row.id), ["b", "a", "c"]);
  // Idempotent: once applied, the same intent is reflected and changes nothing.
  assert.equal(shapingIntentReflected(drawn, moveIntent(config, "b", -1)!), true);
});

test("a move keeps a hidden shaper's slot, composes with another window's move, and stays within the order's bound", () => {
  // Stored order A, X, B in one stage, with X a shaper the list does not draw: moving B up puts B
  // in A's slot and A in B's, so X still runs between them rather than first.
  assert.deepEqual(
    moveInShapingOrder({ rows: ["a", "b"], order: ["a", "x", "b"], id: "b", after: null }),
    { ok: true, order: ["b", "x", "a"] },
  );
  // Two windows that each saw the same order move shapers in different stages: applied in turn to
  // the stored order, both moves survive.
  const base = ShapingConfigSchema.parse({ shapers: [gatherer("a"), gatherer("b"), { ...remote, id: "s1" }, { ...remote, id: "s2" }] });
  const first = applyShapingIntent(base, { kind: "move", id: "b", after: null });
  assert.ok(first.ok);
  const second = applyShapingIntent(first.config, { kind: "move", id: "s2", after: null });
  assert.ok(second.ok);
  const list = shapingList(daemonShapingView(second.config));
  assert.deepEqual(list[0]!.rows.map((row) => row.id), ["b", "a"]);
  assert.deepEqual(list[1]!.rows.map((row) => row.id), ["s2", "s1"]);
  // The daemon refuses an anchor that is not another shaper of the same stage.
  const wrong = applyShapingIntent(base, { kind: "move", id: "b", after: "s1" });
  assert.equal(wrong.ok ? "" : wrong.error, "unknown_shaper");
  // A full order: 127 ids that name nothing and a folder shaper's, last. The daemon knows the
  // folder, so the folder shaper keeps its place and the room comes from the ids that name nothing.
  const stale = Array.from({ length: SHAPING_LIMITS.choices - 1 }, (_, n) => `gone-${n}`);
  const full = ShapingConfigSchema.parse({ shapers: [gatherer("a"), gatherer("b")], order: [...stale, "disk"] });
  const folder = [{ id: "disk", path: "/shapers/disk", state: "ok" as const, problem: null, sha256: null, shaper: null }];
  const pruned = applyShapingIntent(full, { kind: "move", id: "b", after: null }, folder);
  assert.ok(pruned.ok);
  assert.equal(pruned.config.order.length, SHAPING_LIMITS.choices);
  assert.ok(pruned.config.order.includes("disk"));
  assert.deepEqual(pruned.config.order.slice(-2), ["b", "a"]);
  assert.ok(!pruned.config.order.includes("gone-126"), "the newest id that names nothing makes the room");
  // Every stored id names a live shaper, so nothing can be dropped: the move is refused with why.
  const everyLive = stale.map((id) => ({ ...folder[0]!, id }));
  const refused = applyShapingIntent(full, { kind: "move", id: "b", after: null }, [...folder, ...everyLive]);
  assert.equal(refused.ok ? "" : refused.error, "order_full");
  // The panel draws nothing it would have to prune for: only the daemon knows the folder.
  assert.deepEqual(previewShapingIntent(daemonShapingView(full), { kind: "move", id: "b", after: null }).order, full.order);
});

test("an intent bound to a revision is refused once another window replaces the shaper, and a removal keeps a folder shaper off", () => {
  const config = ShapingConfigSchema.parse({ shapers: [gatherer("a")], overrides: { a: false } });
  const shown = daemonShapingView(config).revisions.a!;
  assert.equal(registeredShaperRevision(config, "a", shapingReviser), shown);
  assert.match(shown, /^[0-9a-f]{16}$/);
  const replaced = applyShapingIntent(config, { kind: "upsert", shaper: ShaperSchema.parse(gatherer("a", { label: "Replacement" })) });
  assert.ok(replaced.ok);
  assert.notEqual(registeredShaperRevision(replaced.config, "a", shapingReviser), shown);
  for (const intent of [
    { kind: "enable", id: "a", enabled: true, expect: shown },
    { kind: "remove", id: "a", expect: shown },
  ] as const) {
    const result = applyShapingIntent(replaced.config, intent, [], { revise: shapingReviser });
    assert.equal(result.ok ? "" : result.error, "shaper_changed", intent.kind);
    // Against the definition actually stored, the same intent goes through.
    assert.equal(applyShapingIntent(replaced.config, { ...intent, expect: registeredShaperRevision(replaced.config, "a", shapingReviser)! }, [], { revise: shapingReviser }).ok, true);
  }
  // Removing a registration that shadows a folder shaper of the same id stores it off, in place.
  const shadowing = ShapingConfigSchema.parse({ shapers: [gatherer("a")], overrides: { a: true }, order: ["a"] });
  const folder = [{ id: "a", path: "/shapers/a", state: "ok" as const, problem: null, sha256: null, shaper: null }];
  const removed = applyShapingIntent(shadowing, { kind: "remove", id: "a" }, folder);
  assert.ok(removed.ok);
  assert.deepEqual(removed.config.shapers, []);
  assert.equal(removed.config.overrides.a, false);
  assert.deepEqual(removed.config.order, ["a"]);
  // With no folder shaper behind it, removal clears its choice and its place as before.
  const plain = applyShapingIntent(shadowing, { kind: "remove", id: "a" });
  assert.ok(plain.ok);
  assert.equal(Object.hasOwn(plain.config.overrides, "a"), false);
  assert.deepEqual(plain.config.order, []);
});

test("an untouched budget keeps its exact stored bytes when another setting is saved", () => {
  const precise = view({ limits: { totalBytes: 1025 } });
  const html = renderToStaticMarkup(createElement(TaskShapingView, {
    config: precise, onSet: async () => "saved" as const,
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
  // Scoped to what the transport leaves out, and honest that forwarded text carries what it holds.
  assert.match(sent.never ?? "", /leaves out the repositories. local paths and every credential except the header references above/);
  assert.match(sent.never ?? "", /The text it does send is passed on as written/);
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
    if (row.remote) assert.match(html, /The text it does send is passed on as written/);
  });
}

test("a dry run's reply is read whole, and an incomplete one is refused rather than padded out", () => {
  const entry = {
    shaperId: "notes", label: "Notes", stage: "gather", repo: "billing-api", id: "gather/one",
    title: "One", path: null, body: "first entry", truncated: false, omittedBytes: 0,
  };
  const summary = {
    state: "ok", at: 1, durationMs: 12, entries: 1, bytes: 11, truncated: false,
    shapers: [{
      id: "notes", label: "Notes", stage: "gather", origin: "registered", sha256: null, outcome: "ok",
      reason: null, durationMs: 12, entries: 1, bytes: 11, truncated: false, redacted: false, version: null,
    }],
  };
  const complete = { summary, section: "## Task context\n\nfirst entry", entries: [entry] };
  assert.deepEqual(readShapingRun(complete), complete);
  // A run where no shaper applied is a complete answer: null summary, empty section, no entries.
  assert.deepEqual(readShapingRun({ summary: null, section: "", entries: [] }), { summary: null, section: "", entries: [] });
  // Anything missing, or of the wrong shape, is not a run.
  for (const broken of [
    {},
    null,
    "not json",
    { summary, entries: [entry] },
    { summary, section: "x" },
    { section: "x", entries: [entry] },
    { summary, section: "x", entries: [{ ...entry, body: undefined }] },
    { summary: { state: "ok" }, section: "x", entries: [] },
  ]) {
    assert.equal(readShapingRun(broken), null, JSON.stringify(broken));
  }
});

test("a registered row states its full transport, so two MCP shapers on one server never look the same", () => {
  const server = { type: "http", url: "https://mcp.acme.example/mcp", headers: {} };
  const html = render(view({ shapers: [
    { id: "guidance", label: "Guidance", stage: "select", transport: { type: "mcp", server, tool: "get_guidance" } },
    { id: "lessons", label: "Lessons", stage: "select", transport: { type: "mcp", server, tool: "get_lessons", contextDelivery: "argument" } },
  ] }));
  const row = (id: string) => html.slice(html.indexOf(`data-anchor="task-shaping/${id}"`)).split('class="shaping-row-actions"')[0]!;
  assert.match(row("guidance"), /Calls MCP server: https:\/\/mcp\.acme\.example\/mcp/);
  assert.match(row("guidance"), /Tool: get_guidance/);
  assert.match(row("guidance"), /Context: Folded into the task argument/);
  assert.match(row("lessons"), /Tool: get_lessons/);
  assert.match(row("lessons"), /Context: As a fourth argument, context/);
});

test("a write is confirmed by the outcome it asked for, not by the preview matching", () => {
  // A removal that shadowed a folder shaper: the daemon keeps an off choice for the folder's id.
  // The registration is gone, and that is the confirmation, whatever was kept for the id.
  const removed = view({ shapers: [], overrides: { a: false }, order: ["a"] });
  assert.equal(shapingIntentReflected(removed, { kind: "remove", id: "a" }), true);
  assert.equal(shapingIntentReflected(view({ shapers: [gatherer("a")] }), { kind: "remove", id: "a" }), false);
  // A move into a full order draws nothing, so the unchanged view must not read as confirmed:
  // the daemon's answer decides, and its refusal reaches the row.
  const stale = Array.from({ length: SHAPING_LIMITS.choices }, (_, n) => `gone-${n}`);
  const full = view({ shapers: [gatherer("a"), gatherer("b")], order: stale });
  const move = { kind: "move", id: "b", after: null } as const;
  assert.deepEqual(previewShapingIntent(full, move), full, "nothing drawn");
  assert.equal(shapingIntentReflected(full, move), false);
  // Once B is first among its stage's rows, the same move is confirmed.
  assert.equal(shapingIntentReflected(view({ shapers: [gatherer("a"), gatherer("b")], order: ["b", "a"] }), move), true);
  assert.equal(shapingIntentReflected(view({ shapers: [gatherer("a"), gatherer("b"), gatherer("c")], order: ["a", "b"] }),
    { kind: "move", id: "c", after: "b" }), true);
  // A switch is confirmed by the stored choice.
  assert.equal(shapingIntentReflected(view({ shapers: [gatherer("a")], overrides: { a: true } }), { kind: "enable", id: "a", enabled: true }), true);
  assert.equal(shapingIntentReflected(view({ shapers: [gatherer("a")], overrides: { a: false } }), { kind: "enable", id: "a", enabled: true }), false);
});

test("an id that names an inherited property still gets its own revision, through JSON too", () => {
  const stored = ShapingConfigSchema.parse({ shapers: [gatherer("constructor"), unsupported] });
  const shown = daemonShapingView(stored);
  assert.ok(Object.hasOwn(shown.revisions, "constructor"), "the revision is an own key");
  assert.equal(shown.revisions.constructor, registeredShaperRevision(stored, "constructor", shapingReviser));
  // The browser reads the view as JSON gives it, where the map is an ordinary object again.
  const wire = JSON.parse(JSON.stringify(shown)) as ShapingConfigView;
  const row = shapingList(wire).flatMap((group) => group.rows).find((entry) => entry.id === "constructor")!;
  assert.match(row.revision ?? "", /^[0-9a-f]{16}$/);
  // A view that reports no revision for such an id reads null, never the inherited function.
  assert.equal(shapingViewRevision({ revisions: {} }, "constructor"), null);
  assert.equal(shapingViewRevision({ revisions: {} }, "toString"), null);
});

test("a repeated id is drawn for information only, and its owner says removing it removes the repeat", () => {
  const repeat = gatherer("notes", { label: "Second notes", transport: { type: "command", command: "/usr/local/bin/other" } });
  const stored = ShapingConfigSchema.parse({ shapers: [gatherer("notes"), repeat] });
  const shown = daemonShapingView(stored);
  const rows = shapingList(shown).flatMap((group) => group.rows);
  const owner = rows.find((entry) => entry.id === "notes" && !entry.duplicate)!;
  const copy = rows.find((entry) => entry.duplicate)!;
  assert.equal(owner.revision, registeredShaperRevision(stored, "notes", shapingReviser));
  assert.equal(owner.repeats, 1);
  assert.deepEqual([copy.label, copy.revision, copy.on, copy.repeats], ["Second notes", null, false, 0]);
  assert.equal(copy.problem, 'Another stored shaper already has the id "notes".');
  const html = render(shown);
  assert.match(html, /aria-label="Second notes \(repeated id\)"/);
  assert.equal(/Remove Second notes|Second notes: (on|off)|Dry-run Second notes/.test(html), false, "the repeat has no controls");
  assert.match(html, /aria-label="Remove Gatherer notes"/);
  assert.match(html, /Another stored entry repeats the id notes\. Removing this shaper removes it too\./);
  assert.match(html, /It never runs\. Removing the shaper that owns the id notes removes this entry too\./);
});

test("a refusal that a newer write followed names the earlier action", () => {
  const reason = "It changed.";
  assert.equal(shapingRefusalText({ kind: "enable", id: "notes", enabled: true }, reason, false), reason);
  assert.equal(shapingRefusalText({ kind: "enable", id: "notes", enabled: true }, reason, true),
    "An earlier change, switching notes on, was refused: It changed.");
  assert.equal(shapingRefusalText({ kind: "remove", id: "notes" }, reason, true),
    "An earlier change, removing notes, was refused: It changed.");
  assert.equal(shapingRefusalText({ kind: "move", id: "notes", after: null }, reason, true),
    "An earlier change, moving notes, was refused: It changed.");
});

test("a remove is bound to every entry stored under its id, a repeat included", () => {
  const repeat = (command: string) => gatherer("notes", { label: "Second notes", transport: { type: "command", command } });
  const stored = ShapingConfigSchema.parse({ shapers: [gatherer("notes"), repeat("/usr/local/bin/first")] });
  const shown = daemonShapingView(stored).revisions.notes!;
  // A restore changes only the repeat; the owner is exactly as it was.
  const restored = ShapingConfigSchema.parse({ shapers: [gatherer("notes"), repeat("/usr/local/bin/second")] });
  assert.equal(shapingReviser([restored.shapers[0]!]), shapingReviser([stored.shapers[0]!]), "the owner is unchanged");
  assert.notEqual(daemonShapingView(restored).revisions.notes, shown, "yet the id's revision changed");
  const refused = applyShapingIntent(restored, { kind: "remove", id: "notes", expect: shown }, [], { revise: shapingReviser });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok ? "" : refused.error, "shaper_changed");
  const current = daemonShapingView(restored).revisions.notes!;
  const removed = applyShapingIntent(restored, { kind: "remove", id: "notes", expect: current }, [], { revise: shapingReviser });
  assert.equal(removed.ok && removed.config.shapers.length, 0, "both entries go");
  // A single entry's revision is its own, as before.
  const single = ShapingConfigSchema.parse({ shapers: [gatherer("solo")] });
  assert.equal(daemonShapingView(single).revisions.solo, shapingReviser([single.shapers[0]!]));
});

test("the view says which unsupported entries an import may replace, by the daemon's rule", () => {
  const leaked = gatherer("leaked", { transport: { type: "command", command: "/usr/local/bin/notes", args: ["ghp_" + "a".repeat(36)] } });
  const shown = view({ shapers: [leaked, unsupported] });
  const [replaceable, future] = shown.shapers as Array<{ id: string; replaceable?: true }>;
  assert.equal(replaceable!.replaceable, true, "an entry the daemon emptied a credential in is replaced by an import");
  assert.equal("replaceable" in future!, false, "any other entry this build cannot run is not");
  const stored = ShapingConfigSchema.parse({ shapers: [leaked, unsupported] });
  const corrected = ShaperSchema.parse(gatherer("leaked"));
  assert.equal(applyShapingIntent(stored, { kind: "upsert", shaper: corrected }).ok, true);
  const refused = applyShapingIntent(stored, { kind: "upsert", shaper: { ...corrected, id: "future" } });
  assert.equal(refused.ok ? "" : refused.error, "unsupported_shaper");
});

test("a row and the settings form show their current refusal, with older ones listed apart", () => {
  const html = renderToStaticMarkup(createElement(TaskShapingView, {
    config: view({ shapers: [gatherer("a")] }),
    errors: { "row:a": "The latest reason.", settings: "The settings reason." },
    earlier: { "row:a": ["An earlier change, switching a on, was refused: The older reason."], settings: ["An earlier change, saving the caller identity and budgets, was refused: Older."] },
    onSet: async () => "saved" as const,
    onTest: async () => ({ ok: false as const, aborted: false, reason: "" }),
    repositories: async () => [],
  }));
  assert.match(html, /<p role="alert">The latest reason\.<\/p><div class="shaping-earlier-live" aria-live="polite"><ul class="shaping-earlier-outcomes" aria-label="Earlier outcomes"><li>An earlier change, switching a on, was refused: The older reason\.<\/li><\/ul>/);
  assert.match(html, /<p role="alert">The settings reason\.<\/p><div class="shaping-earlier-live" aria-live="polite"><ul class="shaping-earlier-outcomes" aria-label="Earlier outcomes"><li>An earlier change, saving the caller identity and budgets, was refused: Older\.<\/li><\/ul>/);
  // Nothing is drawn where there is no older refusal.
  assert.equal(/Earlier outcomes/.test(render(view({ shapers: [gatherer("a")] }))), false);
});

test("an enable bound to a revision is reflected only by the definition it was sent for", () => {
  const sent = view({ shapers: [gatherer("a")] });
  const expect = sent.revisions.a!;
  const intent = { kind: "enable" as const, id: "a", enabled: true, expect };
  assert.equal(shapingIntentReflected(view({ shapers: [gatherer("a")], overrides: { a: true } }), intent), true,
    "the same definition switched on");
  // A peer replaced it and switched the replacement on: the choice matches, the definition does not.
  const replaced = view({ shapers: [gatherer("a", { label: "Replacement" })], overrides: { a: true } });
  assert.notEqual(replaced.revisions.a, expect);
  assert.equal(shapingIntentReflected(replaced, intent), false);
  // Without a revision, the choice alone still decides.
  assert.equal(shapingIntentReflected(replaced, { kind: "enable", id: "a", enabled: true }), true);
});

test("a view from a daemon that sends no revisions draws its rows with every revision-bound action off", () => {
  const { revisions: _none, ...older } = view({ shapers: [gatherer("a")], overrides: { a: true } });
  const shown = older as unknown as ShapingConfigView;
  assert.equal(shapingViewRevision(shown, "a"), null);
  const rows = shapingList(shown).flatMap((group) => group.rows);
  assert.deepEqual(rows.map((entry) => [entry.id, entry.revision]), [["a", null]]);
  // Drawing a click on it never throws, and adds no revision map of its own.
  const imported = previewShapingIntent(shown, { kind: "upsert", shaper: ShaperSchema.parse(gatherer("b")) });
  assert.equal("revisions" in imported, false);
  assert.equal("revisions" in previewShapingIntent(shown, { kind: "remove", id: "a" }), false);
  const html = render(shown);
  assert.match(html, /The daemon did not say which definition each shaper is, so switching, removing and dry runs\s+are unavailable here\./);
  for (const name of ["Gatherer a: on", "Remove Gatherer a", "Dry-run Gatherer a"]) {
    assert.match(html, new RegExp(`<button[^>]*aria-label="${name}"[^>]*disabled=""|<button[^>]*disabled=""[^>]*aria-label="${name}"`), name);
  }
  // A view that carries them draws no such note.
  assert.equal(/did not say which definition/.test(render(view({ shapers: [gatherer("a")] }))), false);
});

test("only the owning entry may say an import replaces it, never a repeat behind it", () => {
  // An unsupported owner, then a repeat under its id whose literal credential the store emptied.
  const owner = { id: "twin", label: "Owner", stage: "route", transport: { type: "grpc" } };
  const repeat = gatherer("twin", { label: "Repeat", transport: { type: "command", command: "/usr/local/bin/notes", args: ["ghp_" + "a".repeat(36)] } });
  const stored = ShapingConfigSchema.parse({ shapers: [owner, repeat] });
  const shown = daemonShapingView(stored).shapers as Array<{ label: string; replaceable?: true }>;
  assert.deepEqual(shown.map((entry) => [entry.label, "replaceable" in entry]), [["Owner", false], ["Repeat", false]]);
  // The daemon checks an import against the owner, and refuses it.
  const refused = applyShapingIntent(stored, { kind: "upsert", shaper: ShaperSchema.parse(gatherer("twin")) });
  assert.equal(refused.ok ? "" : refused.error, "unsupported_shaper");
  // The same entry as owner is replaceable, and the daemon agrees.
  const alone = ShapingConfigSchema.parse({ shapers: [repeat] });
  assert.equal((daemonShapingView(alone).shapers[0] as { replaceable?: true }).replaceable, true);
  assert.equal(applyShapingIntent(alone, { kind: "upsert", shaper: ShaperSchema.parse(gatherer("twin")) }).ok, true);
});

test("a switch or removal bound to a replaced definition is not drawn on its replacement", () => {
  const sent = view({ shapers: [gatherer("a")] });
  const expect = sent.revisions.a!;
  const replaced = view({ shapers: [gatherer("a", { label: "Replacement" })] });
  for (const intent of [
    { kind: "enable" as const, id: "a", enabled: true, expect },
    { kind: "remove" as const, id: "a", expect },
  ]) {
    assert.equal(previewShapingIntent(replaced, intent), replaced, `${intent.kind}: the replacement is drawn as stored`);
    assert.notEqual(previewShapingIntent(sent, intent), sent, `${intent.kind}: the definition it was sent for is drawn changed`);
  }
  assert.equal(previewShapingIntent(sent, { kind: "enable", id: "a", enabled: true, expect }).overrides.a, true);
});

test("a revision-bound switch or removal is superseded once its definition is replaced or gone", () => {
  const sent = view({ shapers: [gatherer("a")] });
  const expect = sent.revisions.a!;
  const replaced = view({ shapers: [gatherer("a", { label: "Replacement" })] });
  const gone = view({ shapers: [] });
  for (const intent of [{ kind: "enable" as const, id: "a", enabled: true, expect }, { kind: "remove" as const, id: "a", expect }]) {
    assert.equal(shapingIntentSuperseded(sent, intent), false, `${intent.kind}: still the definition it was sent for`);
    assert.equal(shapingIntentSuperseded(replaced, intent), true, `${intent.kind}: replaced`);
    assert.equal(shapingIntentSuperseded(gone, intent), true, `${intent.kind}: removed`);
  }
  // An intent bound to no revision is never superseded; the other kinds carry none.
  assert.equal(shapingIntentSuperseded(replaced, { kind: "enable", id: "a", enabled: true }), false);
  assert.equal(shapingIntentSuperseded(replaced, { kind: "move", id: "a", after: null }), false);
});

test("an import holds its shaper's row as well as the import control; other writes hold their own", () => {
  const shaper = ShaperSchema.parse(gatherer("held"));
  assert.deepEqual(shapingLockKeys({ kind: "upsert", shaper }, "import"), ["import", "row:held"]);
  assert.deepEqual(shapingLockKeys({ kind: "enable", id: "held", enabled: true }, "row:held"), ["row:held"]);
  assert.deepEqual(shapingLockKeys({ kind: "settings", caller: { user: "x" } }, "settings"), ["settings"]);
});

test("a move holds its stage, and a whole reorder holds every stage", () => {
  const shown = view({ shapers: [gatherer("a"), gatherer("b"), { ...remote }] });
  assert.deepEqual(shapingLockKeys({ kind: "move", id: "a", after: "b" }, "row:a", shown), ["row:a", "stage:gather"]);
  assert.deepEqual(shapingLockKeys({ kind: "move", id: "acme-guidance", after: null }, "row:acme-guidance", shown), ["row:acme-guidance", "stage:select"]);
  // A move of a shaper the view does not draw holds only its own control.
  assert.deepEqual(shapingLockKeys({ kind: "move", id: "nobody", after: null }, "row:nobody", shown), ["row:nobody"]);
  assert.deepEqual(shapingLockKeys({ kind: "reorder", order: ["a", "b"] }, "order", shown),
    ["order", ...SHAPING_STAGES.map((stage) => `stage:${stage}`)]);
});

test("a move bound to a replaced definition is superseded, drawn as stored, refused, and never its receipt", () => {
  const stored = ShapingConfigSchema.parse({ shapers: [gatherer("a"), gatherer("b")] });
  const shown = daemonShapingView(stored);
  const move = moveIntent(shown, "b", -1)!;
  assert.equal(move.expect, shown.revisions.b);
  // Another window imports b again, into the other stage.
  const replacedStored = ShapingConfigSchema.parse({ shapers: [gatherer("a"), { ...remote, id: "b", label: "B elsewhere" }] });
  const replaced = daemonShapingView(replacedStored);
  assert.equal(shapingIntentSuperseded(replaced, move), true);
  assert.equal(previewShapingIntent(replaced, move), replaced);
  assert.equal(shapingIntentReflected({ ...replaced, order: ["b"] }, move), false);
  const refused = applyShapingIntent(replacedStored, move, [], { revise: shapingReviser });
  assert.equal(refused.ok ? "" : refused.error, "shaper_changed");
  // Against the definition it was sent for, it applies.
  assert.equal(applyShapingIntent(stored, move, [], { revise: shapingReviser }).ok, true);
});

test("a row with no revision offers no move, as a daemon older than the dashboard sends none", () => {
  const { revisions: _none, ...older } = view({ shapers: [gatherer("a"), gatherer("b")] });
  const shown = older as unknown as ShapingConfigView;
  assert.equal(moveIntent(shown, "b", -1), null);
  assert.equal(moveIntent(shown, "a", 1), null);
  const html = render(shown);
  for (const name of ["Move Gatherer a down", "Move Gatherer b up"]) {
    assert.match(html, new RegExp(`<button[^>]*aria-label="${name}"[^>]*disabled=""|<button[^>]*disabled=""[^>]*aria-label="${name}"`), name);
  }
  // With revisions, the same moves are offered.
  assert.notEqual(moveIntent(view({ shapers: [gatherer("a"), gatherer("b")] }), "b", -1), null);
});

test("the dashboard places shapers with a kind of its own, so a daemon without it refuses rather than strips the revision", () => {
  const shown = view({ shapers: [gatherer("a"), gatherer("b")] });
  const placement = moveIntent(shown, "b", -1)!;
  assert.equal(placement.kind, "place");
  // A placement is never sent without the revision it is bound to.
  assert.equal(ShapingIntentSchema.safeParse({ kind: "place", id: "b", after: null }).success, false);
  // The kind older daemons know drops a revision it is handed, which is why one is never sent on it:
  // that daemon would apply the move by id alone.
  const stripped = ShapingIntentSchema.safeParse({ kind: "move", id: "b", after: null, expect: placement.expect });
  assert.equal(stripped.success && "expect" in stripped.data, false);
  // An intent schema without a kind refuses it outright, before anything is applied.
  const older = ShapingIntentSchema.options.filter((option) => option.shape.kind.value !== "place");
  assert.equal(z.discriminatedUnion("kind", older as never).safeParse(placement).success, false);
});

test("a placement whose shaper was replaced by one this build cannot run is changed, not unsupported", () => {
  const stored = ShapingConfigSchema.parse({ shapers: [gatherer("a"), gatherer("b")] });
  const placement = moveIntent(daemonShapingView(stored), "b", -1)!;
  // A restore puts an entry this build cannot run under the same id.
  const restored = ShapingConfigSchema.parse({ shapers: [gatherer("a"), { ...unsupported, id: "b" }] });
  const refused = applyShapingIntent(restored, placement, [], { revise: shapingReviser });
  assert.equal(refused.ok ? "" : refused.error, "shaper_changed", "the sender is told to review the replacement");
  // With no entry under the id at all, it is unknown, as before.
  const gone = ShapingConfigSchema.parse({ shapers: [gatherer("a")] });
  const missing = applyShapingIntent(gone, placement, [], { revise: shapingReviser });
  assert.equal(missing.ok ? "" : missing.error, "unknown_shaper");
});

test("a write's answer holds the rows it changed until the stream reaches its commit, whatever lands in between", () => {
  const at = (commit: number | undefined, revisions: Record<string, string>, instance = "daemon-a"): ShapingConfigView => {
    const { commit: _published, ...base } = view({});
    return { ...base, revisions, instance, ...(commit === undefined ? {} : { commit }) };
  };
  assert.deepEqual(shapingViewCommit(at(4, {})), { instance: "daemon-a", commit: 4 });
  assert.equal(shapingViewCommit(at(undefined, {})), null, "a daemon older than commits names none");
  // The import committed at 7. A peer's write to the same row, at 5, reached the view first: its
  // revision differs from the one before the import, yet it is not the import's.
  const answer = at(7, { a: "rev-import", b: "rev-b" });
  const peer = at(5, { a: "rev-peer", b: "rev-b" });
  assert.deepEqual(shapingRowsAhead(peer, answer), ["a"], "the row waits; the unchanged one does not");
  assert.equal(shapingViewReached(peer, { instance: "daemon-a", commit: 7 }), false);
  // The stream reaches the commit, or passes it, and the row is free.
  assert.equal(shapingViewReached(at(7, { a: "rev-import", b: "rev-b" }), { instance: "daemon-a", commit: 7 }), true);
  assert.equal(shapingViewReached(at(9, { a: "rev-later", b: "rev-b" }), { instance: "daemon-a", commit: 7 }), true);
  assert.deepEqual(shapingRowsAhead(at(7, { a: "rev-import", b: "rev-b" }), answer), [], "the frame already arrived");
  // Another daemon process's snapshot, or an answer that names no commit, holds nothing.
  assert.equal(shapingViewReached(at(1, { a: "x" }, "daemon-b"), { instance: "daemon-a", commit: 7 }), true);
  assert.deepEqual(shapingRowsAhead(peer, at(undefined, { a: "rev-import" })), []);
});

test("a late answer for an earlier commit never lowers the commit a row waits for", () => {
  const at = (commit: number, instance = "daemon-a") => ({ instance, commit });
  assert.deepEqual(shapingLaterCommit(undefined, at(5)), at(5), "nothing held yet");
  assert.deepEqual(shapingLaterCommit(at(7), at(5)), at(7), "an import's 7 stands over a late answer's 5");
  assert.deepEqual(shapingLaterCommit(at(5), at(7)), at(7), "a later answer raises it");
  // An answer from another process was compared against that process's view: it is what will arrive.
  assert.deepEqual(shapingLaterCommit(at(9), at(2, "daemon-b")), at(2, "daemon-b"));
});

test("a frame counts as an identical reimport's receipt only once its revision has moved on from a known one", () => {
  const shaper = ShaperSchema.parse(gatherer("same"));
  // Stored as an import stores it: switched off.
  const stored = view({ shapers: [shaper], overrides: { same: false } });
  const request = { kind: "upsert", shaper } as ShapingIntent;
  const withRevision = (revision: string | undefined): ShapingConfigView => {
    const { revisions: _revisions, ...rest } = stored;
    return (revision === undefined ? rest : { ...rest, revisions: { same: revision } }) as ShapingConfigView;
  };
  // Already stored as it was sent, so only a moved revision is evidence.
  const known = shapingReceiptBaseline(withRevision("r1"), request);
  assert.deepEqual(known, { shown: true, revision: "r1" });
  assert.equal(shapingFrameIsReceipt(known, withRevision("r1"), "same"), false, "an unrelated write's frame");
  assert.equal(shapingFrameIsReceipt(known, withRevision("r2"), "same"), true);
  assert.equal(shapingFrameIsReceipt(known, withRevision(undefined), "same"), false, "a rolled-back daemon's frame");
  // A daemon that sends no revisions: nothing to compare, so no frame counts, an unrelated one included.
  const unknown = shapingReceiptBaseline(withRevision(undefined), request);
  assert.deepEqual(unknown, { shown: true, revision: null });
  assert.equal(shapingFrameIsReceipt(unknown, withRevision(undefined), "same"), false);
  // Not stored when it was sent: a frame that shows it stored is evidence, as before.
  const fresh = shapingReceiptBaseline(view({}), request);
  assert.equal(fresh.shown, false);
  assert.equal(shapingFrameIsReceipt(fresh, withRevision(undefined), "same"), true);
});
