import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stateDir } from "@shared/harness-runtime.mjs";
import { piExtensionPath } from "../config.ts";
import { inspectPiCandidate } from "./pi-candidate.ts";
import { canReconcileExtensionLink, reconcileExtensionLink, type ReconcileResult } from "../skills/reconcile.ts";
import type { ExtensionIntentCommit } from "./pi-link-publication.ts";
import { assertTestStateIsolation } from "../state/isolation.ts";
import { PI_INTEGRATION_FILES, verifyPiIntegration } from "./pi-artifact.ts";
import { piGenerationPath, piIntegrationRoot } from "./pi-paths.ts";
import { prunePiGenerations } from "./pi-retention.ts";

/** Artifact bytes are immutable. Retention protects current/prior publications and
 * generations leased by Pi processes that may start another bridge after an update. */
export async function publishPiIntegration(onPublished?: ExtensionIntentCommit): Promise<ReconcileResult> {
  const failed = (detail: string): ReconcileResult => ({ changed: false, linked: [], unlinked: [], blocked: ["mission-control.js"], problems: [detail] });
  const root = piIntegrationRoot();
  assertTestStateIsolation(join(stateDir(), "pi-extension.json"));
  if (!canReconcileExtensionLink()) return failed("The Pi extension entry isn't ours to replace; left unchanged.");
  let stage: string | undefined;
  try {
    const source = dirname(resolve(piExtensionPath()));
    const manifest = verifyPiIntegration(source);
    for (const dir of [dirname(root), root]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!lstatSync(dir).isDirectory()) throw new Error("Pi integration storage must be an app-owned directory, not a link");
    }
    stage = mkdtempSync(join(root, ".staging-"));
    for (const name of PI_INTEGRATION_FILES) copyFileSync(join(source, name), join(stage, name));
    if (verifyPiIntegration(stage).buildId !== manifest.buildId) throw new Error("Pi integration changed while copying");
    const candidate = await inspectPiCandidate(join(stage, "extension.js"), join(source, "extension.js"), { candidate: true });
    if (!candidate.healthy) throw new Error(candidate.warning ?? "The copied Pi integration could not be verified");
    // Child probes can take time. Revalidate the bytes and ownership before publishing.
    if (verifyPiIntegration(stage).buildId !== manifest.buildId) throw new Error("Pi integration changed during verification");
    if (!canReconcileExtensionLink()) throw new Error("The Pi extension entry changed during verification; left unchanged");
    const generation = piGenerationPath(manifest.buildId);
    const existing = lstatSync(generation, { throwIfNoEntry: false });
    if (existing) {
      if (!existing.isDirectory()) throw new Error("Pi integration generation is not an owned directory");
      let valid = false;
      try { valid = verifyPiIntegration(generation).buildId === manifest.buildId; } catch { /* Repair damaged owned generation, retaining its files. */ }
      if (!valid) {
        const retained = mkdtempSync(join(root, ".damaged-"));
        const backup = join(retained, manifest.buildId);
        try {
          renameSync(generation, backup);
          try { renameSync(stage, generation); stage = undefined; }
          catch (error) { renameSync(backup, generation); throw error; }
        } finally {
          // A failed move or successful restoration leaves an empty container. Never
          // recursively remove it: failed restoration must retain the recovery bytes.
          try { rmdirSync(retained); } catch { /* Nonempty or inaccessible backup stays intact. */ }
        }
      }
    } else { renameSync(stage, generation); stage = undefined; }
    const result = reconcileExtensionLink(true, join(generation, "extension.js"), onPublished);
    if (result.blocked.length === 0) {
      // Cleanup is best effort and cannot turn an already-committed installation into
      // a failed publication. A later successful reconcile retries it.
      try { prunePiGenerations(manifest.buildId); }
      catch { console.warn("[pi-extension] Generation cleanup deferred until the next publication"); }
    }
    return result;
  } catch (error) {
    return failed(`Pi integration was not published. ${error instanceof Error ? error.message : "Verification or publication failed."}`);
  } finally { if (stage) rmSync(stage, { recursive: true, force: true }); }
}
