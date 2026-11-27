// Runs under Electron's Node (`ELECTRON_RUN_AS_NODE=1`), where `fs` treats `.asar` files as
// virtual archives, exactly as in the daemon's utility process. Launched by
// `test/remove-tree-electron.test.ts` with the test preload, so the server graph resolves this
// process's own disposable state home. Fixtures only: every tree is created here or by the spec.
//
// argv: <root> <asar> <result.json>. `asar` is a real `default_app.asar` copied by the spec.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const [rootArg, asarArg, resultArg] = process.argv.slice(2);
if (!rootArg || !asarArg || !resultArg) throw new Error("usage: <root> <asar> <result.json>");
const root: string = rootArg, asar: string = asarArg, resultPath: string = resultArg;
if (!process.versions.electron) throw new Error("this worker must run under Electron's Node");

/** Where a checkout with dependencies installed holds Electron's archive. */
const ASAR_PATH = "node_modules/electron/dist/Electron.app/Contents/Resources/default_app.asar";

/**
 * Place the archive inside `tree`. The copy itself goes around the asar layer, synchronously,
 * so nothing else in this process can observe the flag: this is fixture setup, not the code
 * under test.
 */
function plantAsar(tree: string): string {
  const target = join(tree, ASAR_PATH);
  mkdirSync(dirname(target), { recursive: true });
  process.noAsar = true;
  try {
    copyFileSync(asar, target);
  } finally {
    process.noAsar = false;
  }
  return target;
}

/**
 * Whether anything is at `path`, read around the asar layer. The orphan and pool cases live in
 * this process's own state home, which is gone by the time the spec could look.
 */
function present(path: string): boolean {
  process.noAsar = true;
  try {
    return existsSync(path);
  } finally {
    process.noAsar = false;
  }
}

const result: Record<string, unknown> = { electron: process.versions.electron };
/** A removal that regressed to `fs.rm` hangs: report that by name instead of hanging too. */
function within<T>(work: Promise<T>, ms = 20_000): Promise<T | "hung"> {
  return Promise.race([work, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), ms).unref())]);
}
const errorText = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

// 1. The control: Node's own recursive delete, bounded here so the worker can go on.
{
  const tree = join(root, "control");
  const planted = plantAsar(tree);
  writeFileSync(join(tree, "package.json"), "{}\n");
  const outcome = await Promise.race([
    rm(tree, { recursive: true, maxRetries: 2 }).then(() => "resolved", (error: unknown) => `rejected: ${errorText(error)}`),
    new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 5_000).unref()),
  ]);
  result.control = { tree, planted, outcome };
}

const { removeTree } = await import("../../src/server/util/remove-tree.ts");

// 2. The helper on the same shape of tree.
{
  const tree = join(root, "helper");
  const planted = plantAsar(tree);
  writeFileSync(join(tree, "package.json"), "{}\n");
  const started = Date.now();
  try {
    await removeTree(tree, { allowMissing: false });
    result.helper = { tree, planted, outcome: "removed", ms: Date.now() - started };
  } catch (error) {
    result.helper = { tree, planted, outcome: `rejected: ${errorText(error)}` };
  }
}

const { gitIn, mkLinkedWorktree, mkOriginAndClone } = await import("./git-fixture.ts");
const { worktreeSlotPath } = await import("../../src/server/dispatcher.ts");

// 3. Orphan reclaim, through `removeOrphanedTaskCheckout`'s DEFAULT remover.
{
  const { orphanedCheckoutFingerprint, removeOrphanedTaskCheckout } =
    await import("../../src/server/worktrees/orphaned-task-checkout.ts");
  const { clone } = mkOriginAndClone("mission-asar-orphan-");
  const id = "asar-orphan-task";
  mkdirSync(dirname(worktreeSlotPath(id, 0)), { recursive: true });
  const branch = `harness/${id}`;
  // The real path: the orphan proof never follows a link, and the temp dir sits behind one.
  const slot = mkLinkedWorktree(clone, branch, worktreeSlotPath(id, 0));
  writeFileSync(join(slot, ".gitignore"), "node_modules\n");
  gitIn(slot, "add", ".gitignore");
  gitIn(slot, "commit", "-qm", "ignore rules");
  const baseSha = gitIn(slot, "rev-parse", "HEAD");
  const planted = present(plantAsar(slot));
  // The re-clone that orphans a checkout: its administrative directory is gone.
  await removeTree(gitIn(slot, "rev-parse", "--absolute-git-dir"));
  const ref = { repoRoot: clone, worktreePath: slot, branch, provider: "git" as const,
    worktreeLeaseId: null, baseSha, role: "primary" as const, position: 0 };
  try {
    const claimed = await orphanedCheckoutFingerprint(ref, slot);
    if (claimed?.kind !== "known") throw new Error(`fingerprint: ${JSON.stringify(claimed)}`);
    const outcome = await within(removeOrphanedTaskCheckout(ref, slot, claimed.digest, async () => null,
      (_aside, _commonDir, finish) => finish()));
    result.orphan = { planted, outcome, present: present(slot), besideSlot: readdirSync(dirname(slot)) };
  } catch (error) {
    result.orphan = { planted, outcome: `rejected: ${errorText(error)}`, present: present(slot) };
  }
}

// 4. The Worktrees panel's Destroy on an orphaned pool slot, through the manager.
{
  const { openDb } = await import("../../src/server/db.ts");
  const { WorktreeManager } = await import("../../src/server/worktrees/manager.ts");
  const db = openDb();
  const manager = new WorktreeManager(db, {
    ownerReferenced: async () => false,
    pause: async () => {},
    resolvePolicy: () => ({ enabled: true, maxSlots: 2, setupArgv: null }),
    occupancy: async (paths) => new Map(paths.map((path) => [path, { status: "known" as const, occupants: [] }])),
  });
  const { clone } = mkOriginAndClone("mission-asar-slot-");
  const sha = gitIn(clone, "rev-parse", "HEAD");
  const acquired = await manager.acquire({ repositoryPath: clone, baseSha: sha, owner: { kind: "task", key: "asar-task:0" } });
  if (acquired.outcome !== "acquired") throw new Error(`acquire: ${JSON.stringify(acquired)}`);
  const lease = acquired.lease;
  const leased = manager.store.slot(lease.slotId)!;
  manager.store.quarantine(lease.slotId, "observation", "fixture: registrations unknown", null, 1_000, leased.version);
  const planted = present(plantAsar(leased.path));
  const admin = readFileSync(join(leased.path, ".git"), "utf8").trim().replace(/^gitdir: /, "");
  await removeTree(admin);
  const lookup = manager.lookupLease({ leaseId: lease.leaseId, path: lease.path, owner: lease.owner });
  if (lookup.state === "missing" || lookup.state === "mismatch") throw new Error(`lookup: ${lookup.state}`);
  const released = await manager.release((lookup as { lease: typeof lease }).lease, { ownerAuthorized: true });
  const removed = await within(manager.removeSlot({ slotId: lease.slotId, allowDirty: true, allowUnmerged: true, allowUnverifiable: true }));
  const row = manager.store.slot(lease.slotId);
  result.destroy = {
    planted, released: released.outcome, outcome: removed,
    row: row ? { state: row.state, quarantineCategory: row.quarantineCategory, quarantineReason: row.quarantineReason } : null,
    present: present(leased.path),
  };
}

writeFileSync(resultPath, JSON.stringify(result, null, 2));
// The control's `rm` may still be pending inside the asar layer. Leave without waiting for it.
process.exit(0);
