import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { rename as renamePath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import type { Hono } from "hono";
import type { ServerEvent } from "../src/shared/types.ts";
import { writeScoutBundle } from "./helpers/archive-fixture.ts";

/** The loopback Host every data endpoint requires. See `hostIsLoopback` in routes.ts. */
const LOOPBACK = { host: "127.0.0.1:7317" };
const JSON_HEADERS = { ...LOOPBACK, "content-type": "application/json" };

/**
 * The bounded HTTP surface: five thin adapters, and everything they must refuse.
 *
 * Route tests rather than manager tests wherever a header, a status code, or a schema is the
 * thing under test - those are the parts a browser and an external tool actually meet.
 */

const home = mkdtempSync(join(tmpdir(), "mission-scout-http-"));
process.env.MISSION_HOME = home;

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ArchiveStore, clearArchiveTables } = await import("../src/server/archives/store.ts");
const { ArchiveError, ArchiveManager } = await import("../src/server/archives/manager.ts");
const { ArchiveTitleStore } = await import("../src/server/archives/titles.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { provisionScoutSubmissionCredential } = await import(
  "../src/server/scouts/submission-auth.ts"
);
const { SCOUT_SUBMISSION_CREDENTIAL_HEADER } = await import(
  "../src/shared/harness-runtime.mjs"
);
import type { ArchiveTaskGateway } from "../src/server/archives/task-gateway.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskManager } from "../src/server/tasks.ts";
import type { QueueManager } from "../src/server/queue.ts";

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

let libraries = 0;
function newLibrary(): string {
  libraries += 1;
  const root = join(home, `library-${libraries}`);
  mkdirSync(root, { recursive: true });
  return realpathSync(root);
}

interface Harness {
  app: Hono;
  root: string;
  manager: InstanceType<typeof ArchiveManager>;
  events: ServerEvent[];
  opened: string[];
}

function harness(
  options: {
    rename?: (from: string, to: string) => Promise<void>;
    titleStore?: InstanceType<typeof ArchiveTitleStore>;
    root?: string;
    /**
     * Roots that are read and never written. Absent means none, because naming `root`
     * explicitly means "this directory is the library" - see `ArchiveLibrary`.
     */
    legacyRoots?: readonly string[];
    /**
     * A task gateway, for the submission route only.
     *
     * Absent by default so every read test keeps proving that the read surface needs no task
     * knowledge at all - which is the Phase 1 contract this file was written against.
     */
    tasks?: ArchiveTaskGateway;
  } = {},
): Harness {
  const root = options.root ?? newLibrary();
  const registry = new Registry();
  const events: ServerEvent[] = [];
  registry.subscribe((event) => events.push(event));
  const opened: string[] = [];
  const manager = new ArchiveManager({
    root,
    legacyRoots: options.legacyRoots,
    store: new ArchiveStore(db),
    producer: { id: "00000000-0000-4000-8000-000000000000", label: null },
    intervalMs: null,
    watch: false,
    onChanged: () => registry.emitArchiveChanged(),
    rename: options.rename,
    titleStore: options.titleStore,
    tasks: options.tasks,
    openTarget: async (_target, path) => {
      opened.push(path);
      return { ok: true, label: "Browser", detail: "Fake", status: 200 };
    },
  });
  after(() => manager.stop());
  const app = buildApp({
    registry,
    reviews: {} as ReviewManager,
    tasks: {} as TaskManager,
    queues: {} as QueueManager,
    archives: manager,
  });
  return { app, root, manager, events, opened };
}

/** Two passes, because a newly written bundle must settle before it is believed. */
async function settle(manager: InstanceType<typeof ArchiveManager>): Promise<void> {
  await manager.reconcileNow();
  await manager.reconcileNow();
}

beforeEach(() => clearArchiveTables(db));

// ---------------------------------------------------------------------------
// The compatibility window, end to end
// ---------------------------------------------------------------------------

