import type { WorkflowNodeAttempt } from "@shared/workflow.ts";
import {
  countedChecks,
  notReportedWhenFailed,
  waitForCiSettings,
  waitForCiTruncated,
  waitForCiTruncationText,
  type CiCheckRun,
  type WaitForCiSettings,
} from "@shared/wait-for-ci.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { waitForCiHeadline, waitForCiSettingsLine, waitForCiStateOf } from "./run-model.ts";

const CHECK_STATE_WORDS: Record<CiCheckRun["state"], string> = {
  pending: "Running",
  passing: "Passed",
  failing: "Failed",
};

/**
 * Why a check does or does not count, in Required mode only, read off `countedChecks` so the
 * panel cannot disagree with the decision. "Not required" is said only for a check the node did
 * not count: in the fallback, with none marked, every check counts.
 */
function checkTag(run: CiCheckRun, settings: WaitForCiSettings, counted: ReadonlySet<CiCheckRun>): string | null {
  if (settings.strictness !== "required") return null;
  if (run.required === true) return "Required";
  if (settings.expectedChecks.includes(run.name)) return "Expected";
  return counted.has(run) ? null : "Not required";
}

/**
 * What a Wait for CI attempt is waiting for, or what it decided: the pull request and head,
 * the settings it judges under, each check with its state (tagged in Required mode, with a row
 * for each expected check not reported yet), the counted failing checks on a fail, and the block
 * sentence when it blocked. Renders nothing for any other attempt, so the attempt and verdict
 * cards can include it unconditionally.
 */
export function WaitForCiPanel({
  attempt,
  now = Date.now(),
}: {
  attempt: Pick<WorkflowNodeAttempt, "output">;
  now?: number;
}): React.JSX.Element | null {
  const state = waitForCiStateOf(attempt);
  if (!state) return null;
  const settings = waitForCiSettings(state);
  // The panel lists only what the node counted, so a failure that is not required never reads
  // as the reason it failed.
  const counted = countedChecks(state.checkRuns, settings, state.checksTotal).counted;
  const countedSet = new Set(counted);
  const failing = counted.filter((run) => run.state === "failing");
  const unreported = state.observedAt === null ? [] : (state.missingExpected ?? []);
  return (
    <section className="wf-run-ci" aria-label="Wait for CI">
      <p className="wf-run-ci-headline">{waitForCiHeadline(state, now)}</p>
      {state.pullRequestUrl && (
        <p className="wf-run-meta">
          <Tooltip label="Open the pull request on GitHub">
            <a href={state.pullRequestUrl} target="_blank" rel="noreferrer">
              {state.pullRequestKey ?? state.pullRequestUrl}
            </a>
          </Tooltip>
          {state.expectedHeadOid ? ` · head ${state.expectedHeadOid.slice(0, 12)}` : ""}
        </p>
      )}
      <p className="wf-run-meta">{waitForCiSettingsLine(state)}</p>
      {state.requiredFallback && (
        <p className="wf-run-meta">No check on this head is marked required, so every check was judged.</p>
      )}
      {waitForCiTruncated(state) && <p className="wf-run-meta">{`${waitForCiTruncationText(state.checksTotal)}.`}</p>}
      {state.outcome === "fail" && failing.length > 0 && (
        <>
          <h5>Failing checks</h5>
          <ul className="wf-run-ci-failing">
            {failing.map((run, index) => (
              <li key={`${index}:${run.name}`}>
                <strong>{run.name}</strong>
                {run.conclusion ? ` · ${run.conclusion.toLowerCase()}` : ""}
                {run.title ? ` · ${run.title}` : ""}
                {run.detailsUrl && (
                  <>
                    {" · "}
                    <Tooltip label={`Open ${run.name} on GitHub`}>
                      <a href={run.detailsUrl} target="_blank" rel="noreferrer">details</a>
                    </Tooltip>
                  </>
                )}
              </li>
            ))}
          </ul>
          {unreported.length > 0 && (
            <p className="wf-run-meta">{notReportedWhenFailed(unreported)}</p>
          )}
        </>
      )}
      {(state.checkRuns.length > 0 || unreported.length > 0) && (
        <details open={state.outcome === null}>
          <Tooltip label="Show every check GitHub reported on the head commit">
            <summary>{`Checks on the head commit (${state.checkRuns.length})`}</summary>
          </Tooltip>
          <ul className="wf-run-ci-checks" aria-label="CI checks">
            {state.checkRuns.map((run, index) => {
              const tag = checkTag(run, settings, countedSet);
              return (
                <li key={`${index}:${run.name}`} className={`is-${run.state}`}>
                  <span>{run.name}</span>
                  {tag && <> <span className="wf-run-ci-tag">{tag}</span></>}
                  {" "}<span className="wf-run-meta">{CHECK_STATE_WORDS[run.state]}</span>
                </li>
              );
            })}
            {unreported.map((name) => (
              <li key={`expected:${name}`} className="is-pending">
                <span>{name}</span> <span className="wf-run-ci-tag">Expected</span>
                {" "}<span className="wf-run-meta">Not reported yet</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {state.outcome === null && state.checkRuns.length === 0 && unreported.length === 0 && (
        <p className="wf-run-meta">
          {state.observedAt === null
            ? "GitHub Inspector has not read CI for this head yet."
            : "No CI check has appeared on this head yet."}
        </p>
      )}
    </section>
  );
}
