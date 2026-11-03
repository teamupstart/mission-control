import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  LAUNCH_FAILURE_PHASE_COPY,
  hasOpenLaunchFailure,
  launchFailureOutcome,
  isLaunchFailureReport,
  latestLaunchFailure,
  openLaunchFailureGroups,
  type LaunchFailureGroup,
  type LaunchFailureOutcome,
} from "@shared/launch-failure.ts";
import { isActiveTask } from "@shared/task-status.ts";
import { TASK_KIND_BEHAVIOR, taskHasRepository, taskKindAllowsBacklog } from "@shared/task.ts";
import { fullTaskTitle } from "@shared/title.ts";
import type { Task } from "@shared/types.ts";
import { api, fetchRepos } from "../lib/api.ts";
import { relativeTime, repoLeaf } from "../lib/format.ts";
import { readLastDispatchRepo } from "../lib/lastRepo.ts";
import { containTourTab } from "../tour/focus-containment.ts";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { RepoCombobox } from "./RepoCombobox.tsx";
import { AgentDot } from "./session-bits.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * A dispatch that never started, drawn. The record and every reading of it are
 * `@shared/launch-failure.ts`; this file is only where it lands on screen.
 *
 * Three places, one per outcome, and one action row shared by all of them:
 *
 * - `not-started`: a failed tile in the placeholder's place at the top of `working`, on the
 *   Board and in the Console rail. Same spot, so a dispatch that failed is found where the
 *   dispatch was last seen rather than nowhere.
 * - `returned`: a notice on the task's Backlog card, which already prints the reason.
 * - `kept`: a notice on the session's card, which otherwise could not say why it failed.
 *
 * The actions reach the App through `LaunchFailureProvider` rather than as props, because the
 * three surfaces sit at different depths of three layouts and each would otherwise thread the
 * same six callbacks through every component between them.
 */

export interface LaunchFailureControls {
  tasks: readonly Task[];
  /** Open the Report bug confirmation for this failure. */
  openReport: (task: Task) => void;
  /** Launch a resident profile again, through the one resident launch call. */
  launchResident: (profileId: string) => void;
  openProfile: (profileId: string) => void;
  openSession: (sessionId: string) => void;
}

const LaunchFailureContext = createContext<LaunchFailureControls | null>(null);

export const LaunchFailureProvider = LaunchFailureContext.Provider;

/** The element a "Show" scrolls to: the surface drawing the group's newest attempt. */
export function launchFailureAnchorId(taskId: string): string {
  return `launch-failure-${taskId}`;
}

/** Bring the surface drawing this task's failure into view and give it focus. False if none is drawn. */
export function revealLaunchFailure(tasks: readonly Task[], taskId: string): boolean {
  const group = openLaunchFailureGroups(tasks).find((g) => g.tasks.some((t) => t.id === taskId));
  const target = group ? document.getElementById(launchFailureAnchorId(latestLaunchFailure(group).id)) : null;
  if (!target) return false;
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  target.focus({ preventScroll: true });
  return true;
}

function title(task: Task): string {
  return fullTaskTitle(task.title, task.intent);
}

/** The report session a group started, and how far it has got. */
function reportState(group: LaunchFailureGroup, tasks: readonly Task[]):
  | { kind: "none" }
  | { kind: "starting" }
  | { kind: "open"; sessionId: string } {
  const id = group.tasks.map((t) => t.launchFailure?.reportTaskId).find((v) => v) ?? null;
  const report = id ? tasks.find((t) => t.id === id) : undefined;
  if (!report || !isActiveTask(report.status)) return { kind: "none" };
  return report.sessionId ? { kind: "open", sessionId: report.sessionId } : { kind: "starting" };
}

/**
 * Retry, Report bug and Dismiss, and the kind's own way back in. Clicks stop here: every
 * surface this sits on is itself clickable (a tile opens its session, a Backlog card its editor).
 */
