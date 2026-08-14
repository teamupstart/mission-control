import {
  SCOUT_REPORT_FILENAME,
  SCOUT_REPORT_PATH_SHAPE,
  SCOUT_REPORT_ROOT,
} from "@shared/scouts.ts";
import type { Task } from "@shared/types.ts";
import type { ArchiveRepoSlot } from "../archives/capture-store.ts";
import { SUBMIT_SCOUT_ARTIFACTS_TOOL } from "./submission-tool.ts";

/**
 * The delivery contract every scout gets, whatever the operator's Skills settings say.
 *
 * `skills/html-report/SKILL.md` already teaches an agent to write one of these pages, and it
 * is good at it - but it is OPT-IN model guidance, so a scout dispatched with skills globally
 * disabled would produce a chat answer and nothing durable. The archive is a server-enforced
 * output contract now, so the requirement has to travel with the task rather than with a
 * setting: this appendix is composed at the task-delivery boundary and reaches a fresh
 * dispatch and a backlog scout assigned to an existing session alike.
 *
 * It is an APPENDIX, after the operator's intent, deliberately. The agent's first job is the
 * question it was asked; this says what "delivered" means for a scout. Nothing here clamps or
 * rewrites the intent - a scout that could not read its own request intact would fail at
 * something more important than its file layout. `../task-contract.ts` is what appends it, for
 * every kind that has one, at both delivery seams.
 *
 * Kept aligned with the skill by `test/scout-prompt.test.ts`, which reads both files: the
 * required path, the self-contained static rule, answer-first structure, the citation rule,
 * the final path handoff, and the absence of a short-answer exception.
 */

/** The marker that opens the appendix. A stable anchor for tests and for a human reading a pane. */
export const SCOUT_APPENDIX_MARKER = "--- Mission Control scout ---";

/**
 * Whether this task's delivery carries the scout contract.
 *
 * One predicate rather than `task.kind === "scout"` spelled at each seam: the two delivery
 * paths and the launch requirement must agree about which tasks are scouts, and a third
 * reading of the same field is where "the prompt said so but the launch did not" comes from.
 */
export function isScoutTask(task: Pick<Task, "kind">): boolean {
  return task.kind === "scout";
}

/**
 * The contract text itself.
 *
 * Compact on purpose. It competes for attention with the operator's own request, and a page
 * of rules is read like a page of none - so each line is a thing the archive will actually
 * refuse or lose if it is not done.
 */
export function scoutReportAppendix(slots: readonly ArchiveRepoSlot[]): string {
  const lines = [
    SCOUT_APPENDIX_MARKER,
    "This is a scout task. The deliverable is the answer, written as one page - not a change,",
    "and not a wall of chat text. Mission Control archives that page and the evidence you name,",
    "and the archive outlives this session, its checkout, and this task card. The conversation is",
    "NOT archived, so anything worth keeping belongs in the report.",
    "",
    `1. Write the report to \`${SCOUT_REPORT_PATH_SHAPE}\`, where \`<slug>\` is a short kebab-case`,
    "   name for the question. Write it even when the answer is one sentence - a short scout still",
    "   produces the page.",
    "2. Answer first. The title, the question as asked, and the finding in the first screen; then",
    "   the evidence; then what you did not establish.",
    "3. Self-contained and static. Inline the CSS in one `<style>`, draw charts as inline SVG, embed",
    "   images as `data:` URIs. NO JavaScript, no forms, no frames, no `<base>`, no meta refresh, and",
    "   no external request of any kind - the page must open correctly from `file://` with no network.",
    "   Mission Control archives the exact bytes and refuses a page that cannot.",
    "4. Anything the report links to goes in that same directory, beside the page, linked relatively",
    "   (`evidence.csv`). A relative link that leaves the report directory is refused. The whole",
    "   directory is captured for you - you do not list its files when you submit.",
    "5. Cite ordinary source files as visible text with no href - `<code>src/server/registry.ts:42</code>`.",
    "   The checkout is gone by the time anyone reads the archive, so a link into it would be dead.",
    `6. When the page is written, call the \`${SUBMIT_SCOUT_ARTIFACTS_TOOL}\` tool with the report path,`,
    "   a short plain-text summary of the finding, optional tags, and only the additional files worth",
    "   preserving. Mission Control derives everything else; you never name a task, a destination, or",
    "   an archive.",
    ...supportingLines(slots),
    `7. Finish by naming the report path on its own line, e.g. \`${SCOUT_REPORT_ROOT}/<slug>/${SCOUT_REPORT_FILENAME}\`.`,
    "   Do NOT open a pull request for the report. A scout ships an answer, not a change.",
    "",
    "This task cannot be marked done until that page is submitted and verified, so a missing or",
    "invalid report comes back to you with the exact problem rather than silently ending the work.",
  ];
  return lines.join("\n");
}

/**
 * How to name an additional supporting file, in the slots this task actually issued.
 *
 * Spelled out per repository rather than left implicit, because a multi-repo scout has no
 * other way to say WHICH checkout a path is relative to - and a locator whose slot is guessed
 * reaches nothing at all.
 */
function supportingLines(slots: readonly ArchiveRepoSlot[]): string[] {
  if (slots.length === 0) return [];
  if (slots.length === 1) {
    const only = slots[0]!;
    return [
      `   An additional file is \`{ repoSlot: "${only.slot}", path: "<path relative to your checkout>" }\`.`,
    ];
  }
  return [
    "   An additional file is `{ repoSlot, path }`, where the slot names one of your checkouts:",
    ...slots.map((slot) => {
      const where = slot.primary ? " (your working directory)" : "";
      return `   - \`${slot.slot}\` - ${slot.label ?? "unnamed repository"}${where}`;
    }),
    "   and `path` is relative to that checkout.",
  ];
}
