// Recursive deletes of operator trees under Electron's Node, where `fs` reads `.asar` files as
// virtual archives. A checkout with dependencies installed holds Electron's own
// `default_app.asar`; on 2026-11-26 `fs.rm` could not delete it, so Destroy on an orphaned pool
// slot failed, the slot stayed quarantined, and the pool read as exhausted. Plain Node has no
// asar layer and cannot reproduce this, so every case here runs inside Electron.
//
// Fixtures only: each tree is built in a disposable directory, with a copy of the real archive
// that ships in this checkout's `node_modules/electron`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const require = createRequire(import.meta.url);
const checkout = fileURLToPath(new URL("../", import.meta.url));
const ASAR_PATH = "node_modules/electron/dist/Electron.app/Contents/Resources/default_app.asar";

/** The real archive Electron ships, which `fs.rm` cannot delete from inside Electron. */
function shippedAsar(): string {
  const binary = require("electron") as unknown as string;
  const path = join(dirname(binary), "..", "Resources", "default_app.asar");
  assert.ok(existsSync(path), `Electron's default_app.asar is missing at ${path}; run npm test's pretest`);
  return path;
}

/** Copy the archive in from plain Node, which has no asar layer to get in the way. */
function plantAsar(tree: string, asar: string): string {
  const target = join(tree, ASAR_PATH);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(asar, target);
  writeFileSync(join(tree, "package.json"), "{}\n");
  return target;
}

async function exited(child: ReturnType<typeof spawn>): Promise<{ code: number | null; stderr: string }> {
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  return { code, stderr };
}

interface Case { tree: string; planted: string; outcome: unknown }
interface WorkerResult {
  electron: string;
  control: Case;
  helper: Case;
  /** These two trees live in the worker's own state home, so the worker reports what it saw. */
  orphan: { planted: boolean; outcome: unknown; present: boolean; besideSlot: string[] };
  destroy: { planted: boolean; released: string; outcome: unknown; row: unknown; present: boolean };
}

test("under Electron's Node the shared tree removal deletes Electron's asar, and Destroy and orphan reclaim both use it", {
  skip: process.platform !== "darwin", timeout: 120_000,
}, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mission-remove-tree-electron-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resultPath = join(root, "result.json");
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  const worker = spawn(require("electron") as unknown as string, [
    "--import", join(checkout, "test/setup-state.mjs"), "--import", "tsx",
    join(checkout, "test/helpers/tree-removal-electron-worker.ts"), root, shippedAsar(), resultPath,
  ], { cwd: checkout, env, stdio: ["ignore", "inherit", "pipe"] });
  t.after(() => worker.kill("SIGKILL"));
  const { code, stderr } = await exited(worker);
  assert.equal(code, 0, stderr);
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as WorkerResult;
  t.diagnostic(`Electron ${result.electron}`);

  // The control proves this process really had the asar layer: Node's own delete left the
  // archive behind, so a pass below is not an artifact of plain-Node semantics.
  t.diagnostic(`fs.rm under Electron: ${String(result.control.outcome)}`);
  assert.notEqual(result.control.outcome, "resolved");
  assert.ok(existsSync(result.control.planted), "fs.rm under Electron must leave default_app.asar, or this spec proves nothing");

  assert.equal(result.helper.outcome, "removed", String(result.helper.outcome));
  assert.equal(existsSync(result.helper.tree), false);

  const orphan = result.orphan;
  assert.equal(orphan.planted, true);
  assert.equal(orphan.outcome, "removed", "orphan reclaim's default remover goes through removeTree");
  assert.equal(orphan.present, false);
  assert.deepEqual(orphan.besideSlot, [], "nothing is left set aside beside the slot either");

  const destroy = result.destroy;
  assert.equal(destroy.planted, true);
  assert.equal(destroy.released, "released", "the owner lets go and the files stay, as on a real install");
  assert.deepEqual(destroy.outcome, { outcome: "removed" }, "pool Destroy goes through removeTree");
  assert.equal(destroy.row, null, "the slot row is gone, so the pool regains its capacity");
  assert.equal(destroy.present, false);
});

test("in Electron's utility process, where the daemon runs, removeTree deletes the asar tree fs.rm cannot", {
  skip: process.platform !== "darwin", timeout: 60_000,
}, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mission-remove-tree-utility-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const asar = shippedAsar();
  const control = join(root, "control");
  const helper = join(root, "helper");
  const controlAsar = plantAsar(control, asar);
  plantAsar(helper, asar);
  const output = join(root, "result.json");
  buildSync({
    stdin: {
      contents: `
        import { rm } from "node:fs/promises";
        import { writeFileSync } from "node:fs";
        import { removeTree } from "./src/server/util/remove-tree.ts";
        const control = await Promise.race([
          rm(${JSON.stringify(control)}, { recursive: true, maxRetries: 2 }).then(() => "resolved", (e) => "rejected: " + e.message),
          new Promise((resolve) => setTimeout(() => resolve("hung"), 5000).unref()),
        ]);
        let helper = "removed";
        try { await removeTree(${JSON.stringify(helper)}, { allowMissing: false }); } catch (e) { helper = "rejected: " + e.message; }
        writeFileSync(${JSON.stringify(output)}, JSON.stringify({ control, helper, utility: typeof process.parentPort }));
        process.exit(0);
      `,
      resolveDir: checkout,
    },
    bundle: true, platform: "node", format: "esm", alias: { "@shared": "./src/shared" },
    outfile: join(root, "worker.mjs"),
  });
  buildSync({
    stdin: {
      contents: `
        import { app, utilityProcess } from "electron";
        app.whenReady().then(() => {
          const worker = utilityProcess.fork(${JSON.stringify(join(root, "worker.mjs"))});
          worker.on("exit", (code) => app.exit(code ?? 1));
        });
      `,
      resolveDir: checkout,
    },
    bundle: true, platform: "node", format: "esm", external: ["electron"], outfile: join(root, "main.mjs"),
  });
  writeFileSync(join(root, "package.json"), JSON.stringify({ main: "main.mjs", type: "module" }));
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(require("electron") as unknown as string, [root], { env, stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => app.kill("SIGKILL"));
  const { code, stderr } = await exited(app);
  assert.equal(code, 0, stderr);
  const result = JSON.parse(readFileSync(output, "utf8")) as { control: string; helper: string; utility: string };
  t.diagnostic(`fs.rm in the utility process: ${result.control}`);
  assert.equal(result.utility, "object", "the worker ran as an Electron utility process");
  assert.notEqual(result.control, "resolved");
  assert.ok(existsSync(controlAsar), "fs.rm in the utility process must leave default_app.asar, or this case proves nothing");
  assert.equal(result.helper, "removed", result.helper);
  assert.equal(existsSync(helper), false);
});