test("a bundle an older build published is still listed, and still readable, through the archive routes", async () => {
  // The upgrade an operator actually performs: a library written by a build that predates
  // the kind discriminator, opened by this one. Nothing moves, nothing is rewritten, and the
  // whole route surface has to keep answering for it - which is what makes "the legacy ones
  // stay readable" a property somebody can check rather than a claim in a document.
  //
  // Both roots are the DAEMON'S OWN, resolved from `MISSION_HOME` rather than handed in, so
  // this also pins the wiring: `ARCHIVES_DIR` is written and `LEGACY_SCOUTS_DIR` is read.
  const config = await import("../src/server/config.ts");
  mkdirSync(config.ARCHIVES_DIR, { recursive: true });
  mkdirSync(config.LEGACY_SCOUTS_DIR, { recursive: true });
  // Realpath'd because the index stores the root it actually walked, and macOS resolves the
  // temp dir through a symlink - the same reason `newLibrary()` above does it.
  const ARCHIVES_DIR = realpathSync(config.ARCHIVES_DIR);
  const LEGACY_SCOUTS_DIR = realpathSync(config.LEGACY_SCOUTS_DIR);
  const legacy = writeScoutBundle(LEGACY_SCOUTS_DIR, {
    legacyFormat: true,
    title: "Published before archives declared a kind",
    companions: { "permission-events.csv": "when,what\n1,grant missing\n" },
  });
  // Proof the fixture is what it claims to be: the old format string, and no kind field.
  const onDisk = JSON.parse(readFileSync(join(legacy.dir, "manifest.json"), "utf8")) as Record<string, unknown>;
  assert.equal(onDisk.format, "mission-control/scout-archive");
  assert.equal("kind" in onDisk, false);

  const { app, manager } = harness({ root: ARCHIVES_DIR, legacyRoots: [LEGACY_SCOUTS_DIR] });
  await settle(manager);

  const list = (await (await app.request("/api/archives", { headers: LOOPBACK })).json()) as {
    archives: Array<{ key: string; kind: string | null; status: string; title: string }>;
    libraryPath: string;
  };
  assert.equal(list.archives.length, 1);
  assert.equal(list.archives[0]?.key, legacy.key);
  assert.equal(list.archives[0]?.kind, "scout", "a manifest with no kind field is the scout it always was");
  assert.equal(list.archives[0]?.status, "ready");
  assert.equal(list.archives[0]?.title, "Published before archives declared a kind");
  assert.equal(list.libraryPath, ARCHIVES_DIR, "new work is written to the new root, not the one this came from");

  // The kind filter reaches it, and does not reach past it.
  const scouts = (await (await app.request("/api/archives?kind=scout", { headers: LOOPBACK })).json()) as {
    archives: unknown[];
  };
  assert.equal(scouts.archives.length, 1);
  const plans = (await (await app.request("/api/archives?kind=plan", { headers: LOOPBACK })).json()) as {
    archives: unknown[];
  };
  assert.equal(plans.archives.length, 0);

  // The detail route names the directory that actually holds the files - the legacy root.
  const detail = (await (await app.request(`/api/archives/${legacy.key}`, { headers: LOOPBACK })).json()) as {
    kind: string | null;
    bundlePath: string;
    formatVersion: number;
    prompts: null;
    artifacts: Array<{ id: string }>;
  };
  assert.equal(detail.kind, "scout");
  assert.equal(detail.formatVersion, 1);
  assert.equal(detail.prompts, null);
  assert.equal(detail.bundlePath, legacy.dir);
  assert.ok(detail.bundlePath.startsWith(LEGACY_SCOUTS_DIR), "nothing was moved into the new root");

  // And the bytes come back: the report, and a companion beside it.
  const report = await app.request(`/api/archives/${legacy.key}/artifacts/report`, { headers: LOOPBACK });
  assert.equal(report.status, 200);
  assert.equal(report.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await report.text(), /Resume permission loss/);

  const companion = await app.request(`/api/archives/${legacy.key}/artifacts/artifact-01`, { headers: LOOPBACK });
  assert.equal(companion.status, 200);
  assert.equal(await companion.text(), "when,what\n1,grant missing\n");
});

test("a bundle in each root appears in one catalog, from one pass", async () => {
  const config = await import("../src/server/config.ts");
  mkdirSync(config.LEGACY_SCOUTS_DIR, { recursive: true });
  mkdirSync(config.ARCHIVES_DIR, { recursive: true });
  const ARCHIVES_DIR = realpathSync(config.ARCHIVES_DIR);
  const LEGACY_SCOUTS_DIR = realpathSync(config.LEGACY_SCOUTS_DIR);
  const legacy = writeScoutBundle(LEGACY_SCOUTS_DIR, { legacyFormat: true, title: "The old one" });
  const fresh = writeScoutBundle(ARCHIVES_DIR, { title: "The new one" });

  const { app, manager } = harness({ root: ARCHIVES_DIR, legacyRoots: [LEGACY_SCOUTS_DIR] });
  await settle(manager);

  const list = (await (await app.request("/api/archives", { headers: LOOPBACK })).json()) as {
    archives: Array<{ key: string; kind: string | null }>;
  };
  const keys = list.archives.map((row) => row.key);
  // Containment rather than equality: these tests share the daemon's own roots on disk, and
  // `clearArchiveTables` clears rows rather than directories, so a bundle an earlier test
  // wrote is legitimately still there. What is under test is that ONE query answers for both
  // roots, which containment says exactly.
  assert.ok(keys.includes(legacy.key), "the bundle under the legacy root is in the catalog");
  assert.ok(keys.includes(fresh.key), "so is the one under the write root");
  for (const row of list.archives) assert.equal(row.kind, "scout");
});

test("the list route returns bounded summaries and the library path", async () => {
  const { app, root, manager } = harness();
  writeScoutBundle(root, { title: "Resume permission loss" });
  await settle(manager);

  const res = await app.request("/api/archives", { headers: LOOPBACK });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { archives: Array<Record<string, unknown>>; libraryPath: string };
  assert.equal(body.archives.length, 1);
  assert.equal(body.archives[0]?.title, "Resume permission loss");
  assert.equal(body.archives[0]?.status, "ready");
  assert.equal(body.archives[0]?.hasPrimaryReport, true);
  assert.equal(body.libraryPath, root);
  assert.equal(
    Object.hasOwn(body.archives[0] ?? {}, "artifacts"),
    false,
    "a list row carries no artifact table and no bodies",
  );
});

