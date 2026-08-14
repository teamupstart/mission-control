import type { ScoutArchiveSummary, ScoutIndexStatus } from "@shared/scouts.ts";

/**
 * The words the Scouts page puts beside every state colour.
 *
 * Shared by the rail, the reader and the delete confirmation so one archive is never
 * called "Partial" in one pane and "Incomplete" in the next.
 */
export const SCOUT_STATUS_WORD: Record<ScoutIndexStatus, string> = {
  ready: "Complete",
  partial: "Partial",
  unreadable: "Unreadable",
};

/**
 * What to call an archive on screen.
 *
 * An UNREADABLE bundle has NO title, because a title comes out of a manifest the daemon
 * could not parse. Without this fallback such a row renders as a blank line with a red dot
 * beside it, which reads as a rendering bug rather than as the honest "this bundle is here
 * and cannot be read" that it is - and the delete confirmation for it would name nothing at
 * all. Found by seeding a corrupt manifest and looking at the running page; nothing in the
 * type says empty, because `title` is a non-optional string.
 */
export function scoutLabel(
  archive: Pick<ScoutArchiveSummary, "title" | "archiveId">,
): string {
  return archive.title.trim() || `Unreadable archive ${archive.archiveId.slice(0, 8)}`;
}