export function LaunchFailureActions({ group }: { group: LaunchFailureGroup }): React.JSX.Element | null {
  const controls = useContext(LaunchFailureContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!controls) return null;
  const latest = latestLaunchFailure(group);
  const name = title(latest);
  const ids = group.tasks.map((t) => t.id);
  const isReportSession = isLaunchFailureReport(latest);
  const report = reportState(group, controls.tasks);
  const profileId = latest.launchFailure?.residentProfileId ?? null;
  const resident = TASK_KIND_BEHAVIOR[latest.kind].launch === "resident";

  async function run(action: () => Promise<{ ok: boolean; error?: string | null }>, fallback: string): Promise<void> {
    setBusy(true);
    setError(null);
    const r = await action();
    setBusy(false);
    if (!r.ok) setError(r.error ?? fallback);
  }

  return (
    <div
      className="lf-actions"
      // Clicks only: a keyboard press on a button arrives as its click, and the Backlog
      // column's Escape and select-all, and the app's shortcuts, must still hear keys.
      onClick={(event) => event.stopPropagation()}
    >
      {group.outcome === "not-started" && resident && profileId && (
        <>
          <Tooltip label={`Open the ${name} profile`}>
            <button type="button" className="btn btn-ghost lf-btn" onClick={() => controls.openProfile(profileId)}>
              Open profile
            </button>
          </Tooltip>
          <Tooltip label={`Launch ${name} again from its profile`}>
            <button type="button" className="btn lf-btn" onClick={() => controls.launchResident(profileId)}>
              Launch again
            </button>
          </Tooltip>
        </>
      )}
      {group.outcome === "not-started" && !resident && (
        <Tooltip
          label={taskKindAllowsBacklog(latest.kind)
            ? `Dispatch ${name} again as the same task`
            : `File ${name} again as a new ${latest.kind} with the same settings and dispatch it`}
        >
          <button
            type="button"
            className="btn lf-btn"
            disabled={busy}
            onClick={() => void run(() => api.retryLaunchFailure(latest.id), "could not retry that launch")}
          >
            Retry
          </button>
        </Tooltip>
      )}
      {group.outcome === "kept" && latest.sessionId && (
        <Tooltip label={`Open the session ${name} kept`}>
          <button type="button" className="btn lf-btn" onClick={() => controls.openSession(latest.sessionId!)}>
            Open
          </button>
        </Tooltip>
      )}
      {!isReportSession && (report.kind === "open" ? (
        <Tooltip label="Open the session reporting this failure">
          <button type="button" className="btn lf-btn lf-report" onClick={() => controls.openSession(report.sessionId)}>
            Open report session
          </button>
        </Tooltip>
      ) : (
        <Tooltip
          label={report.kind === "starting"
            ? "The report session is starting"
            : "Start a session that catalogs this failure and drafts a public bug report for you to review"}
        >
          <button
            type="button"
            className="btn lf-btn lf-report"
            disabled={report.kind === "starting"}
            onClick={() => controls.openReport(latest)}
          >
            {report.kind === "starting" ? "Report starting…" : "Report bug"}
          </button>
        </Tooltip>
      ))}
      <Tooltip
        label={group.tasks.length > 1
          ? `Dismiss all ${group.tasks.length} attempts; the reason stays on each task`
          : "Dismiss this; the reason stays on the task"}
      >
        <button
          type="button"
          className="btn btn-ghost lf-btn"
          disabled={busy}
          onClick={() => void run(() => api.dismissLaunchFailures(ids), "could not dismiss that")}
        >
          Dismiss
        </button>
      </Tooltip>
      {error && <p className="lf-error" role="alert">{error}</p>}
    </div>
  );
}

function AttemptCount({ group }: { group: LaunchFailureGroup }): React.JSX.Element | null {
  const n = group.tasks.length;
  if (n < 2) return null;
  return (
    <Tooltip label={`${n} attempts failed the same way`}>
      <span className="lf-count">×{n}</span>
    </Tooltip>
  );
}

function where(task: Task): string {
  return taskHasRepository(task) ? repoLeaf(task.repoRoot) : "resident workspace";
}

/** What each outcome is called where a failed tile or row names it. */
const OUTCOME_STATE: Record<LaunchFailureOutcome, string> = {
  "not-started": "Did not start",
  returned: "Did not start, back in Backlog",
  kept: "Launch failed, session kept",
};
const OUTCOME_RAIL_STATE: Record<LaunchFailureOutcome, string> = {
  "not-started": "did not start",
  returned: "back in Backlog",
  kept: "session kept",
};
const OUTCOME_LABEL: Record<LaunchFailureOutcome, string> = {
  "not-started": "did not start",
  returned: "did not start and went back to the Backlog",
  kept: "failed to launch, its session kept",
};

