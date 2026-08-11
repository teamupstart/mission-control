import { useEffect, useState } from "react";
import type {
  WorkflowCheckSlot,
  WorkflowConfig,
  WorkflowStatus,
  WorkflowSummary,
} from "@shared/workflow.ts";
import {
  WORKFLOW_CHECK_SLOTS,
  checkCommandRoot,
  formatCheckCommand,
  parseCheckCommand,
} from "@shared/workflow.ts";
import type { WorkflowSettingsState } from "../useWorkflowSettings.ts";
import { fetchRepos, resolveRepo } from "../lib/api.ts";
import type { SettingsNavigate } from "../lib/settings-registry.ts";
import { RepoCombobox } from "./RepoCombobox.tsx";
import { RepositoryName } from "./RepositoryName.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { TrustGrantSummary } from "./TrustPanel.tsx";
import {
  ConsoleCard,
  ConsoleLinkStrip,
  ConsoleState,
  ConsoleSwitch,
  type ConsoleLink,
} from "./settings-console.tsx";
import {
  missionRouteHash,
  type WorkflowRunFilters,
} from "../workflows/useWorkflowRoute.ts";
import {
  WorkflowConfirmModal,
  type WorkflowConfirmRequest,
} from "../workflows/WorkflowConfirmModal.tsx";

// The Workflow subsystem's settings, as a settings category.
//
// It used to be a floating drawer hanging off the Workflows page header - a parallel
// settings surface with no rail row, no scope badge, no deep link and no search coverage,
// so the one switch in this app that can type into somebody's live agent session was the
// one switch you could not find by searching for it. Same routes, same config blob, same
// consent copy; what changed is that it is now where every other subsystem's settings are.
//
// It is drawn with the settings console's leaves (`settings-console.tsx`) and takes exactly
// two of that shape's three pieces. It has NO ledger, and therefore no two-column split:
// `WorkflowRuns.tsx` is already the run list - cursor paging, SSE reconciliation, per-run
// actions, status chips - and the Workflows page header already links here. A run table in
// this panel would be a second, worse copy of that one, in a third CSS vocabulary, and the
// two would disagree the first time either changed. Its single column stays a single
// column, and its strip navigates to the real list instead of filtering a fake one.
//
// The two confirmations go through the overlay registry (`WorkflowConfirmModal`) rather
// than `window.confirm`, for that component's own reason: a native dialog is invisible to
// the registry, so the fleet's global key handler stays live behind it.

/** The retention boxes as typed text, so a half-entered number is not a config write. */
interface RetentionDraft {
  rawEvidenceDays: string;
  completedRunDays: string;
  maxCompletedRuns: string;
}

function draftOf(config: WorkflowConfig): RetentionDraft {
  return {
    rawEvidenceDays: String(config.retention.rawEvidenceDays),
    completedRunDays: String(config.retention.completedRunDays),
    maxCompletedRuns: String(config.retention.maxCompletedRuns),
  };
}

/**
 * The ranges the daemon's own schema enforces, restated here so the panel refuses locally
 * with a sentence instead of bouncing off a 400. Kept as one table because the number in
 * the message and the number in the `min`/`max` attributes have to be the same number.
 */
const RETENTION_FIELDS = [
  {
    key: "rawEvidenceDays",
    label: "Raw evidence days",
    hint: "Days before raw evidence is compacted out of an eligible finished run.",
    min: 1,
    max: 365,
  },
  {
    key: "completedRunDays",
    label: "Completed run days",
    hint: "Days before a finished run family may be removed entirely.",
    min: 30,
    max: 3_650,
  },
  {
    key: "maxCompletedRuns",
    label: "Newest completed runs kept",
    hint: "This many newest finished runs are kept whatever their age.",
    min: 100,
    max: 10_000,
  },
] as const satisfies readonly {
  key: keyof RetentionDraft;
  label: string;
  hint: string;
  min: number;
  max: number;
}[];

/**
 * The typed retention boxes as numbers, or the sentence saying which one is out of range.
 *
 * Pure, and exported, because the interesting cases cannot be reached by rendering: a
 * static render types nothing, and this is the gate deciding whether a shortening confirm
 * is even offered.
 */
