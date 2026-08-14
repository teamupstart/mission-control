import type { ArchiveKind } from "@shared/archives.ts";
import { planScoutCapture } from "../scouts/capture-plan.ts";
import type { CapturePlanner } from "./plan.ts";

/**
 * Which kinds this build knows how to CAPTURE, and how.
 *
 * The register is the whole point, and so is what is missing from it. `ARCHIVE_KINDS` is the
 * append-only vocabulary a manifest may declare, and this build can READ every member of it -
 * a bundle from a newer Mission Control should be listed for what it is rather than refused
 * over a name. Writing is the opposite question and gets its own answer here: a kind with no
 * entry cannot be captured, and `captureArchive` refuses the job by name rather than
 * publishing something it has no rule for.
 *
 * `Partial` rather than a total `Record` for exactly that reason. Making it total would force
 * a placeholder planner for every readable kind, and a placeholder that returns an empty plan
 * is how a build starts publishing empty bundles for work it does not understand.
 */
const PLANNERS: Partial<Record<ArchiveKind, CapturePlanner>> = {
  scout: planScoutCapture,
};

/** The planner for one kind, or null when this build cannot produce that kind of archive. */
export function plannerFor(kind: ArchiveKind): CapturePlanner | null {
  return PLANNERS[kind] ?? null;
}
