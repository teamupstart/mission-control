import { realpathSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ShapingIntentSchema, ShapingTestRequestSchema } from "@shared/protocol.ts";
import { DEFAULT_TASK_KIND } from "@shared/types.ts";
import { registeredShaperRevision, SHAPING_LIMITS } from "@shared/shaping.ts";
import { JSON_UTF8_MAX_BYTES_PER_CHAR } from "@shared/workflow.ts";
import { requireFeature } from "../feature-flags/index.ts";
import { parseBody } from "../http-body.ts";
import { trustedLoopbackJsonRequest } from "../loopback.ts";
import { insideWorkTree, resolveRepoRoot } from "../repos.ts";
import { discoverShapers } from "./discovery.ts";
import { dryRunShaper } from "./engine.ts";
import { applyShapingIntent, getShapingConfig } from "./index.ts";
import { daemonShapingView, issuedByThisDaemon, shapingReviser, UNISSUED_REVISION_REFUSAL } from "./revisions.ts";
import {
  dropShapingWriteRecords,
  EARLIER_INSTANCE_REFUSAL,
  expiredWriteRefusal,
  noteShapingWriteApplied,
  readShapingWriteOrder,
  SEQUENCE_TOO_FAR_AHEAD_REFUSAL,
  SHAPING_WRITE_ORDER_HEADER,
  shapingWriteExpired,
  shapingWriteFromEarlierInstance,
  shapingWriteSuperseded,
  shapingWriteTooFarAhead,
  SUPERSEDED_WRITE_REFUSAL,
  UNREADABLE_ORDER_REFUSAL,
} from "./write-order.ts";
import { referenceStatus } from "./references.ts";

/**
 * Task shaping's API, all behind the `task-shaping` flag: with it off every route answers 404
 * before its handler runs, so nothing reads the stored config.
 *
 * - `GET /api/shaping` returns `{ config, discovered, references }`.
 * - `PUT /api/shaping` applies one intent and returns `{ config }`.
 * - `POST /api/shaping/test` dry-runs one shaper against a repository and returns what dispatch
 *   would have recorded and injected. A failing shaper is an outcome in a 200, never an error.
 */
/**
 * Ceilings, not allocations: `bodyLimit` refuses past them while streaming, after the flag's
 * gate, so a disabled route still answers 404 before any body is read. One intent is at most one
 * definition, `SHAPING_LIMITS.entryJsonBytes`, and a dry run at most a prompt and a path. Each
 * is multiplied by `JSON_UTF8_MAX_BYTES_PER_CHAR`, because the schemas count characters while
 * the limit counts bytes, with room for the rest of the request.
 */
const SHAPING_PUT_BODY_MAX_BYTES = SHAPING_LIMITS.entryJsonBytes * JSON_UTF8_MAX_BYTES_PER_CHAR + 16 * 1024;
const SHAPING_TEST_BODY_MAX_BYTES = (SHAPING_LIMITS.taskChars + 4096) * JSON_UTF8_MAX_BYTES_PER_CHAR + 16 * 1024;

function limitBody(maxSize: number) {
  return bodyLimit({ maxSize, onError: (c) => c.json({ error: "request_too_large", reason: "The request body is too large." }, 413) });
}

/** The Git probes a dry run's repository check makes, so a test can stand in for either. */
export interface CheckoutProbes {
  resolveRepoRoot: typeof resolveRepoRoot;
  insideWorkTree: typeof insideWorkTree;
}

/**
 * Whether `repository` is a working tree a dry run may use, and the repository it belongs to.
 * Git rejecting the path is a 400. Git never answering is a 503, whether during root resolution
 * or the working-tree check, so a valid checkout is never refused as an invalid one. A bare
 * repository resolves but has no working tree for a gatherer to run in.
 */
export async function checkoutFor(
  repository: string,
  probes: CheckoutProbes = { resolveRepoRoot, insideWorkTree },
): Promise<{ ok: true; repoRoot: string } | { ok: false; status: 400 | 503; error: string; reason: string }> {
  const unanswered = (what: string) => ({
    ok: false as const, status: 503 as const, error: "repository_check_failed", reason: `Git did not answer whether ${what}. Try again.`,
  });
  const repoRoot = await probes.resolveRepoRoot(repository);
  // `resolveRepoRoot` answers null both when Git rejects the path and when Git never answered.
  // A second probe tells them apart.
  if (!repoRoot) {
    // Only Git saying no is a 400. A path Git confirms is a working tree, whose root could still
    // not be resolved, is as unanswered as one it never answered for.
    const probe = await probes.insideWorkTree(repository);
    if (probe === "not-worktree") return { ok: false, status: 400, error: "unknown_repository", reason: "The path is not inside a Git checkout." };
    return unanswered("the path is a Git checkout");
  }
  const tree = await probes.insideWorkTree(repository);
  if (tree === "unknown") return unanswered("the path is a working tree");
  if (tree === "not-worktree") {
    return { ok: false, status: 400, error: "unknown_repository", reason: "The path is a bare repository, with no working tree to run a shaper in." };
  }
  return { ok: true, repoRoot };
}

