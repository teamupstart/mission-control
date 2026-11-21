import type { DiscoveredShaper } from "@shared/shaping.ts";

/**
 * Shapers found in the shapers folder under the state home. The folder is read by the phase
 * that adds it; until then nothing is discovered, and the engine, the dry run and
 * `GET /api/shaping` already ask this function, so that phase changes only this file.
 */
export async function discoverShapers(): Promise<DiscoveredShaper[]> {
  return [];
}