test("search returns a snippet naming why the row matched", async () => {
  const { app, root, manager } = harness();
  writeScoutBundle(root, {
    prompts: {
      entries: [
        { kind: "initial", text: "Find the resume issue", at: null },
        { kind: "follow_up", text: "Check the prompt-only clarification", at: null },
      ],
      truncated: false,
    },
  });
  await settle(manager);

  const res = await app.request("/api/archives?q=" + encodeURIComponent("never replayed"), { headers: LOOPBACK });
  const body = (await res.json()) as {
    archives: Array<{ snippet: { kind: string; text: string } | null }>;
  };
  assert.equal(body.archives.length, 1);
  assert.equal(body.archives[0]?.snippet?.kind, "report_text");
  assert.match(body.archives[0]?.snippet?.text ?? "", /never replayed/);

  const prompt = await app.request(
    "/api/archives?q=" + encodeURIComponent("prompt-only clarification"),
    { headers: LOOPBACK },
  );
  const promptBody = (await prompt.json()) as {
    archives: Array<{ snippet: { kind: string; text: string } | null }>;
  };
  assert.equal(promptBody.archives[0]?.snippet?.kind, "prompt");

  const miss = await app.request("/api/archives?q=" + encodeURIComponent("nothing matches this"), { headers: LOOPBACK });
  assert.deepEqual(((await miss.json()) as { archives: unknown[] }).archives, []);
});

test("an out-of-range limit or a forged cursor is refused, never clamped or ignored", async () => {
  const { app } = harness();
  assert.equal((await app.request("/api/archives?limit=5000", { headers: LOOPBACK })).status, 400);
  assert.equal((await app.request("/api/archives?limit=0", { headers: LOOPBACK })).status, 400);
  assert.equal((await app.request("/api/archives?cursor=nonsense", { headers: LOOPBACK })).status, 400);
  assert.equal((await app.request("/api/archives?producer=../../etc", { headers: LOOPBACK })).status, 400);
  assert.equal((await app.request("/api/archives?status=perfect", { headers: LOOPBACK })).status, 400);
});

test("the detail route adds provenance, artifacts, and a copyable bundle path", async () => {
  const { app, root, manager } = harness();
  const written = writeScoutBundle(root, {
    companions: { "permission-events.csv": "when,what\n" },
    supporting: { "repo-01/evidence/run.log": "line\n" },
    prompts: {
      entries: [
        { kind: "initial", text: "Why did resume lose permissions?", at: null },
        { kind: "follow_up", text: "Also compare Pi.", at: "2026-08-12T18:45:00.000Z" },
      ],
      truncated: false,
    },
  });
  await settle(manager);

  const res = await app.request(`/api/archives/${written.key}`, { headers: LOOPBACK });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    bundlePath: string;
    relativePath: string;
    primaryArtifactId: string;
    contentDigest: string;
    prompts: { entries: Array<{ kind: string; text: string; at: string | null }>; truncated: boolean };
    artifacts: Array<{ id: string; archivePath: string; mediaType: string; bytes: number }>;
    missing: unknown[];
  };
  assert.equal(body.bundlePath, written.dir);
  assert.equal(body.relativePath, `${written.producerId}/${written.archiveId}`);
  assert.equal(body.primaryArtifactId, "report");
  assert.match(body.contentDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(body.prompts.entries[1]?.text, "Also compare Pi.");
  assert.equal(body.prompts.truncated, false);
  assert.equal(body.artifacts.length, 3);
  assert.equal(body.artifacts[0]?.mediaType, "text/html; charset=utf-8");
  assert.deepEqual(body.missing, []);
});

test("an unknown or malformed archive key is a 404, and never a path", async () => {
  const { app } = harness();
  assert.equal((await app.request("/api/archives/nope", { headers: LOOPBACK })).status, 404);
  assert.equal(
    (await app.request("/api/archives/00000000-0000-4000-8000-000000000000~00000000-0000-4000-8000-000000000001", { headers: LOOPBACK }))
      .status,
    404,
  );
  assert.equal((await app.request("/api/archives/..%2F..%2Fetc", { headers: LOOPBACK })).status, 404);
});

test("an artifact body is served as an attachment with headers taken from its own path", async () => {
  const { app, root, manager } = harness();
  const written = writeScoutBundle(root, { companions: { "permission-events.csv": "when,what\n1,lost\n" } });
  await settle(manager);

  const res = await app.request(`/api/archives/${written.key}/artifacts/artifact-01`, { headers: LOOPBACK });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="permission-events.csv"');
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(res.headers.get("content-length"), "17");
  assert.equal(await res.text(), "when,what\n1,lost\n");
});

test("the HTML report is served as an attachment too, never inline on the daemon origin", async () => {
  const { app, root, manager } = harness();
  const written = writeScoutBundle(root, {});
  await settle(manager);

  const res = await app.request(`/api/archives/${written.key}/artifacts/report`, { headers: LOOPBACK });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.equal(await res.text(), readFileSync(join(written.dir, "report/report.html"), "utf8"));
});

test("an artifact route accepts only generated ids, never a path", async () => {
  const { app, root, manager } = harness();
  const written = writeScoutBundle(root, {});
  await settle(manager);
  for (const id of ["report.html", "..", "%2e%2e%2fmanifest.json", "artifact-99"]) {
    const res = await app.request(`/api/archives/${written.key}/artifacts/${id}`, { headers: LOOPBACK });
    assert.equal(res.status, 404, `${id} must not address a file`);
  }
});

