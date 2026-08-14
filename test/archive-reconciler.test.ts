import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { archiveKey } from "../src/shared/archives.ts";
import { validReportHtml, writeScoutBundle } from "./helpers/archive-fixture.ts";

/**
 * Discovery: the loop that makes the filesystem the library and SQLite a cache of it.
 *
 * Every case here drives passes explicitly rather than waiting on a cadence, except the one
 * that is specifically about the cadence. That is what keeps the suite deterministic while
 * still exercising the real state machine - the same `trigger()` the timer and the watcher
 * both call.
 */

const home = mkdtempSync(join(tmpdir(), "mission-scout-recon-"));
process.env.MISSION_HOME = home;

const { openDb } = await import("../src/server/db.ts");
const { ArchiveStore, clearArchiveTables } = await import("../src/server/archives/store.ts");
const { ArchiveReconciler } = await import("../src/server/archives/reconciler.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearArchiveTables(db));

let libraries = 0;
function newLibrary(): string {
  libraries += 1;
  const root = join(home, `library-${libraries}`);
  mkdirSync(root, { recursive: true });
  return realpathSync(root);
}

interface Harness {
  root: string;
  store: InstanceType<typeof ArchiveStore>;
  reconciler: InstanceType<typeof ArchiveReconciler>;
  changes: () => number;
}

function harness(overrides: { root?: string } = {}): Harness {
  const root = overrides.root ?? newLibrary();
  const store = new ArchiveStore(db);
  let changes = 0;
  const reconciler = new ArchiveReconciler({
    roots: [root],
    store,
    intervalMs: null,
    watch: false,
    onChanged: () => {
      changes += 1;
    },
  });
  after(() => reconciler.stop());
  return { root, store, reconciler, changes: () => changes };
}

/** New bundles need two agreeing observations before they are believed. */
async function settleTwice(reconciler: InstanceType<typeof ArchiveReconciler>): Promise<void> {
  await reconciler.settle();
  await reconciler.settle();
}

test("one pass discovers every root, and a row remembers which one holds it", async () => {
  // The compatibility window, driven end to end: bundles published before archives declared
  // a kind stay exactly where they were written, and a pass over both roots is what keeps
  // them in one catalog with the new ones rather than in a second, invisible library.
  const writeRoot = newLibrary();
  const legacyRoot = newLibrary();
  const store = new ArchiveStore(db);
  const reconciler = new ArchiveReconciler({
    roots: [writeRoot, legacyRoot],
    store,
    intervalMs: null,
    watch: false,
  });
  after(() => reconciler.stop());

  const fresh = writeScoutBundle(writeRoot, { title: "Written under the archives root" });
  const legacy = writeScoutBundle(legacyRoot, { title: "Published by an older build", legacyFormat: true });
  await settleTwice(reconciler);

  assert.equal(store.get(fresh.key)?.title, "Written under the archives root");
  assert.equal(store.get(legacy.key)?.title, "Published by an older build");
  assert.equal(store.get(legacy.key)?.kind, "scout", "a legacy bundle indexes as the scout it is");
  assert.equal(store.get(fresh.key)?.libraryRoot, writeRoot);
  assert.equal(
    store.get(legacy.key)?.libraryRoot,
    legacyRoot,
    "the row has to name the root that actually holds the files, not the one we write to",
  );
});

test("a bundle copied into both roots is indexed once, from the first root", async () => {
  const writeRoot = newLibrary();
  const legacyRoot = newLibrary();
  const store = new ArchiveStore(db);
  const reconciler = new ArchiveReconciler({
    roots: [writeRoot, legacyRoot],
    store,
    intervalMs: null,
    watch: false,
  });
  after(() => reconciler.stop());

  const written = writeScoutBundle(writeRoot, {});
  cpSync(join(writeRoot, written.producerId), join(legacyRoot, written.producerId), { recursive: true });
  const pass = await (async () => {
    await reconciler.settle();
    return reconciler.settle();
  })();

  assert.equal(pass.scanned, 2, "both copies are candidates - they are the same key on disk twice");
  assert.equal(pass.indexed, 1, "and exactly one of them becomes the row");
  assert.equal(store.count(), 1);
  assert.equal(
    store.get(written.key)?.libraryRoot,
    writeRoot,
    "the first root wins, so the row does not flip between two identical copies each pass",
  );

  // And it stays that way: a second pass must not adopt the other copy and rewrite the row.
  await reconciler.settle();
  assert.equal(store.count(), 1);
  assert.equal(store.get(written.key)?.libraryRoot, writeRoot);
});

test("a bundle only in the legacy root survives pruning driven by the write root", async () => {
  // Pruning is "not seen by a finished pass", and a pass is now several roots. A prune that
  // ran per root would delete every legacy row the moment the archives root was walked.
  const writeRoot = newLibrary();
  const legacyRoot = newLibrary();
  const store = new ArchiveStore(db);
  const reconciler = new ArchiveReconciler({
    roots: [writeRoot, legacyRoot],
    store,
    intervalMs: null,
    watch: false,
  });
  after(() => reconciler.stop());

  const legacy = writeScoutBundle(legacyRoot, { legacyFormat: true });
  await settleTwice(reconciler);
  assert.ok(store.get(legacy.key));

  writeScoutBundle(writeRoot, {});
  await settleTwice(reconciler);
  assert.ok(store.get(legacy.key), "the legacy row is still there after a pass that indexed a new bundle");
  assert.equal(store.count(), 2);
});

test("a new bundle is only indexed once two observations agree about it", async () => {
  const { root, store, reconciler, changes } = harness();
  const written = writeScoutBundle(root, {});

  const first = await reconciler.settle();
  assert.equal(first.pending, 1);
  assert.equal(first.indexed, 0);
  assert.equal(store.get(written.key), null, "a bundle seen once is not yet evidence");
  assert.equal(changes(), 0, "a pass that changed nothing raises no invalidation");

  const second = await reconciler.settle();
  assert.equal(second.indexed, 1);
  assert.equal(second.changed, true);
  assert.equal(store.get(written.key)?.title, "Resume permission loss");
  assert.equal(changes(), 1, "one batch raises exactly one invalidation");
});

test("a bundle whose payload is still arriving stays invisible until it stops moving", async () => {
  const { root, store, reconciler } = harness();
  const written = writeScoutBundle(root, {
    companions: { "chart.png": "the finished bytes" },
    omitFiles: ["report/chart.png"],
  });

  await settleTwice(reconciler);
  assert.equal(store.get(written.key), null, "a half-copied bundle must not flash up as corrupt");

  writeFileSync(join(written.dir, "report/chart.png"), "the finished bytes");
  await settleTwice(reconciler);
  assert.equal(store.get(written.key)?.status, "ready");
});

test("a bundle that never completes is eventually listed as unreadable rather than hidden forever", async () => {
  const { root, store, reconciler } = harness();
  const written = writeScoutBundle(root, {
    companions: { "chart.png": "never arrives" },
    omitFiles: ["report/chart.png"],
  });
  for (let i = 0; i < 4; i += 1) await reconciler.settle();
  const row = store.get(written.key);
  assert.equal(row?.status, "unreadable");
  assert.match(row?.error ?? "", /report\/chart\.png/);
});

test("an unchanged bundle costs a stat: its report and artifacts are never reread", async () => {
  const { root, store, reconciler } = harness();
  const written = writeScoutBundle(root, {});
  await settleTwice(reconciler);
  assert.equal(store.get(written.key)?.title, "Resume permission loss");

  // Rewrite the report WITHOUT touching the manifest. A pass that reparsed bodies would
  // notice; one that compares the manifest fingerprint - which is the contract - will not.
  writeFileSync(join(written.dir, "report/report.html"), validReportHtml("completely different text"));
  const pass = await reconciler.settle();
  assert.equal(pass.unchanged, 1);
  assert.equal(pass.indexed, 0);
  assert.equal(pass.changed, false);
  assert.match(store.get(written.key)?.title ?? "", /Resume permission loss/);
});

test("a rewritten manifest with the same content is re-fingerprinted, not condemned", async () => {
  const { root, store, reconciler } = harness();
  const written = writeScoutBundle(root, {});
  await settleTwice(reconciler);
  const before = store.get(written.key);

  // The shape an rsync leaves behind: identical bytes, a new mtime.
  writeScoutBundle(root, { producerId: written.producerId, archiveId: written.archiveId });
  await settleTwice(reconciler);
  const after = store.get(written.key);
  assert.equal(after?.status, "ready");
  assert.equal(after?.contentDigest, before?.contentDigest);
});

test("an immutable key that now holds different content is unreadable, never silently adopted", async () => {
  const { root, store, reconciler } = harness();
  const written = writeScoutBundle(root, { title: "The original finding" });
  await settleTwice(reconciler);
  assert.equal(store.get(written.key)?.title, "The original finding");

  rmSync(written.dir, { recursive: true, force: true });
  writeScoutBundle(root, {
    producerId: written.producerId,
    archiveId: written.archiveId,
    title: "A different finding entirely",
  });
  await settleTwice(reconciler);

  const row = store.get(written.key);
  assert.equal(row?.status, "unreadable");
  assert.match(row?.error ?? "", /immutable/);
});

test("a bundle copied in from another producer appears with no import step", async () => {
  const source = newLibrary();
  const written = writeScoutBundle(source, { title: "A colleague's scout" });
  const { root, store, reconciler } = harness();
  await settleTwice(reconciler);
  assert.equal(store.count(), 0);

  cpSync(join(source, written.producerId), join(root, written.producerId), { recursive: true });
  await settleTwice(reconciler);
  assert.equal(store.get(written.key)?.title, "A colleague's scout");
  assert.equal(store.get(written.key)?.producerId, written.producerId);
});

test("the same bundle copied under two producer namespaces is two archives", async () => {
  const { root, store, reconciler } = harness();
  const a = writeScoutBundle(root, { title: "Shared question" });
  const b = writeScoutBundle(root, { title: "Shared question" });
  await settleTwice(reconciler);
  assert.equal(store.count(), 2);
  assert.notEqual(a.producerId, b.producerId);
  assert.notEqual(archiveKey(a.producerId, a.archiveId), archiveKey(b.producerId, b.archiveId));
});

test("a bundle that disappears is pruned after a complete pass", async () => {
  const { root, store, reconciler } = harness();
  const kept = writeScoutBundle(root, {});
  const removed = writeScoutBundle(root, {});
  await settleTwice(reconciler);
  assert.equal(store.count(), 2);

  rmSync(removed.dir, { recursive: true, force: true });
  const pass = await reconciler.settle();
  assert.equal(pass.pruned, 1);
  assert.equal(pass.changed, true);
  assert.equal(store.get(removed.key), null);
  assert.equal(store.get(kept.key)?.key, kept.key);
});

test("a wiped database rebuilds itself from the bundles in the background", async () => {
  const { root, store, reconciler } = harness();
  const written = writeScoutBundle(root, { companions: { "evidence.csv": "a,b\n" } });
  await settleTwice(reconciler);
  assert.equal(store.count(), 1);

  // What deleting harness.db and restarting looks like: no rows, and a reconciler with no
  // memory of ever having seen anything.
  clearArchiveTables(db);
  const restarted = harness({ root });
  assert.equal(restarted.store.count(), 0);
  await settleTwice(restarted.reconciler);
  const row = restarted.store.get(written.key);
  assert.equal(row?.title, "Resume permission loss");
  assert.equal(restarted.store.artifacts(written.key).length, 2);
  assert.equal(
    restarted.store.list({
      q: "resume path never replayed",
      producer: null,
      repo: null,
      agent: null,
      kind: null,
      status: null,
      from: null,
      to: null,
      cursor: null,
      limit: 30,
    }).rows.length,
    1,
    "search over the report body is rebuilt too, not just the summary row",
  );
});

test("reserved and unrecognised directories are never candidates", async () => {
  const { root, store, reconciler } = harness();
  const good = writeScoutBundle(root, {});
  // A staging directory, a trash directory, and something an operator dropped in by hand -
  // each shaped exactly like a bundle apart from its name.
  for (const name of [".staging", ".trash", "not-a-uuid", "README"]) {
    const impostor = writeScoutBundle(join(root, name), {});
    assert.ok(impostor.dir.includes(name));
  }
  await settleTwice(reconciler);
  assert.equal(store.count(), 1);
  assert.equal(store.get(good.key)?.key, good.key);
});

test("overlapping triggers coalesce into one extra pass, never a pass each", async () => {
  const { root, reconciler } = harness();
  writeScoutBundle(root, {});
  await Promise.all([reconciler.trigger(), reconciler.trigger(), reconciler.trigger()]);
  assert.equal(reconciler.passCount, 2, "one running pass plus exactly one coalesced re-run");
});

test("a locally published bundle skips the settle wait but not verification", async () => {
  const { root, store, reconciler } = harness();
  const written = writeScoutBundle(root, {});
  reconciler.notifyPublished({ producerId: written.producerId, archiveId: written.archiveId });
  await reconciler.settle();
  assert.equal(store.get(written.key)?.status, "ready", "an atomic rename has nothing to wait for");

  const broken = writeScoutBundle(root, {
    reportHtml: `<!doctype html><html><body><script>x()</script></body></html>`,
  });
  reconciler.notifyPublished({ producerId: broken.producerId, archiveId: broken.archiveId });
  await reconciler.settle();
  assert.equal(store.get(broken.key)?.status, "unreadable", "skipping the wait is not skipping the checks");
});

test("the recurring cadence discovers a bundle with no trigger and no watcher", async () => {
  const root = newLibrary();
  const store = new ArchiveStore(db);
  const reconciler = new ArchiveReconciler({ roots: [root], store, intervalMs: 25, watch: false });
  after(() => reconciler.stop());
  const written = writeScoutBundle(root, {});
  reconciler.start();

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && store.get(written.key) === null) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(store.get(written.key)?.status, "ready");
  assert.ok(reconciler.passCount >= 2, "the cadence, not one bootstrap pass, is what found it");
});

