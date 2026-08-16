import type { PipelineProviderId } from "@shared/pipeline.ts";

import { CONDUCTOR_PROVIDER } from "./conductor/index.ts";
import type { PipelineProvider } from "./types.ts";

/**
 * Every provider, keyed by id.
 *
 * `Record<PipelineProviderId, PipelineProvider>` is the enforcement: an id appended to the
 * shared tuple does not compile until something can probe and read it. A lookup that could
 * return undefined would be a provider the Settings panel offers, the config accepts, and
 * the watch loop skips in silence.
 *
 * It lives in its own module rather than in `./index.ts` because both halves of observation
 * need it and one of them is imported BY that file: the watch loop reads repositories
 * through it, and `./ingest.ts` asks it whether a pushed slug names a real run. Holding it
 * where the loop lives would make that a cycle, and the answer to a cycle is not to let one
 * of the two ask a question it should not be answering for itself.
 */
export const PIPELINE_PROVIDERS: Record<PipelineProviderId, PipelineProvider> = {
  "ai-conductor": CONDUCTOR_PROVIDER,
};
