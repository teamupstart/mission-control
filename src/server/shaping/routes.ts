import { statSync } from "node:fs";
import { basename } from "node:path";
import type { Hono } from "hono";
import { ShapingIntentSchema, ShapingTestRequestSchema } from "@shared/protocol.ts";
import { DEFAULT_TASK_KIND } from "@shared/types.ts";
import { requireFeature } from "../feature-flags/index.ts";
import { parseBody } from "../http-body.ts";
import { discoverShapers } from "./discovery.ts";
import { dryRunShaper } from "./engine.ts";
import { applyShapingIntent, getShapingConfig } from "./index.ts";
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
export function registerShapingRoutes(app: Hono): void {
  const gate = requireFeature("task-shaping");

  app.get("/api/shaping", gate, async (c) => {
    const config = getShapingConfig();
    return c.json({ config, discovered: await discoverShapers(), references: referenceStatus(config) });
  });

  app.put("/api/shaping", gate, async (c) => {
    const parsed = await parseBody(c, ShapingIntentSchema);
    if (!parsed.ok) return parsed.res;
    try {
      const result = applyShapingIntent(parsed.data, await discoverShapers());
      if (!result.ok) return c.json({ error: result.error, reason: result.reason }, result.error === "unreadable_config" ? 409 : 400);
      return c.json({ config: result.config });
    } catch (error) {
      return c.json({ error: "save_failed", message: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post("/api/shaping/test", gate, async (c) => {
    const parsed = await parseBody(c, ShapingTestRequestSchema);
    if (!parsed.ok) return parsed.res;
    const { id, repository, prompt, kind } = parsed.data;
    let directory = false;
    try { directory = statSync(repository).isDirectory(); } catch { directory = false; }
    if (!directory) return c.json({ error: "unknown_repository", reason: "The repository is not a directory on this machine." }, 400);
    const result = await dryRunShaper(id, {
      task: prompt ?? "",
      context: {
        taskId: null, title: "", kind: kind ?? DEFAULT_TASK_KIND, harness: null, runtime: null,
        afterWork: null, labels: [], priority: null,
        repositories: [{ name: basename(repository), role: "primary", branch: null, baseSha: null, path: repository }],
      },
    });
    if (!result.ok) return c.json({ error: result.error, reason: result.reason }, result.error === "unknown_shaper" ? 404 : 400);
    return c.json(result.run);
  });
}