export function readRetention(
  draft: RetentionDraft,
): { ok: true; value: WorkflowConfig["retention"] } | { ok: false; error: string } {
  const out = {} as WorkflowConfig["retention"];
  for (const field of RETENTION_FIELDS) {
    const value = Number(draft[field.key]);
    if (!Number.isInteger(value) || value < field.min || value > field.max) {
      return {
        ok: false,
        error: `${field.label} must be a whole number between ${field.min} and ${field.max}.`,
      };
    }
    out[field.key] = value;
  }
  return { ok: true, value: out };
}

/**
 * The paths the check row's picker offers: the allowlisted repositories first, then the rest
 * of the workspace scan, de-duplicated and each listed once.
 *
 * Two reasons this is not simply the workspace list the dispatch form offers. A check only
 * ever RUNS in an allowlisted repository - a slot configured anywhere else passes with a note
 * - so those are the useful answers and they lead. And the allowlist holds resolved roots
 * from anywhere on disk, while `/api/repos` scans the workspace roots only, so a repository
 * allowlisted from outside them is absent from that scan entirely: offered nowhere, the one
 * repository a check can run in would still have to be typed from memory.
 *
 * Order-preserving rather than sorted, because the leading group is the claim being made.
 * Pure and exported because a static render cannot type into the box, so this is the only
 * place the ordering is assertable.
 */
export function checkRepoOptions(
  workspaceRepos: readonly string[],
  allowlist: readonly string[],
): string[] {
  return [...new Set([...allowlist, ...workspaceRepos])];
}

/** Whether the new limits would let the next sweep remove more than the current ones. */
export function retentionShortens(
  next: WorkflowConfig["retention"],
  current: WorkflowConfig["retention"],
): boolean {
  return RETENTION_FIELDS.some((field) => next[field.key] < current[field.key]);
}

/**
 * The health strip's tiles: which `WorkflowStatus` scalar each shows, and which view of the
 * REAL run list reading it continues in.
 *
 * Ordered by escalation, not by data type, which is the point of the strip existing at all.
 * The twelve health scalars were a `<dl>` in which `uncertainDeliveries` - "a repair may or
 * may not have been typed into somebody's session and only a human can tell" - was rendered
 * in the same 10px grey as the count of Persona calls currently queued. Six of the twelve
 * are zero on a healthy install, so the two that mean somebody must look were the least
 * findable things on the panel.
 *
 * These counts do NOT sum, and no tile's count is the number of rows its link opens. They
 * are independent scalars over three populations - in-flight or uncertain deliveries, runs,
 * and delivered rows in retained run families - and the destination is the nearest honest
 * view of what the tile counted, not a re-derivation of it. `hint` therefore says what
 * clicking opens; see `ConsoleLinkStrip`.
 */
const STRIP_TILES = [
  {
    id: "needs-you",
    label: "Needs you",
    tone: "danger",
    hint: "Deliveries that could not be confirmed as typed in - only you can tell. "
      + "Opens the runs waiting on a session.",
    filters: { status: "waiting_for_session" },
    count: (s: WorkflowStatus) => s.uncertainDeliveries,
  },
  {
    id: "waiting",
    label: "Waiting",
    tone: "attention",
    hint: "Deliveries prepared or being sent right now. Opens the full run list.",
    filters: {},
    count: (s: WorkflowStatus) => s.waitingDeliveries,
  },
  {
    id: "gates",
    label: "Inspector gates",
    tone: "attention",
    hint: "Runs held at an Inspector gate. Opens the runs waiting for the Inspector.",
    filters: { status: "waiting_for_inspector" },
    count: (s: WorkflowStatus) => s.inspectorGates,
  },
  {
    // "Active", not "Running", and it opens the WHOLE list rather than `status=running`.
    // `activeRuns` is every run not completed, cancelled or failed - so a blocked run and a
    // run waiting on a session are both in it - and the first cut labelled that "Running"
    // and linked it to `status=running`. Three populations in one tile: a fleet with blocked
    // work counted it here and then could not reach it through the tile that counted it.
    //
    // Counting only `running` rows would align the three, and it is the wrong repair: it
    // would need a second scalar, and blocked runs would then appear in no tile at all,
    // which is the state this strip exists to make visible. So the count stays the useful
    // one and the label and destination move to meet it. There is no single `status` filter
    // meaning "active", so the honest destination is the unfiltered list - the same one
    // Waiting opens, for the same reason.
    id: "active",
    label: "Active",
    tone: "plain",
    hint: "Runs that have not finished, in any state - running, waiting or blocked. "
      + "Opens the full run list.",
    filters: {},
    count: (s: WorkflowStatus) => s.activeRuns,
  },
  {
    id: "delivered",
    label: "Delivered",
    tone: "ok",
    hint: "Deliveries confirmed typed into a session among retained runs. "
      + "Opens the completed runs.",
    filters: { status: "completed" },
    count: (s: WorkflowStatus) => s.deliveredDeliveries,
  },
] as const satisfies readonly {
  id: string;
  label: string;
  tone: ConsoleLink["tone"];
  hint: string;
  filters: WorkflowRunFilters;
  count: (status: WorkflowStatus) => number;
}[];