export function registerShapingRoutes(app: Hono, options: { checkoutProbes?: CheckoutProbes } = {}): void {
  const gate = requireFeature("task-shaping");
  // Both writes are refused unless they come from the dashboard, as a dry run executes a shaper.
  // Before the body limit, so a forged request is refused as forbidden whatever its size.
  const loopbackWrite: MiddlewareHandler = async (c, next) => {
    if (!trustedLoopbackJsonRequest(c)) return c.json({ error: "forbidden" }, 403);
    await next();
  };

  app.get("/api/shaping", gate, async (c) => {
    const config = getShapingConfig();
    // The view, never raw envelopes: an unsupported entry leaves as its id, label and reason.
    return c.json({ config: daemonShapingView(config), discovered: await discoverShapers(), references: referenceStatus(config) });
  });

  app.put("/api/shaping", gate, loopbackWrite, limitBody(SHAPING_PUT_BODY_MAX_BYTES), async (c) => {
    const parsed = await parseBody(c, ShapingIntentSchema);
    if (!parsed.ok) return parsed.res;
    const intent = parsed.data;
    if ("expect" in intent && intent.expect !== undefined) {
      const config = getShapingConfig();
      if (registeredShaperRevision(config, intent.id, shapingReviser) !== intent.expect
        && !issuedByThisDaemon(intent.expect)) return c.json(UNISSUED_REVISION_REFUSAL, 409);
    }
    const header = c.req.header(SHAPING_WRITE_ORDER_HEADER);
    const order = readShapingWriteOrder(header);
    // Sent but unreadable is refused, never taken for a write with no order: that one would skip
    // every ordering check, and could overwrite a newer edit if it arrives late.
    if (header !== undefined && order === null) return c.json(UNREADABLE_ORDER_REFUSAL, 400);
    if (order && shapingWriteTooFarAhead(order)) return c.json(SEQUENCE_TOO_FAR_AHEAD_REFUSAL, 400);
    try {
      const discovered = await discoverShapers();
      // Checked here, as the write is about to apply and after every wait: a write that waited for
      // discovery while its window gave up on it and sent a newer one never overwrites that one.
      if (order) dropShapingWriteRecords();
      if (order && shapingWriteFromEarlierInstance(order)) return c.json(EARLIER_INSTANCE_REFUSAL, 409);
      if (order && shapingWriteExpired(order)) return c.json(expiredWriteRefusal(), 409);
      if (order && shapingWriteSuperseded(order)) return c.json(SUPERSEDED_WRITE_REFUSAL, 409);
      const result = applyShapingIntent(parsed.data, discovered);
      if (result.ok && order) noteShapingWriteApplied(order);
      if (!result.ok) {
        // 409 when the request is sound but the stored config has moved on under it.
        const conflict = result.error === "unreadable_config" || result.error === "shaper_changed";
        return c.json({ error: result.error, reason: result.reason }, conflict ? 409 : 400);
      }
      return c.json({ config: daemonShapingView(result.config) });
    } catch (error) {
      return c.json({ error: "save_failed", message: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post("/api/shaping/test", gate, loopbackWrite, limitBody(SHAPING_TEST_BODY_MAX_BYTES), async (c) => {
    const parsed = await parseBody(c, ShapingTestRequestSchema);
    if (!parsed.ok) return parsed.res;
    const { id, repository, prompt, kind, expect } = parsed.data;
    // One snapshot of the config, taken now, is both what the revision is checked against and what
    // the engine runs. The checkout probes below await Git, and a replacement written during them
    // must not be what runs, so the engine never reads the store again for this request.
    const config = getShapingConfig();
    // Bound to the definition the sender showed: a replacement written meanwhile is never run
    // under the name of the shaper the operator chose.
    if (expect !== undefined && registeredShaperRevision(config, id, shapingReviser) !== expect) {
      if (!issuedByThisDaemon(expect)) return c.json(UNISSUED_REVISION_REFUSAL, 409);
      return c.json({
        error: "shaper_changed",
        reason: `"${id}" changed in another window since it was shown here, so it was not run. Review it again first.`,
      }, 409);
    }
    // Resolved once, before any probe: the path Git checks is the path the gatherer runs in, so a
    // symlink that changes after the probes cannot send the gatherer somewhere unchecked.
    let checkout: string;
    try { checkout = realpathSync(repository); } catch {
      return c.json({ error: "unknown_repository", reason: "The repository is not a directory on this machine." }, 400);
    }
    let directory = false;
    try { directory = statSync(checkout).isDirectory(); } catch { directory = false; }
    if (!directory) return c.json({ error: "unknown_repository", reason: "The repository is not a directory on this machine." }, 400);
    // A Git checkout, through the same resolver dispatch uses, so a mistyped path that names an
    // ordinary folder is refused instead of running a gatherer there and reporting success. The
    // gatherer still runs where it was pointed: the resolver walks a linked worktree back to its
    // owner, which names the repository but is not the tree under test.
    const checked = await checkoutFor(checkout, options.checkoutProbes);
    if (!checked.ok) return c.json({ error: checked.error, reason: checked.reason }, checked.status);
    const repoRoot = checked.repoRoot;
    const result = await dryRunShaper(id, {
      task: prompt ?? "",
      context: {
        taskId: null, title: "", kind: kind ?? DEFAULT_TASK_KIND, harness: null, runtime: null,
        afterWork: null, labels: [], priority: null,
        repositories: [{ name: basename(repoRoot), role: "primary", branch: null, baseSha: null, path: checkout }],
      },
      // Aborted when the client's connection closes before the reply, so a dry run nobody is
      // waiting for stops its shapers' process groups instead of running to their timeout.
      signal: c.req.raw.signal,
    }, { config });
    if (!result.ok) return c.json({ error: result.error, reason: result.reason }, result.error === "unknown_shaper" ? 404 : 400);
    return c.json(result.run);
  });
}