test("a deleted file under an indexed archive is a 404, not a stack trace", async () => {
  const { app, root, manager } = harness();
  const written = writeScoutBundle(root, { companions: { "a.csv": "1" } });
  await settle(manager);
  rmSync(join(written.dir, "report/a.csv"));
  const res = await app.request(`/api/archives/${written.key}/artifacts/artifact-01`, { headers: LOOPBACK });
  assert.equal(res.status, 404);
});

test("renaming changes the local catalog and search without rewriting the immutable bundle", async () => {
  const { app, root, manager, events } = harness();
  const written = writeScoutBundle(root, { title: "Portable title before rename" });
  await settle(manager);
  const manifestPath = join(written.dir, "manifest.json");
  const manifestBefore = readFileSync(manifestPath, "utf8");
  events.length = 0;

  const blank = await app.request(`/api/archives/${written.key}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ title: "   " }),
  });
  assert.equal(blank.status, 400);

  const renamed = await app.request(`/api/archives/${written.key}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ title: "  Reconnect grant finding  " }),
  });
  assert.equal(renamed.status, 200);
  assert.deepEqual(await renamed.json(), { ok: true, title: "Reconnect grant finding" });
  assert.deepEqual(events, [{ type: "archive_changed" }], "one accepted rename is one invalidation");

  const detail = (await (await app.request(`/api/archives/${written.key}`, { headers: LOOPBACK })).json()) as {
    title: string;
  };
  assert.equal(detail.title, "Reconnect grant finding");
  const match = (await (await app.request("/api/archives?q=reconnect%20grant%20finding", {
    headers: LOOPBACK,
  })).json()) as { archives: Array<{ key: string; title: string }> };
  assert.deepEqual(match.archives.map((archive) => [archive.key, archive.title]), [
    [written.key, "Reconnect grant finding"],
  ]);
  assert.equal(readFileSync(manifestPath, "utf8"), manifestBefore, "rename never changes evidence bytes");

  const sidecar = join(root, ".metadata", "names", `${written.key}.json`);
  assert.equal(existsSync(sidecar), true, "the durable name lives beside, not inside, the bundle");

  // Prove the sidecar is the authority rather than the disposable row: erase the whole
  // index, construct the manager a daemon restart would construct, and rediscover.
  manager.stop();
  clearArchiveTables(db);
  const restarted = harness({ root });
  await settle(restarted.manager);
  const rebuilt = (await (await restarted.app.request(`/api/archives/${written.key}`, {
    headers: LOOPBACK,
  })).json()) as { title: string };
  assert.equal(rebuilt.title, "Reconnect grant finding");
  assert.equal(readFileSync(manifestPath, "utf8"), manifestBefore);

  const deleted = await restarted.app.request(`/api/archives/${written.key}`, {
    method: "DELETE",
    headers: JSON_HEADERS,
    body: JSON.stringify({ confirmArchiveKey: written.key }),
  });
  assert.equal(deleted.status, 200);
  assert.equal(existsSync(sidecar), false, "deleting the archive also removes its local name");
});

test("a rename queued behind deletion cannot retain a name for the deleted archive", async () => {
  const root = newLibrary();
  let titleWrites = 0;
  class CountingTitleStore extends ArchiveTitleStore {
    override async set(key: string, title: string): Promise<string> {
      titleWrites += 1;
      return super.set(key, title);
    }
  }

  let deletionReachedRename!: () => void;
  const deletionAtRename = new Promise<void>((resolve) => {
    deletionReachedRename = resolve;
  });
  let releaseDeletion!: () => void;
  const deletionReleased = new Promise<void>((resolve) => {
    releaseDeletion = resolve;
  });
  const { manager } = harness({
    root,
    titleStore: new CountingTitleStore(root),
    rename: async (from, to) => {
      deletionReachedRename();
      await deletionReleased;
      await renamePath(from, to);
    },
  });
  const written = writeScoutBundle(root, { title: "Archive being deleted" });
  await settle(manager);

  // Hold deletion after it owns this key but before its durable bundle move. A concurrent
  // rename sees the indexed row at this instant, which is the exact old race: without the
  // per-key queue it enters the sidecar write now and can finish after deletion removed it.
  const deleting = manager.delete(written.key, written.key);
  await deletionAtRename;
  const renameRejected = assert.rejects(
    manager.renameArchive(written.key, "Name that must not survive"),
    (error: unknown) => error instanceof ArchiveError && error.status === 404,
  );
  assert.equal(titleWrites, 0, "the queued rename has not crossed the deletion");

  releaseDeletion();
  assert.deepEqual(await deleting, { ok: true, deletedBundle: true });
  await renameRejected;
  assert.equal(titleWrites, 0, "the rename rechecks the row after deletion and writes nothing");
  const sidecar = join(root, ".metadata", "names", `${written.key}.json`);
  assert.equal(existsSync(sidecar), false);

  // Reusing the generated identity later must read the new bundle's own title. A stale
  // sidecar is durable, so this assertion catches the user-visible consequence of the race.
  writeScoutBundle(root, {
    producerId: written.producerId,
    archiveId: written.archiveId,
    title: "Fresh archive with the reused key",
  });
  await settle(manager);
  assert.equal(manager.detail(written.key)?.title, "Fresh archive with the reused key");
});