/** Where a tile goes, as the hash the runs page's own filter chips would produce. */
function tileHref(filters: WorkflowRunFilters): string {
  return missionRouteHash({
    page: "runs",
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
  });
}

/**
 * The strip's tiles for one status reading.
 *
 * Exported so a test can assert that each tile carries the scalar it claims - the failure
 * this rules out is silent and permanent, because a tile wired to the wrong field still
 * renders a plausible number and nothing on the panel contradicts it.
 *
 * A zero count still gets a tile. A missing tile reads as a missing subsystem, and "no
 * retained delivery is confirmed as sent" is a reading an operator who has just enabled
 * Live delivery specifically wants.
 */
export function workflowStripLinks(status: WorkflowStatus): ConsoleLink[] {
  return STRIP_TILES.map((tile) => ({
    id: tile.id,
    label: tile.label,
    tone: tile.tone,
    hint: tile.hint,
    count: tile.count(status),
    href: tileHref(tile.filters),
  }));
}

export function WorkflowSettingsPanel({
  state,
  workflows = [],
  foremanEnabled = false,
  onNavigate,
  onOpenRuns,
}: {
  state: WorkflowSettingsState;
  /** Live catalog; only active published workflows are valid dispatch defaults. */
  workflows?: WorkflowSummary[];
  /** The completion detector that turns the default into an automatic run. */
  foremanEnabled?: boolean;
  /**
   * Deep-link into Trust, for the grant summary that replaced this panel's repo editor.
   * The same prop Foreman, the Inspector and Shipping take for the same reason.
   */
  onNavigate: SettingsNavigate;
  /**
   * Follow a health tile to the nearest corresponding Workflows run-list view.
   *
   * Its own prop rather than a widening of `SettingsNavigate`, which the other three panels
   * take: that one is typed to settings categories, and this navigation leaves the settings
   * page entirely. Optional, so a render test can mount the panel without a router - the
   * tiles are still real links with real hashes, so nothing about them is untestable.
   */
  onOpenRuns?: (filters: WorkflowRunFilters) => void;
}): React.JSX.Element {
  const { config, status, update, error } = state;
  const [confirm, setConfirm] = useState<WorkflowConfirmRequest | null>(null);
  const [checkPath, setCheckPath] = useState("");
  const [checkSlot, setCheckSlot] = useState<WorkflowCheckSlot>(WORKFLOW_CHECK_SLOTS[0]);
  const [checkCommand, setCheckCommand] = useState("");
  const [repos, setRepos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [retention, setRetention] = useState<RetentionDraft>({
    rawEvidenceDays: "",
    completedRunDays: "",
    maxCompletedRuns: "",
  });
  // Adopt the daemon's values once, when the first read lands. Keyed on the config object
  // rather than on its numbers so a later poll cannot overwrite a half-typed box - the
  // boxes are a draft the operator applies, not a mirror of what is stored.
  const [adopted, setAdopted] = useState(false);
  useEffect(() => {
    if (config && !adopted) {
      setRetention(draftOf(config));
      setAdopted(true);
    }
  }, [config, adopted]);

  // Index the workspace's repos so the check row's path box can be picked from rather than
  // typed from memory. The same `fetchRepos` the dispatch form, Trust, Task sources and the
  // schedule editor use, so every surface asking "which repository?" offers one list; it
  // never throws, answering [] when the daemon cannot be reached, which degrades the picker
  // to the free-text box this row already was.
  useEffect(() => {
    let alive = true;
    void fetchRepos().then((list) => {
      if (alive) setRepos(list);
    });
    return () => {
      alive = false;
    };
  }, []);

  const liveEnabled = config?.liveEnabled ?? false;
  const allowlist = config?.repoAllowlist ?? [];
  const checksEnabled = config?.checksEnabled ?? false;
  const parsedCheckCommand = parseCheckCommand(checkCommand);
  const publishedWorkflows = workflows.filter(
    (workflow) => workflow.archivedAt === null && workflow.currentVersionId !== null,
  );

  const save = async (next: WorkflowConfig): Promise<void> => {
    setBusy(true);
    setLocalError(null);
    try {
      await update(next);
    } finally {
      setBusy(false);
    }
  };

  const toggleLive = (enabled: boolean): void => {
    if (!config) return;
    if (!enabled) {
      void save({ ...config, liveEnabled: false });
      return;
    }
    setConfirm({
      title: "Enable Live workflow delivery",
      body:
        "Mission Control may paste deterministic Persona repair instructions into agent " +
        "sessions running in the repositories granted the Workflows cell in Trust. Preview " +
        "bindings stay read-only.",
      confirmLabel: "Enable Live delivery",
      confirmHint: "Allow repair packets to be typed into allowlisted sessions",
      onConfirm: () => void save({ ...config, liveEnabled: true }),
    });
  };

  const toggleChecks = (enabled: boolean): void => {
    if (!config) return;
    if (!enabled) {
      void save({ ...config, checksEnabled: false });
      return;
    }
    // The confirm copy names what is actually being authorized, which is not "running a
    // command" but running THIS BRANCH's code. The argv is the operator's; everything that
    // argv loads belongs to whoever wrote the change under review.
    setConfirm({
      title: "Enable workflow check commands",
      body:
        "A Check node runs the command you configure, in a checkout of the repository under " +
        "review, with this daemon's filesystem authority. That command loads scripts, " +
        "dependencies and source from the branch being reviewed, so enabling this executes " +
        "branch-authored code. It is not a sandbox. Only allowlisted repositories are reached.",
      confirmLabel: "Enable check commands",
      confirmHint: "Allow branch-authored code to run with the daemon's filesystem authority",
      danger: true,
      onConfirm: () => void save({ ...config, checksEnabled: true }),
    });
  };

  const addCheckCommand = async (): Promise<void> => {
    const trimmedPath = checkPath.trim();
    if (!config || !trimmedPath || busy) return;
    const parsed = parseCheckCommand(checkCommand);
    if (!parsed.ok) {
      setLocalError(parsed.error);
      return;
    }
    setBusy(true);
    setLocalError(null);
    try {
      const resolved = await resolveRepo(trimmedPath);
      if (!resolved.ok) {
        setLocalError(resolved.error);
        return;
      }
      // The TYPED path when it is inside the repository, not the resolved root. Resolving
      // is lossy in exactly the direction that matters here - `/repo/packages/web` resolves
      // to `/repo` - so storing the root alone made the documented subdirectory override
      // impossible to configure from this panel.
      const root = checkCommandRoot(resolved.repoRoot, resolved.path);
      // Replace rather than append on a repeat: (root, slot) is the identity a check
      // resolves by, so two rows for one pair would make which command runs depend on list
      // order, which the operator cannot see.
      const rest = config.checkCommands.filter(
        (item) => !(item.repoRoot === root && item.slot === checkSlot),
      );
      setCheckPath("");
      setCheckCommand("");
      await update({
        ...config,
        checkCommands: [...rest, { repoRoot: root, slot: checkSlot, command: parsed.argv }],
      });
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : "Could not resolve repository");
    } finally {
      setBusy(false);
    }
  };

  const applyRetention = (): void => {
    if (!config || busy) return;
    const read = readRetention(retention);
    if (!read.ok) {
      setLocalError(read.error);
      return;
    }
    setLocalError(null);
    const next = { ...config, retention: read.value };
    if (!retentionShortens(read.value, config.retention)) {
      void save(next);
      return;
    }
    setConfirm({
      title: "Shorten Workflow retention",
      body:
        "The next sweep can permanently compact evidence, or delete eligible completed and " +
        "cancelled run history, that today's limits would have kept. Active, waiting, " +
        "blocked, failed, orphaned and delivery-uncertain work is never age-pruned.",
      confirmLabel: "Shorten retention",
      confirmHint: "Save the shorter limits and let the next sweep act on them",
      danger: true,
      onConfirm: () => void save(next),
    });
  };

  const openTile = (id: string): void => {
    const tile = STRIP_TILES.find((candidate) => candidate.id === id);
    if (tile) onOpenRuns?.(tile.filters);
  };

  return (
    <section className="settings-section sc-section sc-solo">
      <p className="settings-hint sc-lede">
        Review workflows run Personas over a session's submitted work and route their
        verdicts back to it. What is configured here is the subsystem: whether repairs may be
        typed into a live session, where that is allowed, and how much run history is kept.
        The workflows themselves - stages, Personas, bindings - are authored on the{" "}
        <strong>Workflows</strong> page.
      </p>

      {/* The daemon has not answered. Said out loud, on the Inspector panel's rule: the
          fallbacks below are "off" and "no repos", the safe posture, and drawing them as
          the daemon's answer tells the operator nothing can be pasted anywhere while the
          stored config may well have Live enabled. */}
      {!config && (
        <p className="settings-warn wf-settings-unknown">
          Can't reach the daemon, so what Workflow delivery is actually set to is unknown.
          The controls below are showing defaults, not its current state.
        </p>
      )}

      <div className="sc-controls">
        <ConsoleCard title="Dispatch default" anchor="workflows/dispatch-default">
          <p className="settings-hint">
            Arm every new single-agent dispatch with a published Workflow. The dispatch form
            shows this choice inline and can override it per task.
          </p>
          <div className="wf-default-row">
            <span className="wf-default-flow" aria-hidden>task → workflow</span>
            <Tooltip label="Workflow preselected for every new single-agent dispatch">
              <select
                className="field-input wf-default-select"
                value={config?.defaultWorkflowId ?? ""}
                disabled={!config || busy}
                aria-label="Default after-work Workflow for dispatched tasks"
                onChange={(event) => {
                  if (!config) return;
                  void save({
                    ...config,
                    defaultWorkflowId: event.target.value || null,
                  });
                }}
              >
                <option value="">None</option>
                {publishedWorkflows.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.name} · v{workflow.publishedVersion}
                  </option>
                ))}
                {config?.defaultWorkflowId
                  && !publishedWorkflows.some(
                    (workflow) => workflow.id === config.defaultWorkflowId,
                  )
                  && (
                    <option value={config.defaultWorkflowId}>
                      Unavailable Workflow
                    </option>
                  )}
              </select>
            </Tooltip>
          </div>
          {config?.defaultWorkflowId && !foremanEnabled && (
            <p className="settings-warn wf-default-warning">
              Foreman is off. Turn it on before dispatching with this default, or choose None
              in the dispatch form.
            </p>
          )}
          {publishedWorkflows.length === 0 && (
            <p className="settings-hint wf-settings-empty">
              Publish a Workflow before choosing a dispatch default.
            </p>
          )}
        </ConsoleCard>

        <ConsoleCard
          title="Live delivery"
          anchor="workflows/live-delivery"
          action={(
            <ConsoleSwitch
              label="Enable Live workflow delivery"
              tooltip="Allow repair packets to be typed into sessions in the repos granted in Trust"
              checked={liveEnabled}
              disabled={!config || busy}
              // The one switch in this app that types into a live agent's terminal. Its
              // blast radius is a keystroke in somebody's composer, not a comment on a pull
              // request, and the tone is what says so before the confirm dialog does.
              tone="danger"
              onChange={toggleLive}
            />
          )}
        >
          {!config ? (
            <ConsoleState tone="unknown">Unknown - the daemon has not answered</ConsoleState>
          ) : liveEnabled ? (
            <ConsoleState tone="danger">
              Live - repairs are typed into agent sessions
            </ConsoleState>
          ) : (
            <ConsoleState tone="off">Off - nothing is delivered</ConsoleState>
          )}

          {liveEnabled && (
            <p className="settings-warn wf-settings-live-warn">
              Live bindings write into a real terminal pane. A repair packet is typed into the
              agent's own composer, in the repositories granted the Workflows cell in Trust
              and nowhere else.
            </p>
          )}
        </ConsoleCard>

        <ConsoleCard title="Allowed repositories" anchor="workflows/allowlist">
          {/* The editor moved to Trust, and this became the summary the other three
              grant-consuming panels already show. The comment that used to sit here argued
              Workflows was not a Trust column and that making it one would MOVE this list
              rather than summarise it; that is exactly what happened.

              The card stays rather than the anchor disappearing: `workflows/allowlist` is a
              settings-search target, and a live subsystem's consent scope is worth stating
              where its switches are even when it is not editable here. */}
          {/* The scope-of-consent sentence sits with the count, not with the switch: it is
              about the grant. "I turned Live on and it still previews" reads as a bug
              without it. */}
          <p className="settings-hint">
            Live delivery only sends in the repositories granted the Workflows cell in Trust
            - their worktrees count too, wherever they live on disk. Revoking one keeps
            existing bindings visible and refuses their next delivery; nothing is silently
            downgraded to Preview. The same grant is what lets a Check node run a command.
          </p>
          <TrustGrantSummary
            configured={Boolean(config)}
            count={allowlist.length}
            subject="Workflows may act in"
            onNavigate={onNavigate}
          />
        </ConsoleCard>

      <Tooltip label="Allow workflow Check nodes to run the commands configured below">
        <label className="alert-row wf-settings-checks" data-anchor="workflows/checks">
          <input
            type="checkbox"
            checked={checksEnabled}
            disabled={!config || busy}
            onChange={(event) => toggleChecks(event.target.checked)}
          />
          <span>Enable workflow check commands</span>
        </label>
      </Tooltip>

      {checksEnabled && (
        <p className="settings-warn wf-settings-checks-warn">
          A check runs a command in the repository under review, which executes code written
          on the branch being reviewed with this daemon's own filesystem authority. Its
          scripts, dependencies and build steps all come from that branch. This is not a
          sandbox. Only repositories granted the Workflows cell in Trust can run one.
        </p>
      )}

      <div className="wf-settings-checks-table" data-anchor="workflows/check-commands">
        <p className="settings-group-label">Check commands</p>
        {/* Why the node names a slot and this table names the command, said where an
            operator is looking for the box to type it into. Without it, "why is my check
            skipping" and "why does the workflow not say npm test" are both mysteries. */}
        <p className="settings-hint">
          A workflow's Check node names a slot, never a command, so the same workflow can
          run on any repository. This is where each repository says what its slots run. A
          slot with no command here passes with a note rather than failing, and so does one
          in a repository that is not allowlisted. Give a <strong>subdirectory</strong> to
          override a repository-wide command for one package; the command then runs there.
        </p>
        {!config ? null : config.checkCommands.length === 0 ? (
          <p className="settings-hint wf-settings-empty">
            No commands yet - every Check node will skip and pass.
          </p>
        ) : (
          <ul className="wf-settings-check-list">
            {config.checkCommands.map((entry) => (
              <li key={`${entry.repoRoot}:${entry.slot}`}>
                <span className="wf-settings-check-slot">{entry.slot}</span>
                <code className="wf-settings-check-root">
                  <RepositoryName path={entry.repoRoot} />
                </code>
                <code className="wf-settings-check-argv">{formatCheckCommand(entry.command)}</code>
                <Tooltip label={`Stop running a ${entry.slot} check in ${entry.repoRoot}`}>
                  <button
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={() => void save({
                      ...config,
                      checkCommands: config.checkCommands.filter(
                        (item) => !(item.repoRoot === entry.repoRoot && item.slot === entry.slot),
                      ),
                    })}
                  >
                    Remove
                  </button>
                </Tooltip>
              </li>
            ))}
          </ul>
        )}
        <div className="wf-settings-add wf-settings-check-add">
          <label className="sr-only" htmlFor="workflow-check-path">Repository path</label>
          {/* The shared picker, not a bare box. Every other surface in the app that asks
              "which repository?" - dispatch, Trust, Task sources, the schedule editor -
              offers the list rather than asking for a path from memory, and this row asked
              the same question with none of that help. Free text is preserved BY that
              component, which is what a subdirectory entry needs: `/repo/packages/web`
              matches no repository in the list and is still exactly what gets stored. */}
          <RepoCombobox
            id="workflow-check-path"
            repos={checkRepoOptions(repos, allowlist)}
            value={checkPath}
            onChange={setCheckPath}
            disabled={!config || busy}
            placeholder="/path/to/repository (or a subdirectory)"
          />
          <label className="sr-only" htmlFor="workflow-check-slot">Slot</label>
          <Tooltip label="Which slot a workflow's Check node has to name to run this command">
            <select
              id="workflow-check-slot"
              value={checkSlot}
              disabled={!config || busy}
              onChange={(event) => setCheckSlot(event.target.value as WorkflowCheckSlot)}
            >
              {WORKFLOW_CHECK_SLOTS.map((slot) => <option key={slot} value={slot}>{slot}</option>)}
            </select>
          </Tooltip>
          <label className="sr-only" htmlFor="workflow-check-command">Command to run</label>
          <input
            id="workflow-check-command"
            className="field-input"
            value={checkCommand}
            disabled={!config || busy}
            placeholder="npm test"
            onChange={(event) => setCheckCommand(event.target.value)}
          />
          <Tooltip label="Run this command for that slot in that repository">
            <button
              className="btn"
              disabled={!config || busy || !checkPath.trim() || !checkCommand.trim()}
              onClick={() => void addCheckCommand()}
            >
              Add command
            </button>
          </Tooltip>
        </div>
        {/* The parsed argv, shown back. There is no shell anywhere in this path, so the
            split is ours and an operator has to be able to SEE it rather than trust it -
            `npm run test -- --grep "a b"` is four arguments or six depending on a rule
            nobody can read off the box they typed into. */}
        <p className="settings-hint wf-settings-check-preview">
          {checkCommand.trim() === ""
            ? "Type a command to see exactly how it will be split."
            : parsedCheckCommand.ok
              ? `Runs as: ${parsedCheckCommand.argv.map((arg, index) => `${index + 1}. ${arg}`).join("   ")}`
              : parsedCheckCommand.error}
        </p>
      </div>

        <ConsoleCard title="Run retention" anchor="workflows/retention">
          <p className="settings-hint">
            Active, waiting, blocked, failed, orphaned and delivery-uncertain work is never
            age-pruned. Completed and cancelled runs go through the two stages below.
          </p>
          <div className="wf-settings-retention-grid">
            {RETENTION_FIELDS.map((field) => (
              <Tooltip key={field.key} label={field.hint}>
                <label>
                  <span>{field.label}</span>
                  <input
                    type="number"
                    min={field.min}
                    max={field.max}
                    value={retention[field.key]}
                    disabled={!config || busy}
                    onChange={(event) => setRetention((draft) => ({
                      ...draft,
                      [field.key]: event.target.value,
                    }))}
                  />
                </label>
              </Tooltip>
            ))}
          </div>
          {/* Sized to its label. A `.sc-card-body` is a flex column, so a bare button
              stretches the full width of the card and reads as the panel's primary action
              rather than as this card's Save. */}
          <div className="wf-settings-apply">
            <Tooltip label="Save these retention limits - shortening one asks first">
              <button className="btn" disabled={!config || busy} onClick={applyRetention}>
                Apply retention
              </button>
            </Tooltip>
          </div>

          {/* What the limits above are measured AGAINST. The panel set three of them and
              showed no measurement of the thing being limited; the only related number on
              the page was "Retained runs", under Health, which is `COUNT(*)` over every run
              row of any status and so cannot be read against `maxCompletedRuns` at all.
              `completedRunCount` is the population that limit actually ranks - finished,
              with a completion time, not pinned by an uncertain delivery - so this is a
              like-for-like reading rather than a ratio of two different questions. */}
          <div className="wf-settings-readout">
            <p className="sc-health-row">
              <span>Finished runs ranked by this limit</span>
              <span className="sc-health-value">
                {status && config
                  ? `${status.completedRunCount} of ${config.retention.maxCompletedRuns}`
                  : "unknown"}
              </span>
            </p>
            <p className="sc-health-row">
              <span>Last sweep removed</span>
              {/* Guarded on whether a sweep has ever run, rather than printing the zeros a
                  never-swept daemon carries: "0 compacted, 0 deleted" is a reading, and a
                  daemon that has not swept has not taken one. */}
              <span className="sc-health-value">
                {!status
                  ? "unknown"
                  : status.lastRetentionAt === null
                    ? "not yet run"
                    : `${status.lastRetentionCompacted} compacted, `
                      + `${status.lastRetentionDeleted} deleted`}
              </span>
            </p>
          </div>
          <p className="settings-hint">
            Only finished runs are ranked by the newest-kept limit. Everything still working,
            waiting or failed sits outside that population and is never counted against it.
          </p>
        </ConsoleCard>

        {/* The strip sits ABOVE the health card rather than inside it: it is the escalation
            summary, and the card under it is the residue - throughput and sweep bookkeeping
            that never means "somebody must look". Grouped with it, and more tightly than the
            column's own rhythm, so the tiles read as that card's headline rather than as
            something floating between two cards. */}
        <div className="wf-settings-health-group">
          {status && (
            <ConsoleLinkStrip
              stats={workflowStripLinks(status)}
              // Withheld rather than stubbed when nothing is listening, so the tiles fall
              // back to being plain links the browser follows instead of dead ones.
              onOpen={onOpenRuns ? openTile : undefined}
            />
          )}

          <ConsoleCard title="Workflow health" anchor="workflows/health">
            <p className="settings-hint">
              Counters only, refreshed while this panel is open. No prompt, diff, transcript,
              Persona guidance, model output or delivery payload passes through here.
            </p>
            {status ? (
              <>
                <p className="sc-health-row">
                  <span>Retained runs</span>
                  <span className="sc-health-value">{status.retainedRunCount}</span>
                </p>
                <p className="sc-health-row">
                  <span>Queued Persona calls</span>
                  <span className="sc-health-value">{status.queuedPersonaCalls}</span>
                </p>
                <p className="sc-health-row">
                  <span>Running Persona calls</span>
                  <span className="sc-health-value">{status.runningPersonaCalls}</span>
                </p>
                <p className="sc-health-row">
                  <span>Last recovery</span>
                  <span className="sc-health-value">
                    {status.lastRecoveryAt
                      ? new Date(status.lastRecoveryAt).toLocaleString()
                      : "Not yet run"}
                  </span>
                </p>
                <p className="sc-health-row">
                  <span>Last retention sweep</span>
                  <span className="sc-health-value">
                    {status.lastRetentionAt
                      ? new Date(status.lastRetentionAt).toLocaleString()
                      : "Not yet run"}
                  </span>
                </p>
                <p className="sc-health-row">
                  <span>Last sweep error</span>
                  <span
                    className={`sc-health-value${status.lastRetentionError ? " sc-health-bad" : ""}`}
                  >
                    {status.lastRetentionError ?? "None"}
                  </span>
                </p>
              </>
            ) : (
              // "has not answered", not "has not answered YET": a null status is the pre-poll
              // instant AND a daemon that has stopped answering, and the second is the one
              // where a still-loading sentence would be read as a delay rather than a gap.
              <p className="settings-hint wf-settings-empty">
                Workflow health is unavailable - the daemon has not answered.
              </p>
            )}
          </ConsoleCard>
        </div>
      </div>

      {(localError ?? error) && (
        <p className="settings-error" role="alert">{localError ?? error}</p>
      )}

      {confirm && (
        <WorkflowConfirmModal request={confirm} onClose={() => setConfirm(null)} />
      )}
    </section>
  );
}