/** The Board's failed tile: the placeholder, stopped, saying why. */
function FailedLaunchTile({ group }: { group: LaunchFailureGroup }): React.JSX.Element {
  const latest = latestLaunchFailure(group);
  const name = title(latest);
  const phase = LAUNCH_FAILURE_PHASE_COPY[latest.launchFailure!.phase];
  return (
    <div
      className="tile lf-tile"
      id={launchFailureAnchorId(latest.id)}
      tabIndex={-1}
      aria-label={`${name} ${OUTCOME_LABEL[group.outcome]}`}
    >
      <span className="tile-head">
        <AgentDot agent={latest.agent} />
        <Tooltip label={name}>
          <span className="tile-name">{name}</span>
        </Tooltip>
        <AttemptCount group={group} />
      </span>
      <span className="lf-state">
        {OUTCOME_STATE[group.outcome]} <span className="lf-phase">{phase}</span>
        <span className="lf-kind">{latest.kind}</span>
      </span>
      <p className="lf-reason">{latest.error ?? "The dispatch failed without a reason."}</p>
      <span className="tile-foot lf-foot">
        <span>{relativeTime(latest.launchFailure!.at)}</span>
        <span>{where(latest)}</span>
      </span>
      <LaunchFailureActions group={group} />
    </div>
  );
}

/** The Console rail's failed row, the rail-shaped twin of the tile. */
function FailedLaunchRailRow({ group }: { group: LaunchFailureGroup }): React.JSX.Element {
  const latest = latestLaunchFailure(group);
  const name = title(latest);
  return (
    <div
      className="rail-row lf-rail"
      id={launchFailureAnchorId(latest.id)}
      tabIndex={-1}
      aria-label={`${name} ${OUTCOME_LABEL[group.outcome]}`}
    >
      <AgentDot agent={latest.agent} />
      <Tooltip label={name}>
        <span className="rail-name">{name}</span>
      </Tooltip>
      <span className="rail-right">
        <span className="rail-state-line">
          <span className="rail-state lf-rail-state">{OUTCOME_RAIL_STATE[group.outcome]}</span>
        </span>
        <span className="rail-meta"><AttemptCount group={group} /></span>
      </span>
      <Tooltip label={latest.error ?? "The dispatch failed without a reason."}>
        <span className="rail-sub lf-reason">{latest.error ?? "The dispatch failed without a reason."}</span>
      </Tooltip>
      <LaunchFailureActions group={group} />
    </div>
  );
}

/**
 * Every failed tile in one fleet surface, as a labelled list - the `PendingList` it replaces
 * a placeholder of, under the name a screen reader and a spec select it by.
 */
export function FailedLaunchList({
  groups,
  variant,
}: {
  groups: readonly LaunchFailureGroup[];
  variant: "tile" | "rail";
}): React.JSX.Element | null {
  if (groups.length === 0) return null;
  return (
    <div className={`pend-list pend-list-${variant} lf-list`} role="list" aria-label="Did not start">
      {groups.map((group) => (
        <div role="listitem" key={group.key}>
          {variant === "tile" ? <FailedLaunchTile group={group} /> : <FailedLaunchRailRow group={group} />}
        </div>
      ))}
    </div>
  );
}

/**
 * The failed tiles or rows a fleet surface draws: every open failure no other surface on it is
 * showing. A dispatch that never got a session always lands here. A returned or kept failure
 * lands here unless `drawnElsewhere` says its own card - the Backlog card, the session card - is
 * on screen, so every open failure is reachable on whatever layout, filter and column folds
 * the operator has, and none is drawn twice. The default draws everything, which is the Console
 * rail: it has no Backlog column, and its session rows carry no notices.
 */
export function fleetFailureGroups(
  tasks: readonly Task[],
  drawnElsewhere: (group: LaunchFailureGroup) => boolean = () => false,
): LaunchFailureGroup[] {
  return openLaunchFailureGroups(tasks).filter((g) => g.outcome === "not-started" || !drawnElsewhere(g));
}

/**
 * The notice a Backlog card (`returned`) or a session card (`kept`) carries for its task.
 * Draws nothing for a task with no open failure, or outside a provider.
 */