test("a rename cannot persist a title after its bundle was removed externally", async () => {
  const { manager, root } = harness();
  const written = writeScoutBundle(root, { title: "Archive removed outside Mission Control" });
  await settle(manager);
  rmSync(written.dir, { recursive: true, force: true });

  await assert.rejects(
    manager.renameArchive(written.key, "Name that must not outlive the bundle"),
    (error: unknown) => error instanceof ArchiveError && error.status === 404,
  );
  const sidecar = join(root, ".metadata", "names", `${written.key}.json`);
  assert.equal(existsSync(sidecar), false, "filesystem revalidation happens before the sidecar write");

  await manager.reconcileNow();
  writeScoutBundle(root, {
    producerId: written.producerId,
    archiveId: written.archiveId,
    title: "Fresh archive after external removal",
  });
  await settle(manager);
  assert.equal(manager.detail(written.key)?.title, "Fresh archive after external removal");
});

test("a rename compensates when reconciliation removes its archive during the sidecar write", async () => {
  const root = newLibrary();
  let sidecarWritten!: () => void;
  const writtenSidecar = new Promise<void>((resolve) => {
    sidecarWritten = resolve;
  });
  let releaseWrite!: () => void;
  const writeReleased = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  class PausedTitleStore extends ArchiveTitleStore {
    override async set(key: string, title: string): Promise<string> {
      const saved = await super.set(key, title);
      sidecarWritten();
      await writeReleased;
      return saved;
    }
  }

  const { manager } = harness({ root, titleStore: new PausedTitleStore(root) });
  const written = writeScoutBundle(root, { title: "Archive reconciliation will remove" });
  await settle(manager);
  const sidecar = join(root, ".metadata", "names", `${written.key}.json`);

  const renaming = assert.rejects(
    manager.renameArchive(written.key, "Name written during reconciliation"),
    (error: unknown) => error instanceof ArchiveError && error.status === 404,
  );
  await writtenSidecar;
  rmSync(written.dir, { recursive: true, force: true });
  const pass = await manager.reconcileNow();
  assert.equal(pass.pruned, 1);
  assert.equal(manager.detail(written.key), null);

  releaseWrite();
  await renaming;
  assert.equal(existsSync(sidecar), false, "the losing rename removes its just-written sidecar");

  writeScoutBundle(root, {
    producerId: written.producerId,
    archiveId: written.archiveId,
    title: "Fresh title after reconciliation",
  });
  await settle(manager);
  assert.equal(manager.detail(written.key)?.title, "Fresh title after reconciliation");
});

test("a rename surfaces failure to compensate after reconciliation removes its archive", async () => {
  const root = newLibrary();
  let sidecarWritten!: () => void;
  const writtenSidecar = new Promise<void>((resolve) => {
    sidecarWritten = resolve;
  });
  let releaseWrite!: () => void;
  const writeReleased = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  class FailedCompensationTitleStore extends ArchiveTitleStore {
    override async set(key: string, title: string): Promise<string> {
      const saved = await super.set(key, title);
      sidecarWritten();
      await writeReleased;
      return saved;
    }

    override async remove(): Promise<void> {
      throw new Error("the metadata disk became read-only");
    }
  }

  const { manager } = harness({ root, titleStore: new FailedCompensationTitleStore(root) });
  const written = writeScoutBundle(root, { title: "Archive reconciliation will remove" });
  await settle(manager);

  const renaming = assert.rejects(
    manager.renameArchive(written.key, "Name whose cleanup fails"),
    (error: unknown) =>
      error instanceof ArchiveError &&
      error.status === 500 &&
      /display name could not be removed/.test(error.message),
  );
  await writtenSidecar;
  rmSync(written.dir, { recursive: true, force: true });
  await manager.reconcileNow();
  releaseWrite();
  await renaming;
});

test("display-name cleanup failure makes deletion fail and remains retryable after restart", async () => {
  const root = newLibrary();
  class FailingOnceTitleStore extends ArchiveTitleStore {
    private removals = 0;

    override async remove(key: string): Promise<void> {
      this.removals += 1;
      if (this.removals === 1) throw new Error("the metadata disk is read-only");
      await super.remove(key);
    }
  }

  const { app, manager } = harness({ root, titleStore: new FailingOnceTitleStore(root) });
  const written = writeScoutBundle(root, { title: "Archive before failed cleanup" });
  await settle(manager);
  await manager.renameArchive(written.key, "Durable name awaiting cleanup");
  const sidecar = join(root, ".metadata", "names", `${written.key}.json`);

  const failed = await app.request(`/api/archives/${written.key}`, {
    method: "DELETE",
    headers: JSON_HEADERS,
    body: JSON.stringify({ confirmArchiveKey: written.key }),
  });
  assert.equal(failed.status, 500, "the route must not claim the deletion completed");
  assert.match(((await failed.json()) as { error: string }).error, /retry deletion/);
  assert.equal(existsSync(written.dir), false, "the durable bundle move already happened");
  assert.equal(existsSync(sidecar), true, "the failed cleanup remains present for a retry");
  assert.equal(
    manager.detail(written.key)?.title,
    "Durable name awaiting cleanup",
    "the row remains as the in-process retry marker",
  );
  const trash = join(root, ".trash");
  const interruptedGraves = readdirSync(trash).filter((name) => name.startsWith(`${written.key}.`));
  assert.equal(interruptedGraves.length, 1, "the failed attempt retains the moved bundle for retry cleanup");

  // Reconciliation may prune that marker before the operator retries, and a daemon restart
  // loses all in-memory state. The sidecar itself must still make the typed-key retry valid.
  manager.stop();
  clearArchiveTables(db);
  const restarted = harness({ root });
  const retried = await restarted.app.request(`/api/archives/${written.key}`, {
    method: "DELETE",
    headers: JSON_HEADERS,
    body: JSON.stringify({ confirmArchiveKey: written.key }),
  });
  assert.equal(retried.status, 200);
  assert.deepEqual(await retried.json(), { ok: true, deletedBundle: false });
  assert.equal(existsSync(sidecar), false);
  assert.deepEqual(
    readdirSync(trash).filter((name) => name.startsWith(`${written.key}.`)),
    [],
    "a successful cleanup-only retry removes the first attempt's trashed bundle",
  );

  writeScoutBundle(root, {
    producerId: written.producerId,
    archiveId: written.archiveId,
    title: "Fresh title after cleanup retry",
  });
  await settle(restarted.manager);
  assert.equal(restarted.manager.detail(written.key)?.title, "Fresh title after cleanup retry");
});