test("start() returns before its first pass has finished", async () => {
  const { root, store, reconciler } = harness();
  writeScoutBundle(root, {});
  reconciler.start();
  assert.equal(store.count(), 0, "startup must not wait on a library walk");
  await settleTwice(reconciler);
  assert.equal(store.count(), 1);
});

test("an interrupted deletion is finished on the next start", async () => {
  const { root, reconciler } = harness();
  const trash = join(root, ".trash");
  mkdirSync(trash, { recursive: true });
  writeScoutBundle(trash, {});
  await reconciler.settle();
  assert.equal(
    readdirSync(trash).length,
    0,
    "a bundle left mid-deletion is removed rather than left to accumulate",
  );
});

test("a pass over a library that does not exist is a complete, empty pass", async () => {
  const store = new ArchiveStore(db);
  const reconciler = new ArchiveReconciler({
    roots: [join(home, "never-created")],
    store,
    intervalMs: null,
    watch: false,
  });
  after(() => reconciler.stop());
  const pass = await reconciler.settle();
  assert.equal(pass.failed, null);
  assert.equal(pass.scanned, 0);
});

test("a manifest replaced non-atomically does not lose its archive from the catalog", async () => {
  const { root, store, reconciler } = harness();
  const written = writeScoutBundle(root, {});
  await settleTwice(reconciler);
  assert.equal(store.get(written.key)?.status, "ready");

  // What an rsync --inplace, an unpacker, or a hand edit looks like from a pass that lands in
  // the middle: the directory is there, the manifest is not, for one observation.
  const manifest = join(written.dir, "manifest.json");
  const aside = join(written.dir, "manifest.json.tmp");
  renameSync(manifest, aside);
  const during = await reconciler.settle();
  assert.equal(during.pruned, 0, "one unlucky observation must not drop a live archive");
  assert.equal(store.get(written.key)?.status, "ready");

  renameSync(aside, manifest);
  const after = await reconciler.settle();
  assert.equal(after.pruned, 0);
  assert.equal(store.get(written.key)?.status, "ready");
});