export function LaunchFailureNotice(
  props: { taskId: string; sessionId?: undefined } | { sessionId: string; taskId?: undefined },
): React.JSX.Element | null {
  const controls = useContext(LaunchFailureContext);
  const { taskId, sessionId } = props;
  // A group is drawn once, on the card of its NEWEST attempt - the one its anchor names and the
  // one the Board's tile fallback checks for. An older attempt's card draws nothing, so two
  // cards never repeat one notice or share its anchor. A session card is handed its session,
  // and the failed task it kept is not its active task, so it is matched by the session named.
  const group = useMemo(
    () => controls
      ? openLaunchFailureGroups(controls.tasks).find((g) => {
        if (g.outcome === "not-started") return false;
        const latest = latestLaunchFailure(g);
        return taskId !== undefined ? latest.id === taskId : latest.sessionId === sessionId;
      })
      : undefined,
    [controls, taskId, sessionId],
  );
  if (!group) return null;
  const latest = latestLaunchFailure(group);
  return (
    <div className="lf-notice" id={launchFailureAnchorId(latest.id)} tabIndex={-1}>
      <span className="lf-state">
        {group.outcome === "returned" ? "Did not start, back in Backlog" : "Launch failed after its session started"}
        <AttemptCount group={group} />
      </span>
      {/* The Backlog card already prints the reason beside this; a session card does not. */}
      {group.outcome === "kept" && <p className="lf-reason">{latest.error}</p>}
      <LaunchFailureActions group={group} />
    </div>
  );
}

/**
 * The Report bug confirmation.
 *
 * A confirm, not a click-through, because the button starts a paid session that ends in a
 * public issue. It also asks the one thing the daemon cannot choose: which checkout the report
 * session runs in. The failed task's own repository when it has one; a resident's private
 * workspace is not a checkout, so it falls back to the last repository dispatched to.
 */
export function ReportLaunchFailureDialog({
  task,
  onClose,
}: {
  task: Task;
  onClose: () => void;
}): React.JSX.Element {
  const [repos, setRepos] = useState<string[]>([]);
  const [repoRoot, setRepoRoot] = useState(() => (taskHasRepository(task) ? task.repoRoot : readLastDispatchRepo()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    let alive = true;
    void fetchRepos().then((list) => {
      if (alive) setRepos(list);
    });
    return () => {
      alive = false;
    };
  }, []);
  // Read during the first render, before commit: by the time an effect runs, `autoFocus` has
  // already moved focus to Cancel, which unmounts with the dialog and could not take it back.
  const [invoker] = useState(() => document.activeElement);
  useEffect(() => () => {
    if (invoker instanceof HTMLElement && invoker.isConnected) invoker.focus();
  }, [invoker]);
  const containTab = useCallback((event: KeyboardEvent) => {
    if (formRef.current) containTourTab(event, formRef.current);
  }, []);

  async function start(): Promise<void> {
    const root = repoRoot.trim();
    if (busy || !root) return;
    setBusy(true);
    setError(null);
    const r = await api.reportLaunchFailure(task.id, root);
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? "could not start the report session");
      return;
    }
    onClose();
  }

  const name = title(task);
  return (
    <Overlay
      id={OVERLAY_IDS.launchFailureReport}
      onClose={onClose}
      className="modal lf-report-modal"
      role="dialog"
      ariaLabel="Report this launch failure"
      ariaModal
      onKeyDown={containTab}
      closable={!busy}
    >
      <form
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <header className="modal-head">
          <h2>Report this launch failure as a bug?</h2>
          <Tooltip label="Close without starting anything (Escape)">
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose} disabled={busy}>
              ✕
            </button>
          </Tooltip>
        </header>
        <div className="lf-report-body">
          <p>
            Mission Control starts a Claude session named <strong>Report: {name} did not start</strong>. It will:
          </p>
          <ul className="lf-report-steps">
            <li>Gather the failure: kind, agent, the phase it stopped in, the reason, and every attempt that failed the same way.</li>
            <li>Read the daemon log around each attempt.</li>
            <li>
              Draft a bug with <code>report_product_issue</code>. You review the exact public text and press
              Submit public issue - nothing is filed without that press.
            </li>
          </ul>
          <p className="lf-report-note">
            Intents, profile instructions, paths, repository names, MCP URLs, secrets and session text are left
            out, because the issue is public.
          </p>
          <label className="lf-report-repo" htmlFor="lf-report-repo">Run the report session in</label>
          <RepoCombobox id="lf-report-repo" repos={repos} value={repoRoot} onChange={setRepoRoot} disabled={busy} />
          {error && <p className="lf-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-foot">
          <span className="actions-spacer" />
          <Tooltip label="Close without starting anything">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy} autoFocus>
              Cancel
            </button>
          </Tooltip>
          <Tooltip label="Start the report session">
            <button type="submit" className="btn btn-primary" disabled={busy || !repoRoot.trim()}>
              {busy ? "Starting…" : "Start report session"}
            </button>
          </Tooltip>
        </footer>
      </form>
    </Overlay>
  );
}

