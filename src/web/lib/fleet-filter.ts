import { AGENT_IDENTITY } from "../../shared/agent.ts";
import { sessionWorkspaceRoot } from "../../shared/session.ts";
import { TASK_KIND_INFO, taskHasRepository } from "../../shared/task.ts";
import type { RestoringSession, Session } from "../../shared/types.ts";
import { costChipText, subtitle } from "../components/session-bits.tsx";
import { BLOCKER_KIND_LABELS } from "./blocker.ts";
import { permissionModeDisplay, relativeTime, sessionTitleDetail, stateDisplay, uptime } from "./format.ts";
import { matchesEveryWord, pathLeaf } from "./search-text.ts";

/**
 * Everything a session's card says about it, as searchable text.
 *
 * The nav-bar search has to find a card by anything the operator can read on it - the
 * title, the goal, the repository and checkout (by name and by the full path on hover), the
 * branch, the model, the effort, the permission mode, the context meter, the cost, the
 * last-seen time, the agent, the task kind, the blocker, the pull request - not only the
 * handful of fields it used to know about. A fact is included whether or not the operator
 * has switched its card item off in Settings > Display: hiding the worktree pill is a
 * choice about ink, not a request that "mission-control" stop finding the session.
 *
 * The one thing left out is the live activity ticker ("running Bash", or a background
 * agent's line): it is what the session is doing this second, not what the card is about.
 *
 * Uses the display label instead of raw `state`: a passively discovered session's raw
 * state is "working" while its badge reads "running", so indexing raw state would make
 * "working" match every live session rather than what the operator can see.
 */
export function sessionSearchFields(session: Session): string[] {
  const workspaceRoot = sessionWorkspaceRoot(session);
  const fields: (string | null | undefined)[] = [
    session.name,
    sessionTitleDetail(session),
    session.task?.fullTitle,
    stateDisplay(session).label,
    session.agent,
    AGENT_IDENTITY[session.agent]?.label,
    subtitle(session),
    session.goal?.text,
    // Repository and checkout: the name the card prints and the full path its tooltip shows.
    session.repoRoot && pathLeaf(session.repoRoot),
    session.repoRoot,
    session.gitRoot,
    workspaceRoot && pathLeaf(workspaceRoot),
    workspaceRoot,
    session.workspace?.branch,
    session.gitBranch,
    // The foot's branch cell when there is no branch to print. Its other fallback, the name
    // source ("sdk", "tmux"), is already spelled by `subtitle` and the "Agent SDK" chip above.
    taskHasRepository(session.task ?? {}) ? null : "no repository",
    // Runtime row: model, advisor, effort, permission mode.
    session.meta?.model,
    session.meta?.modelId,
    session.configuredModel,
    session.meta?.advisorModel,
    session.meta?.thinkingLevel,
    session.meta?.nativeEffort,
    permissionModeDisplay(session.permissionMode)?.label,
    session.meta?.contextPct != null ? `${session.meta.contextPct}%` : null,
    costChipText(session.cost),
    // The card's last-seen cell, as it reads right now.
    session.lastActivity ? relativeTime(session.lastActivity) : uptime(session.startedAt),
    // The task behind it.
    session.task && TASK_KIND_INFO[session.task.kind]?.label,
    // Blocker facts.
    session.blocker && BLOCKER_KIND_LABELS[session.blocker.kind],
    session.blocker?.reason,
    session.blocker?.waitingOn,
    // The pull-request label visible on the card. Only while the card has a chip to show.
    session.prUrl && session.prNumber !== null ? `PR #${session.prNumber}` : null,
    session.prUrl && session.prState ? `PR ${session.prState}` : null,
  ];
  return fields.filter((field): field is string => typeof field === "string" && field !== "");
}

/** True when a session matches the nav-bar query: every query word appears on its card. */
export function matchesSessionFilter(session: Session, query: string): boolean {
  return matchesEveryWord(sessionSearchFields(session), query);
}

/**
 * The restoring-row counterpart of `matchesSessionFilter`: a row still being restored can say
 * only its name, its agent, and that it is restoring, so those are what it matches on.
 */
export function matchesRestoringFilter(session: RestoringSession, query: string): boolean {
  return matchesEveryWord([session.name, "restoring", session.agent], query);
}