test("a directory whose manifest is really gone is pruned rather than held for ever", async () => {
  const { root, store, reconciler } = harness();
  const written = writeScoutBundle(root, {});
  await settleTwice(reconciler);
  rmSync(join(written.dir, "manifest.json"));
  let pruned = 0;
  for (let i = 0; i < 5; i += 1) pruned += (await reconciler.settle()).pruned;
  assert.equal(pruned, 1, "the grace period is bounded");
  assert.equal(store.get(written.key), null);
});

test("a published bundle that never completes is refused rather than left invisible", async () => {
  const { root, store, reconciler } = harness();
  const written = writeScoutBundle(root, {
    companions: { "chart.png": "never arrives" },
    omitFiles: ["report/chart.png"],
  });
  // The settle fast path used to return before any bookkeeping existed, so the
  // incomplete counter could never rise and this archive stayed absent for ever with no
  // diagnostic - the one outcome the escalation exists to prevent.
  reconciler.notifyPublished({ producerId: written.producerId, archiveId: written.archiveId });
  for (let i = 0; i < 5; i += 1) await reconciler.settle();
  const row = store.get(written.key);
  assert.equal(row?.status, "unreadable");
  assert.match(row?.error ?? "", /report\/chart\.png/);
});

test("a second rewrite of an immutable key is refused too, and the first is still on the record", async () => {
  const { root, store, reconciler } = harness();
  const written = writeScoutBundle(root, { title: "The original finding" });
  await settleTwice(reconciler);

  const rewrite = (title: string): void => {
    rmSync(written.dir, { recursive: true, force: true });
    writeScoutBundle(root, { producerId: written.producerId, archiveId: written.archiveId, title });
  };

  rewrite("Rewrite one");
  await settleTwice(reconciler);
  assert.equal(store.get(written.key)?.status, "unreadable");

  // The guard used to skip any row already marked unreadable, so a second rewrite was
  // adopted as ready - indexing the attacker's content AND clearing the error that was the
  // only evidence of the first tamper.
  rewrite("Rewrite two");
  await settleTwice(reconciler);
  const row = store.get(written.key);
  assert.equal(row?.status, "unreadable");
  assert.match(row?.error ?? "", /immutable/);
  assert.equal(row?.title, "");
});

test("restoring the original bytes clears an immutable-key refusal", async () => {
  const { root, store, reconciler } = harness();
  const written = writeScoutBundle(root, { title: "The original finding" });
  const original = join(root, "original-copy");
  cpSync(written.dir, original, { recursive: true });
  await settleTwice(reconciler);

  rmSync(written.dir, { recursive: true, force: true });
  writeScoutBundle(root, { producerId: written.producerId, archiveId: written.archiveId, title: "Tampered" });
  await settleTwice(reconciler);
  assert.equal(store.get(written.key)?.status, "unreadable");

  rmSync(written.dir, { recursive: true, force: true });
  cpSync(original, written.dir, { recursive: true });
  await settleTwice(reconciler);
  const row = store.get(written.key);
  assert.equal(row?.status, "ready", "the refusal is about the bytes, not a permanent mark on the key");
  assert.equal(row?.title, "The original finding");
});