const TOAST_MS = 15_000;

interface ToastEntry {
  key: string;
  task: Task;
}

function failureKey(task: Task): string {
  return `${task.id}:${task.launchFailure?.at ?? 0}`;
}

/**
 * The moment a launch fails: one toast per new failure, pointing at where it is drawn.
 *
 * Baselined like the notifier: whatever is already open when the stream first becomes ready
 * is the board's to show, not news. A toast closes on its own; the failure does not - closing
 * one only takes the toast away.
 */
export function LaunchFailureToasts({
  tasks,
  ready,
  onShow,
  onReport,
}: {
  tasks: readonly Task[];
  ready: boolean;
  onShow: (taskId: string) => void;
  onReport: (task: Task) => void;
}): React.JSX.Element | null {
  const seen = useRef<Set<string> | null>(null);
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  // A toast speaks for a failure that is open. Dismissed, answered by the same work starting,
  // or re-dispatched, the failure is gone and so is its toast - it would otherwise go on saying
  // "did not start" and offering Report bug for something that has since started.
  useEffect(() => {
    setToasts((prev) => {
      const live = prev.filter(({ key, task }) => {
        const now = tasks.find((t) => t.id === task.id);
        return now !== undefined && hasOpenLaunchFailure(now) && failureKey(now) === key;
      });
      return live.length === prev.length ? prev : live;
    });
  }, [tasks]);

  useEffect(() => {
    if (!ready) return;
    const open = tasks.filter(hasOpenLaunchFailure);
    if (seen.current === null) {
      seen.current = new Set(open.map(failureKey));
      return;
    }
    const fresh = open.filter((t) => !seen.current!.has(failureKey(t)));
    if (fresh.length === 0) return;
    for (const t of fresh) seen.current.add(failureKey(t));
    setToasts((prev) => [...fresh.map((task) => ({ key: failureKey(task), task })), ...prev].slice(0, 3));
  }, [tasks, ready]);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setTimeout(() => setToasts((prev) => prev.slice(0, -1)), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toasts]);

  if (toasts.length === 0) return null;
  const close = (key: string): void => setToasts((prev) => prev.filter((t) => t.key !== key));
  return (
    <div className="lf-toasts" role="region" aria-label="Launch failures">
      {toasts.map(({ key, task }) => {
        const name = title(task);
        const returned = launchFailureOutcome(task) === "returned";
        return (
          <div className="lf-toast" role="status" key={key}>
            <strong className="lf-toast-title">
              {name} {returned ? "did not start and went back to the Backlog" : "did not start"}
            </strong>
            <p className="lf-reason">{task.error ?? "The dispatch failed without a reason."}</p>
            <div className="lf-actions">
              <Tooltip label="Show it on the board">
                <button type="button" className="btn lf-btn" onClick={() => { close(key); onShow(task.id); }}>
                  Show
                </button>
              </Tooltip>
              {!isLaunchFailureReport(task) && (
                <Tooltip label="Start a session that catalogs this failure and drafts a public bug report for you to review">
                  <button type="button" className="btn lf-btn lf-report" onClick={() => { close(key); onReport(task); }}>
                    Report bug
                  </button>
                </Tooltip>
              )}
              <Tooltip label="Close this notice; the failure stays on the board until you dismiss it there">
                <button type="button" className="btn btn-ghost lf-btn" onClick={() => close(key)}>
                  Close
                </button>
              </Tooltip>
            </div>
          </div>
        );
      })}
    </div>
  );
}
