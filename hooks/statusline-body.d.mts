// Types for the plain-JS statusLine normalizer, mirroring `harness-runtime.d.mts`.
//
// The module itself has to stay .mjs - bare `node` runs its caller at status-line render
// time with no build step - so the TypeScript side (the test, and anything that reads the
// wire shape) gets its types from here.

import type { StatusLineIngest } from "../src/shared/protocol.ts";

/**
 * Normalize a raw Claude statusLine payload into the daemon's flat wire shape.
 *
 * Typed as the ingest schema's INPUT rather than its output: every field is optional on
 * the wire, and `toBody` legitimately returns `undefined` for anything the payload didn't
 * carry - which is the whole point of the absent-vs-zero distinction it exists to keep.
 */
export function toBody(payload: Record<string, unknown>, now?: number): StatusLineIngest;