test("a symlink cannot redirect archive display-name writes outside the library", async () => {
  const { app, root, manager } = harness();
  const written = writeScoutBundle(root, {});
  await settle(manager);
  const outside = join(home, `outside-names-${libraries}`);
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(root, ".metadata"), { recursive: true });
  symlinkSync(outside, join(root, ".metadata", "names"));

  const res = await app.request(`/api/archives/${written.key}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ title: "Redirected" }),
  });
  assert.equal(res.status, 500);
  assert.deepEqual(readdirSync(outside), [], "nothing is written through the symlink");
  assert.equal(manager.detail(written.key)?.title, "Resume permission loss");
});

test("opening an artifact hands the launcher a path inside the verified bundle", async () => {
  const { app, root, manager, opened } = harness();
  const written = writeScoutBundle(root, {});
  await settle(manager);

  const res = await app.request(`/api/archives/${written.key}/artifacts/report/open`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ target: "browser" }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(opened, [join(written.dir, "report/report.html")]);

  const badTarget = await app.request(`/api/archives/${written.key}/artifacts/report/open`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ target: "vim" }),
  });
  assert.equal(badTarget.status, 400);
  assert.equal(opened.length, 1, "a target outside the closed registry never reaches a launcher");

  const missing = await app.request(
    `/api/archives/00000000-0000-4000-8000-000000000000~00000000-0000-4000-8000-000000000009/artifacts/report/open`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ target: "browser" }),
    },
  );
  assert.equal(missing.status, 404);
  assert.equal(opened.length, 1);
});

test("deleting requires the archive key to be typed back", async () => {
  const { app, root, manager } = harness();
  const written = writeScoutBundle(root, {});
  const other = writeScoutBundle(root, {});
  await settle(manager);

  const noBody = await app.request(`/api/archives/${written.key}`, { method: "DELETE", headers: LOOPBACK });
  assert.equal(noBody.status, 400);

  const mismatched = await app.request(`/api/archives/${written.key}`, {
    method: "DELETE",
    headers: JSON_HEADERS,
    body: JSON.stringify({ confirmArchiveKey: other.key }),
  });
  assert.equal(mismatched.status, 409);
  assert.equal(existsSync(written.dir), true, "a mismatch must not resolve a path, let alone remove one");
});

test("a confirmed delete removes exactly one bundle and its rows", async () => {
  const { app, root, manager, events } = harness();
  const written = writeScoutBundle(root, { companions: { "a.csv": "1" } });
  const survivor = writeScoutBundle(root, {});
  await settle(manager);
  events.length = 0;

  const res = await app.request(`/api/archives/${written.key}`, {
    method: "DELETE",
    headers: JSON_HEADERS,
    body: JSON.stringify({ confirmArchiveKey: written.key }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, deletedBundle: true });
  assert.equal(existsSync(written.dir), false);
  assert.equal(existsSync(join(root, ".trash", "")), true, "the trash root is kept, its contents are not");
  assert.equal((await app.request(`/api/archives/${written.key}`, { headers: LOOPBACK })).status, 404);

  assert.equal(existsSync(survivor.dir), true, "a sibling archive is untouched");
  assert.equal((await app.request(`/api/archives/${survivor.key}`, { headers: LOOPBACK })).status, 200);
});

test("an archive whose bundle is unreadable is still deletable by its generated path", async () => {
  const { app, root, manager } = harness();
  const written = writeScoutBundle(root, {
    manifestJson: (manifest) => ({ ...manifest, format_version: 99 }),
  });
  await settle(manager);
  assert.equal(
    ((await (await app.request(`/api/archives/${written.key}`, { headers: LOOPBACK })).json()) as { status: string }).status,
    "unreadable",
  );

  const res = await app.request(`/api/archives/${written.key}`, {
    method: "DELETE",
    headers: JSON_HEADERS,
    body: JSON.stringify({ confirmArchiveKey: written.key }),
  });
  assert.equal(res.status, 200);
  assert.equal(existsSync(written.dir), false);
});

test("a failed delete leaves the archive readable and says why", async () => {
  const { app, root, manager } = harness({
    rename: async () => {
      throw new Error("Permission denied");
    },
  });
  const written = writeScoutBundle(root, {});
  await settle(manager);

  const res = await app.request(`/api/archives/${written.key}`, {
    method: "DELETE",
    headers: JSON_HEADERS,
    body: JSON.stringify({ confirmArchiveKey: written.key }),
  });
  assert.equal(res.status, 500);
  assert.match(((await res.json()) as { error: string }).error, /Permission denied/);
  assert.equal(existsSync(written.dir), true);
  assert.equal((await app.request(`/api/archives/${written.key}`, { headers: LOOPBACK })).status, 200, "the archive is still readable");
});

test("a reconciled batch raises exactly one invalidation, and history stays out of the snapshot", async () => {
  const { root, manager, events } = harness();
  writeScoutBundle(root, {});
  writeScoutBundle(root, {});
  writeScoutBundle(root, {});
  events.length = 0;
  await settle(manager);

  const raised = events.filter((event) => event.type === "archive_changed");
  assert.equal(raised.length, 1, "three bundles in one batch is one frame, not three");
  assert.deepEqual(raised[0], { type: "archive_changed" }, "the frame carries no history");

  const registry = new Registry();
  const snapshot = registry.snapshot() as unknown as Record<string, unknown>;
  assert.equal(
    Object.keys(snapshot).some((key) => key.toLowerCase().includes("scout")),
    false,
    "the reconnect snapshot must not grow a scout collection",
  );
});

test("every scout route answers 503 when the daemon has no library, rather than building one", async () => {
  const registry = new Registry();
  const app = buildApp({
    registry,
    reviews: {} as ReviewManager,
    tasks: {} as TaskManager,
    queues: {} as QueueManager,
  });
  for (const [method, path] of [
    ["GET", "/api/archives"],
    ["GET", "/api/archives/a"],
    ["PATCH", "/api/archives/a"],
    ["GET", "/api/archives/a/artifacts/b"],
    ["POST", "/api/archives/a/artifacts/b/open"],
    ["DELETE", "/api/archives/a"],
  ] as const) {
    const res = await app.request(path, {
      method,
      headers: JSON_HEADERS,
      body: method === "GET" ? undefined : JSON.stringify({
        title: "Renamed",
        target: "browser",
        confirmArchiveKey: "a",
      }),
    });
    assert.equal(res.status, 503, `${method} ${path}`);
  }
});

test("the scout routes are behind the loopback guard like every other data endpoint", async () => {
  const { app } = harness();
  const res = await app.request("http://mission-control.example.com/api/archives");
  assert.equal(res.status, 403);
});

test("a symlinked producer namespace can neither be read nor deleted through its key", async () => {
  const { app, root, manager } = harness();
  // A bundle OUTSIDE the library, and a symlinked producer namespace pointing at it. The
  // library is explicitly meant to be filled by hand and by sync tools, so a link landing in
  // it is an ordinary accident - and delete used to join the path without the containment
  // check every read performs, turning one request into a recursive removal of somebody's
  // home directory.
  const outside = join(home, `outside-${libraries}`);
  mkdirSync(outside, { recursive: true });
  const written = writeScoutBundle(outside, {});
  symlinkSync(join(outside, written.producerId), join(root, written.producerId));

  await settle(manager);
  assert.equal((await app.request(`/api/archives/${written.key}`, { headers: LOOPBACK })).status, 404);

  const res = await app.request(`/api/archives/${written.key}`, {
    method: "DELETE",
    headers: JSON_HEADERS,
    body: JSON.stringify({ confirmArchiveKey: written.key }),
  });
  assert.equal(res.status, 403, "a key that resolves outside the library is refused, not obeyed");
  assert.equal(existsSync(written.dir), true, "the directory the link pointed at is untouched");
  assert.equal(
    existsSync(join(written.dir, "report/report.html")),
    true,
    "and so is everything under it",
  );
});

test("an artifact whose file became a symlink after indexing is refused, not served", async () => {
  const { app, root, manager } = harness();
  const secret = join(home, `secret-${libraries}.txt`);
  writeFileSync(secret, "not yours");
  const written = writeScoutBundle(root, { companions: { "notes.txt": "public" } });
  await settle(manager);
  assert.equal((await app.request(`/api/archives/${written.key}/artifacts/artifact-01`, { headers: LOOPBACK })).status, 200);

  rmSync(join(written.dir, "report/notes.txt"));
  symlinkSync(secret, join(written.dir, "report/notes.txt"));
  const res = await app.request(`/api/archives/${written.key}/artifacts/artifact-01`, { headers: LOOPBACK });
  assert.equal(res.status, 404);
  assert.equal((await res.text()).includes("not yours"), false);
});

test("a page cursor is refused rather than read as the first page", async () => {
  const { app, root, manager } = harness();
  writeScoutBundle(root, {});
  await settle(manager);
  // The route schema refuses a malformed cursor, and so does the manager beneath it - two
  // layers, because silently paging the wrong window is the failure that looks like success.
  assert.equal((await app.request("/api/archives?cursor=1760000000000.nope", { headers: LOOPBACK })).status, 400);
  assert.throws(
    () => manager.list({ q: null, producer: null, repo: null, agent: null, kind: null, status: null, from: null, to: null, cursor: "garbage", limit: 30 }),
    /cursor/,
  );
});

test("a repository label cannot forge a filter match through the delimiter", async () => {
  const { app, root, manager } = harness();
  writeScoutBundle(root, {
    repositories: [{ slot: "repo-01", label: "innocent|mission-control", head: null }],
  });
  await settle(manager);
  const forged = await app.request("/api/archives?repo=mission-control", { headers: LOOPBACK });
  assert.deepEqual(((await forged.json()) as { archives: unknown[] }).archives, []);
});

// ---------------------------------------------------------------------------
// The MCP submission route
// ---------------------------------------------------------------------------

/**
 * The one write endpoint in this surface, and the one that an AGENT calls rather than a
 * browser - so its refusals are what a scout reads when it gets something wrong.
 *
 * The schema is the security argument here: a body that names a task, a destination, or an
 * archive is not a body this route can express. What is checked below is that those fields
 * are rejected as shape errors rather than quietly ignored, and that the token guard sits in
 * front of all of it exactly as it does for the ensemble twin.
 */

const SUBMIT = "/mcp/scouts/submit";

function submitBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    reportPath: "docs/reports/resume/report.html",
    summary: "Resume rebuilt the session without replaying the grant.",
    ...over,
  });
}

function submissionHeaders(taskId = "trusted-task", cwd = "/tmp/checkout"): Record<string, string> {
  const token = provisionScoutSubmissionCredential(taskId, cwd);
  return {
    ...JSON_HEADERS,
    "x-harness-token": ensureToken(),
    [SCOUT_SUBMISSION_CREDENTIAL_HEADER]: token,
  };
}

test("the submission route is behind the harness token, like every other MCP endpoint", async () => {
  const { app } = harness();
  const res = await app.request(SUBMIT, {
    method: "POST",
    headers: JSON_HEADERS,
    body: submitBody(),
  });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "unauthorized" });
});

test("the shared harness token cannot select another scout session", async () => {
  let attributed = false;
  const { app } = harness({
    tasks: {
      subjectForSubmission: () => {
        attributed = true;
        return {
          ok: false as const,
          reason: "no_session" as const,
          status: 404 as const,
          detail: "should not be reached",
        };
      },
      subjectForTask: () => null,
      subjectForExitingSession: () => null,
      scoutPromptTrailFor: () => null,
      captureKind: () => null,
      awaitsAgent: () => false,
    },
  });
  const res = await app.request(SUBMIT, {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-harness-token": ensureToken() },
    body: submitBody({
      env: { tmuxPane: "%victim" },
      sessionId: "victim-session",
      cwd: "/tmp/victim-checkout",
    }),
  });
  assert.equal(res.status, 403);
  assert.equal(attributed, false, "caller-selected identity never reaches the task gateway");
});

test("a report path that is not the convention is refused with the required shape", async () => {
  const { app } = harness();
  const res = await app.request(SUBMIT, {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-harness-token": ensureToken() },
    body: submitBody({ reportPath: "docs/answer.html" }),
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /docs\/reports\/<slug>\/report\.html/);
});

test("a submission may not name a repository slot that is not generated", async () => {
  const { app } = harness();
  const res = await app.request(SUBMIT, {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-harness-token": ensureToken() },
    body: submitBody({ supporting: [{ repoSlot: "../../etc", path: "passwd" }] }),
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /repository slot/);
});

test("a submission cannot name its own task, destination, or archive", async () => {
  let authority: { taskId: string; cwd: string } | null = null;
  const { app } = harness({
    tasks: {
      subjectForSubmission: (input) => {
        authority = input;
        return {
          ok: false as const,
          reason: "no_task" as const,
          status: 404 as const,
          detail: "the credential's task no longer exists",
        };
      },
      subjectForTask: () => null,
      subjectForExitingSession: () => null,
      scoutPromptTrailFor: () => null,
      captureKind: () => null,
      awaitsAgent: () => false,
    },
  });
  // Zod ignores unknown keys rather than refusing them, which is what keeps the wire
  // forward-compatible - so the assertion is that they reach NOTHING. The route resolves
  // attribution from the signed credential, finds no live subject, and answers 404: the extra
  // fields did not select a task, a producer, or a directory.
  const res = await app.request(SUBMIT, {
    method: "POST",
    headers: {
      ...submissionHeaders(),
      "x-harness-token": ensureToken(),
    },
    body: submitBody({
      taskId: "some-other-task",
      sessionId: "some-other-session",
      cwd: "/some/other/checkout",
      archiveId: "11111111-2222-4333-8444-555555555555",
      producerId: "11111111-2222-4333-8444-555555555555",
      destination: "/etc",
    }),
  });
  assert.equal(res.status, 404);
  assert.match(await res.text(), /credential's task no longer exists/);
  assert.deepEqual(authority, { taskId: "trusted-task", cwd: "/tmp/checkout" });
});

test("the submission route answers 503 when this build has no scout library", async () => {
  const registry = new Registry();
  const app = buildApp({
    registry,
    reviews: {} as ReviewManager,
    tasks: {} as TaskManager,
    queues: {} as QueueManager,
  });
  const res = await app.request(SUBMIT, {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-harness-token": ensureToken() },
    body: submitBody(),
  });
  assert.equal(res.status, 503);
});
