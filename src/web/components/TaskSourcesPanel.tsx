import { useEffect, useRef, useState } from "react";
import {
  AGENT_TYPES,
  type AgentType,
  type TaskKind,
  type TaskPriority,
} from "@shared/types.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import {
  BACKLOG_TASK_KINDS,
  PRIORITY_LABELS,
  TASK_KIND_INFO,
  TASK_PRIORITIES,
} from "@shared/task.ts";
import {
  DEFAULT_SWEEP_INTERVAL_MS,
  DEFAULT_MAX_PER_SWEEP,
  GithubIssuesConfigSchema,
  JiraConfigSchema,
  MAX_SWEEP_INTERVAL_MS,
  MIN_SWEEP_INTERVAL_MS,
  TASK_SOURCE_KIND_INFO,
  type GithubIssuesConfig,
  type JiraConfig,
  type TaskSourceInstance,
  type TaskSourceKind,
  type TaskSourceStatus,
} from "@shared/task-source.ts";
import type { TaskSourcesState } from "../useTaskSources.ts";
import { fetchRepos, resolveRepo } from "../lib/api.ts";
import { repoLeaf } from "../lib/format.ts";
import { RepoCombobox } from "./RepoCombobox.tsx";
import { ago } from "./InspectorSettingsPanel.tsx";
import { Tooltip } from "./Tooltip.tsx";

// The Task sources settings category: what pulls work INTO the backlog from systems that
// already hold it.
//
// The copy here carries one claim the controls cannot: what a SWEEP does is file backlog
// rows and nothing else. It never dispatches an agent, never cuts a worktree and never types
// into a pane, which is what makes turning one on a much smaller decision than turning on the
// Inspector or Shipping. Said out loud, because "a background thing that watches GitHub
// and creates work" reads as far more alarming than it is.
//
// The claim is about the sweep rather than about the source because there is now one outward
// verb too: a backlog task can be filed upstream as an issue from its own editor. That does
// not weaken anything said above - it is per-task, it is a click a human makes, and it never
// runs from the loop this panel switches on - but it does mean the copy cannot say a source
// only ever reads. What it can say, and what matters for the consent this panel is asking
// for, is that nothing here is unattended except the sweep.

/** A source with no label of its own still needs something to be called. */
function nameOf(src: TaskSourceInstance, kindLabel: string): string {
  return src.label.trim() || kindLabel;
}

/** Minutes, for a field a human types into. The stored value is ms and clamped server-side. */
function minutesOf(ms: number): number {
  return Math.round(ms / 60_000);
}

/** The github config as this build understands it, with defaults filled in. */
function githubConfigOf(src: TaskSourceInstance): GithubIssuesConfig {
  const parsed = GithubIssuesConfigSchema.safeParse(src.config ?? {});
  // A blob this build cannot read still has to render SOMETHING to edit, and the schema's
  // own defaults are the only honest answer - the alternative is a blank panel over a
  // stored config that goes on sweeping with settings nobody can see.
  return parsed.success ? parsed.data : GithubIssuesConfigSchema.parse({});
}

/** The jira config as this build understands it, on the same terms. */
function jiraConfigOf(src: TaskSourceInstance): JiraConfig {
  const parsed = JiraConfigSchema.safeParse(src.config ?? {});
  return parsed.success ? parsed.data : JiraConfigSchema.parse({});
}

/**
 * Text fields that commit on blur rather than per keystroke.
 *
 * Every change here is a PUT, and a PUT per character would both hammer the daemon and let
 * the 4s poll snap a half-typed value back under the cursor. One hook rather than a copy
 * per field group, so a new kind's fields cannot accidentally commit on a different beat.
 */
function useDraftText(): {
  /** The draft for this key, else what is stored. */
  val: (key: string, stored: string) => string;
  edit: (key: string, v: string) => void;
  /** Hand the draft to `apply` and forget it. A key never edited applies nothing. */
  commit: (key: string, apply: (v: string) => void) => void;
  /** The raw drafts, for a control that must know whether a field differs from storage. */
  draft: Record<string, string>;
} {
  const [text, setText] = useState<Record<string, string>>({});
  return {
    draft: text,
    val: (key, stored) => text[key] ?? stored,
    edit: (key, v) => setText((t) => ({ ...t, [key]: v })),
    commit: (key, apply) => {
      const v = text[key];
      setText((t) => {
        const next = { ...t };
        delete next[key];
        return next;
      });
      if (v !== undefined) apply(v);
    },
  };
}

/** Comma-separated, the way every label field in this app takes them. */
function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * What one source's last sweep says about itself, in one line.
 *
 * "No current sweep" and "swept, found nothing" are deliberately different states. A null
 * timestamp also follows a pause that invalidated older health, so it means the source has
 * not swept in its current lifecycle, not necessarily that it has never swept in process
 * history. The concise UI still calls that "Never swept" to distinguish it from an empty
 * successful result.
 */
function statusLine(status: TaskSourceStatus | undefined, now: number): string {
  if (!status) return "No status yet.";
  if (status.sweeping) return "Sweeping now…";
  if (status.lastSweepAt === null) return "Never swept yet.";
  const filed =
    status.lastFiled === 0 ? "filed nothing new" : `filed ${status.lastFiled} task(s)`;
  return `Last swept ${ago(status.lastSweepAt, now)} - ${filed}.`;
}

/** One editable mapping row: a GitHub label, and the priority it should confer. */
function PriorityRow({
  label,
  priority,
  onChange,
  onRemove,
}: {
  label: string;
  priority: TaskPriority;
  onChange: (label: string, priority: TaskPriority) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className="ts-prio-row">
      <input
        className="field-input mono"
        value={draft ?? label}
        aria-label="GitHub label"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = (draft ?? label).trim();
          setDraft(null);
          if (next && next !== label) onChange(next, priority);
        }}
      />
      <Tooltip label={`Priority given to an issue carrying the "${label}" label`}>
        <select
          className="harnesses-select"
          value={priority}
          aria-label={`Priority for the ${label} label`}
          onChange={(e) => onChange(label, e.target.value as TaskPriority)}
        >
          {TASK_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
      </Tooltip>
      <Tooltip label={`Stop mapping the "${label}" label to a priority`}>
        <button className="foreman-repo-remove" onClick={onRemove} aria-label={`Stop mapping ${label}`}>
          ✕
        </button>
      </Tooltip>
    </div>
  );
}

/** The kind-specific half of a github-issues source. */
function GithubFields({
  cfg,
  onChange,
}: {
  cfg: GithubIssuesConfig;
  onChange: (next: GithubIssuesConfig) => void;
}): React.JSX.Element {
  const { val, edit, commit } = useDraftText();

  // Three mutually exclusive answers to one question, so they are one radio group rather
  // than two checkboxes. As checkboxes the pair that selects NOTHING is reachable, and
  // the schema refuses it - which would mean a panel that lets you build a config it then
  // rejects, with the explanation arriving as a validation error.
  const assignee = cfg.assignedToMe ? "me" : cfg.unassignedOnly ? "nobody" : "any";

  return (
    <div className="ts-fields">
      <label className="ts-field">
        <span className="ts-field-label">Repository (optional)</span>
        <input
          className="field-input mono"
          placeholder="owner/repo - blank uses the checkout's origin"
          value={val("repo", cfg.repo)}
          onChange={(e) => edit("repo", e.target.value)}
          onBlur={() => commit("repo", (v) => onChange({ ...cfg, repo: v.trim() }))}
        />
      </label>

      <label className="ts-field">
        <span className="ts-field-label">Labels (any of)</span>
        <input
          className="field-input mono"
          placeholder="bug, good first issue"
          value={val("labelsAny", cfg.labelsAny.join(", "))}
          onChange={(e) => edit("labelsAny", e.target.value)}
          onBlur={() =>
            commit("labelsAny", (v) => onChange({ ...cfg, labelsAny: splitList(v) }))
          }
        />
      </label>

      <label className="ts-field">
        <span className="ts-field-label">Milestone (optional)</span>
        <input
          className="field-input mono"
          value={val("milestone", cfg.milestone ?? "")}
          onChange={(e) => edit("milestone", e.target.value)}
          onBlur={() =>
            commit("milestone", (v) => onChange({ ...cfg, milestone: v.trim() || null }))
          }
        />
      </label>

      <label className="ts-field">
        <span className="ts-field-label">Issues per sweep</span>
        <input
          className="field-input"
          type="number"
          min={1}
          max={200}
          value={cfg.limit}
          onChange={(e) => onChange({ ...cfg, limit: Number(e.target.value) || cfg.limit })}
        />
      </label>

      <fieldset className="ts-radios">
        <legend>Assignee</legend>
        {(
          [
            ["any", "Anyone - every open issue the filters match"],
            ["me", "Assigned to me"],
            ["nobody", "Unassigned - the up-for-grabs sweep"],
          ] as const
        ).map(([value, text]) => (
          <label className="alert-row" key={value}>
            <Tooltip label={`Sweep issues: ${text}`}>
              <input
                type="radio"
                name="ts-assignee"
                checked={assignee === value}
                onChange={() =>
                  onChange({
                    ...cfg,
                    assignedToMe: value === "me",
                    unassignedOnly: value === "nobody",
                  })
                }
              />
            </Tooltip>
            <span>{text}</span>
          </label>
        ))}
      </fieldset>

      <label className="alert-row ts-check">
        <Tooltip label="Carry each issue's GitHub labels across onto the task this files">
          <input
            type="checkbox"
            checked={cfg.copyLabels}
            onChange={(e) => onChange({ ...cfg, copyLabels: e.target.checked })}
          />
        </Tooltip>
        <span>Copy the issue's GitHub labels onto the task</span>
      </label>

      <div className="ts-prios">
        <p className="settings-group-label">Priority from a label</p>
        <p className="settings-hint">
          The first of these an issue carries decides its priority. An issue carrying none
          takes the source's default below.
        </p>
        {Object.entries(cfg.priorityFrom).map(([label, priority]) => (
          <PriorityRow
            key={label}
            label={label}
            priority={priority}
            onChange={(nextLabel, nextPriority) => {
              const map = { ...cfg.priorityFrom };
              delete map[label];
              map[nextLabel] = nextPriority;
              onChange({ ...cfg, priorityFrom: map });
            }}
            onRemove={() => {
              const map = { ...cfg.priorityFrom };
              delete map[label];
              onChange({ ...cfg, priorityFrom: map });
            }}
          />
        ))}
        <div className="ts-prio-row">
          <input
            className="field-input mono"
            placeholder="a GitHub label, e.g. P0"
            aria-label="Add a label to map"
            value={val("newPrio", "")}
            onChange={(e) => edit("newPrio", e.target.value)}
            onBlur={() =>
              commit("newPrio", (v) => {
                const label = v.trim();
                if (!label || cfg.priorityFrom[label]) return;
                onChange({ ...cfg, priorityFrom: { ...cfg.priorityFrom, [label]: "high" } });
              })
            }
          />
          <span className="settings-hint ts-prio-hint">added as High - change it after</span>
        </div>
      </div>
    </div>
  );
}

/**
 * The kind-specific half of a jira source.
 *
 * The site, query path, and filter carry the whole configuration because everything
 * else a Jira query needs is already IN the JQL, and re-expressing project/status/assignee
 * as controls beside it would give two places to say one thing. The credential is
 * deliberately not here: it is either the operator's `jira` CLI / environment credential or
 * UpstartClaw's existing interactive authentication, so this panel stores no secret.
 */
function JiraFields({
  cfg,
  onChange,
}: {
  cfg: JiraConfig;
  onChange: (next: JiraConfig) => void;
}): React.JSX.Element {
  const { val, edit, commit } = useDraftText();

  return (
    <div className="ts-fields">
      <label className="ts-field">
        <span className="ts-field-label">Jira site</span>
        <input
          className="field-input mono"
          placeholder="your-org.atlassian.net"
          value={val("site", cfg.site)}
          onChange={(e) => edit("site", e.target.value)}
          onBlur={() => commit("site", (v) => onChange({ ...cfg, site: v.trim() }))}
        />
      </label>

      <label className="ts-field">
        {/* PAGE size, not a per-sweep cap: a sweep walks pages until the filter is exhausted,
            because a filter read only as its first page can never reach its own tail. What is
            actually FILED is bounded by "Most tasks per sweep" above. */}
        <span className="ts-field-label">Issues per page</span>
        <Tooltip label="How many issues one request asks Jira for. A sweep keeps asking until the filter is exhausted, so this is a request size rather than a limit on what it finds">
          <input
            className="field-input"
            type="number"
            min={1}
            max={200}
            value={cfg.limit}
            onChange={(e) => onChange({ ...cfg, limit: Number(e.target.value) || cfg.limit })}
          />
        </Tooltip>
      </label>

      <label className="ts-field ts-field-wide">
        <span className="ts-field-label">Query via</span>
        <Tooltip label="Choose whether Jira queries use local Jira credentials or the UpstartClaw Claude skill">
          <select
            className="field-input"
            aria-label="How Jira queries are authenticated"
            value={cfg.queryVia}
            onChange={(e) =>
              onChange({ ...cfg, queryVia: e.target.value as JiraConfig["queryVia"] })
            }
          >
            <option value="local">Jira CLI or API token</option>
            <option value="upstartclaw">UpstartClaw Claude skill</option>
          </select>
        </Tooltip>
      </label>

      {cfg.queryVia === "upstartclaw" && (
        <p className="settings-warn ts-upstartclaw-note">
          UpstartClaw runs unattended with your Claude user settings. User-level Claude hooks can
          run on every check and scheduled sweep.
        </p>
      )}

      {/* Last of the inputs rather than second, though it is the most important one: it spans
          the row, so anything after it leaves a half-empty row above - and here it sits
          directly over the warning and the priority switch, which are both about it. */}
      <label className="ts-field ts-field-wide">
        <span className="ts-field-label">JQL filter</span>
        <input
          className="field-input mono"
          placeholder='project = MC AND status = "To Do" ORDER BY created DESC'
          value={val("jql", cfg.jql)}
          onChange={(e) => edit("jql", e.target.value)}
          onBlur={() => commit("jql", (v) => onChange({ ...cfg, jql: v.trim() }))}
        />
      </label>

      <label className="alert-row ts-check">
        <Tooltip label="Take the task's priority from the issue's own Jira priority - Highest and P0 become Blocker, High becomes High, and so on. A name this build doesn't recognise leaves the source's default in place">
          <input
            type="checkbox"
            checked={cfg.priorityFromJira}
            onChange={(e) => onChange({ ...cfg, priorityFromJira: e.target.checked })}
          />
        </Tooltip>
        <span>Take each task's priority from the Jira issue's own</span>
      </label>

      {/* Said here rather than left to the first sweep: an empty filter is a storable
          config that files nothing, which is exactly what a healthy quiet source looks
          like. "Check it works" says the same thing, and this says it before you ask. */}
      {!cfg.jql.trim() && (
        <p className="settings-warn ts-no-jql">
          Without a JQL filter this source sweeps nothing. Paste the query from Jira's
          search bar - <strong>Check it works</strong> below runs it against one issue.
        </p>
      )}
    </div>
  );
}

/** One configured source's editor. The overview chooses which source reaches this surface. */
export function SourceCard({
  src,
  kindLabel,
  status,
  repos,
  now,
  onChange,
  onRemove,
  state,
}: {
  src: TaskSourceInstance;
  kindLabel: string;
  status: TaskSourceStatus | undefined;
  repos: string[];
  now: number;
  onChange: (next: TaskSourceInstance) => void;
  onRemove: () => void;
  state: TaskSourcesState;
}): React.JSX.Element {
  const { val, edit, commit, draft } = useDraftText();
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * What the last action answered, and whether that answer was a PROBLEM.
   *
   * The tone is carried rather than inferred because these three buttons answer in three
   * different voices - a sweep report, a preflight verdict, a confirmation - and the one
   * that matters most is a preflight naming a credential to go and fix. Rendered in the same
   * dim hint colour as "Forgotten - the next sweep will file these items again", it read as
   * reassurance.
   */
  const [note, setNote] = useState<{ say: string; problem: boolean } | null>(null);

  async function run(
    what: string,
    fn: () => Promise<{ say: string; problem: boolean }>,
  ): Promise<void> {
    setBusy(what);
    setNote(null);
    const said = await fn();
    setBusy(null);
    setNote(said);
  }

  return (
    <div className="ts-card ts-editor">
      <div className="ts-head">
        <label className="skill-switch">
          <Tooltip
            label={
              src.enabled
                ? "Enabled - this source sweeps on its schedule. Click to pause it."
                : "Paused - this source never sweeps. Click to enable it."
            }
          >
            <input
              type="checkbox"
              checked={src.enabled}
              aria-label={`Sweep ${nameOf(src, kindLabel)} on a schedule`}
              onChange={(e) => onChange({ ...src, enabled: e.target.checked })}
            />
          </Tooltip>
        </label>
        <input
          className="field-input ts-name"
          placeholder={kindLabel}
          aria-label="What to call this source"
          value={val("label", src.label)}
          onChange={(e) => edit("label", e.target.value)}
          onBlur={() => commit("label", (v) => onChange({ ...src, label: v.trim().slice(0, 80) }))}
        />
        <span className="skill-badge">{kindLabel}</span>
        <Tooltip label="Remove this source">
          <button
            className="foreman-repo-remove"
            onClick={onRemove}
            aria-label={`Remove ${nameOf(src, kindLabel)}`}
          >
            ✕
          </button>
        </Tooltip>
      </div>

      <p className={`ts-status${status?.lastError ? " ts-status-failed" : ""}`}>
        {statusLine(status, now)}
        {status && status.seenCount > 0 && ` ${status.seenCount} item(s) already filed.`}
      </p>
      {status?.lastError && <p className="settings-error ts-error">{status.lastError}</p>}

      <div className="ts-fields">
        {/* A div rather than a label: the control is a combobox plus the button that
            commits it, and a label wrapping two controls names neither. The combobox has
            no blur of its own to commit on, so the button is what says "I meant that
            path" - and it stays disabled until the text actually differs from what is
            stored, so it never invites a no-op write. */}
        <div className="ts-field ts-field-wide">
          <span className="ts-field-label">Files tasks against</span>
          <div className="ts-repo-row">
            <RepoCombobox
              repos={repos}
              value={val("repoRoot", src.repoRoot)}
              onChange={(v) => edit("repoRoot", v)}
            />
            <Tooltip label="Commit this checkout as the repo swept tasks are filed against">
              <button
                className="btn"
                disabled={!draft.repoRoot?.trim() || draft.repoRoot.trim() === src.repoRoot}
                onClick={() => commit("repoRoot", (v) => onChange({ ...src, repoRoot: v.trim() }))}
              >
                Set repo
              </button>
            </Tooltip>
          </div>
        </div>

        <label className="ts-field">
          <span className="ts-field-label">Sweep every (minutes)</span>
          <input
            className="field-input"
            type="number"
            min={minutesOf(MIN_SWEEP_INTERVAL_MS)}
            max={minutesOf(MAX_SWEEP_INTERVAL_MS)}
            value={minutesOf(src.intervalMs)}
            onChange={(e) => {
              const mins = Number(e.target.value);
              if (!Number.isFinite(mins) || mins <= 0) return;
              onChange({ ...src, intervalMs: mins * 60_000 });
            }}
          />
        </label>

        <label className="ts-field">
          <span className="ts-field-label">Most tasks per sweep</span>
          <input
            className="field-input"
            type="number"
            min={1}
            max={200}
            value={src.maxPerSweep}
            onChange={(e) =>
              onChange({ ...src, maxPerSweep: Number(e.target.value) || src.maxPerSweep })
            }
          />
        </label>
      </div>

      {/* The one place a kind is named in this panel, because a field group is bespoke JSX
          and cannot come off a registry the way the label, the blurb and the preflight
          sentence do. Everything else here is kind-agnostic on purpose. */}
      {src.kind === "github-issues" && (
        <GithubFields
          cfg={githubConfigOf(src)}
          onChange={(config) => onChange({ ...src, config })}
        />
      )}
      {src.kind === "jira" && (
        <JiraFields cfg={jiraConfigOf(src)} onChange={(config) => onChange({ ...src, config })} />
      )}

      <div className="ts-defaults">
        <p className="settings-group-label">What a swept task looks like</p>
        <label className={`settings-toggle${src.defaults.enabled ? " is-on" : ""}`}>
          <Tooltip label="Set whether Foreman's backlog autopilot may automatically schedule tasks filed by this source">
            <input
              type="checkbox"
              checked={src.defaults.enabled}
              aria-label="Allow backlog autopilot to schedule swept tasks"
              onChange={(e) =>
                onChange({
                  ...src,
                  defaults: { ...src.defaults, enabled: e.target.checked },
                })
              }
            />
          </Tooltip>
          <span className="settings-toggle-text">
            <span className="settings-toggle-label">Allow backlog autopilot</span>
            <span className="settings-toggle-desc">
              On, Foreman may schedule tasks filed by this source. Off, new tasks arrive
              parked for review; you can enable or launch them manually.
            </span>
          </span>
        </label>
        <div className="ts-fields">
          <label className="ts-field">
            <span className="ts-field-label">Agent</span>
            <Tooltip label="Which harness a task swept by this source is dispatched to. Inherit follows this kind's row on Settings - Models, read as each row is filed.">
              <select
                className="harnesses-select"
                aria-label="Agent for tasks this source files"
                value={src.defaults.agent ?? ""}
                onChange={(e) =>
                  onChange({
                    ...src,
                    defaults: {
                      ...src.defaults,
                      agent: (e.target.value || null) as AgentType | null,
                    },
                  })
                }
              >
                <option value="">Inherit - this kind's agent</option>
                {AGENT_TYPES.map((a) => (
                  <option key={a} value={a}>
                    {AGENT_IDENTITY[a].label}
                  </option>
                ))}
              </select>
            </Tooltip>
          </label>

          <label className="ts-field">
            <span className="ts-field-label">Kind</span>
            <Tooltip label="What a swept task is asked to produce">
              <select
                className="harnesses-select"
                value={src.defaults.kind}
                onChange={(e) =>
                  onChange({
                    ...src,
                    defaults: { ...src.defaults, kind: e.target.value as TaskKind },
                  })
                }
              >
                {/* Off the tuple, for the reason the Recurring Mission editor's twin is:
                    these two hand-wrote their options, in two different wordings, and a
                    hand-written list silently stops offering a kind rather than failing
                    to compile when one is added. Sentence case is gone with them - the
                    labels are the lowercase words the task itself carries. */}
                {BACKLOG_TASK_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {`${TASK_KIND_INFO[kind].label} - ${TASK_KIND_INFO[kind].purpose}`}
                  </option>
                ))}
              </select>
            </Tooltip>
          </label>

          <label className="ts-field">
            <span className="ts-field-label">Priority</span>
            <Tooltip label="Priority given to a swept task that no label above matched">
              <select
                className="harnesses-select"
                value={src.defaults.priority ?? ""}
                onChange={(e) =>
                  onChange({
                    ...src,
                    defaults: {
                      ...src.defaults,
                      priority: (e.target.value || null) as TaskPriority | null,
                    },
                  })
                }
              >
                <option value="">Unset</option>
                {TASK_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABELS[p]}
                  </option>
                ))}
              </select>
            </Tooltip>
          </label>

          <label className="ts-field ts-field-wide">
            <span className="ts-field-label">Labels on every swept task</span>
            <input
              className="field-input mono"
              placeholder="swept, triage"
              value={val("labels", src.defaults.labels.join(", "))}
              onChange={(e) => edit("labels", e.target.value)}
              onBlur={() =>
                commit("labels", (v) =>
                  onChange({ ...src, defaults: { ...src.defaults, labels: splitList(v) } }),
                )
              }
            />
          </label>
        </div>
      </div>

      <div className="ts-actions">
        <Tooltip label="Run this source's sweep right now, without waiting for its schedule">
          <button
            className="btn"
            disabled={busy !== null || status?.sweeping}
            onClick={() =>
              void run("sweep", async () => {
                const r = await state.sweep(src.id);
                if (!r) return { say: "The sweep could not run.", problem: true };
                if (r.error) return { say: r.error, problem: true };
                const bits = [`filed ${r.filed}`, `${r.alreadySeen} already filed`];
                if (r.overCap > 0) bits.push(`${r.overCap} left for the next sweep`);
                if (r.refused.length > 0) bits.push(`${r.refused.length} refused`);
                // A refusal is a problem even though the sweep itself worked: those rows
                // were not filed, and nothing else on this card says so.
                return { say: `Swept: ${bits.join(", ")}.`, problem: r.refused.length > 0 };
              })
            }
          >
            {busy === "sweep" ? "Sweeping…" : "Sweep now"}
          </button>
        </Tooltip>
        <Tooltip label="Check this source's upstream is reachable and its filters return something">
          <button
            className="btn"
            disabled={busy !== null}
            onClick={() =>
              void run("preflight", async () => {
                const problem = await state.preflight(src.id);
                // The success sentence comes off the KIND, because what was proved differs
                // per upstream: this used to name `gh` and the repo's issues, which a Jira
                // source would have claimed while never going near either.
                return problem === null
                  ? { say: TASK_SOURCE_KIND_INFO[src.kind].preflightOk, problem: false }
                  : { say: problem, problem: true };
              })
            }
          >
            {busy === "preflight" ? "Checking…" : "Check it works"}
          </button>
        </Tooltip>
        <Tooltip label="Everything this source has filed becomes fileable again">
          <button
            className="btn"
            disabled={busy !== null || (status?.seenCount ?? 0) === 0}
            onClick={() =>
              void run("forget", async () => {
                await state.forget(src.id);
                return {
                  say: "Forgotten - the next sweep will file these items again.",
                  problem: false,
                };
              })
            }
          >
            {busy === "forget" ? "Forgetting…" : "Forget seen items"}
          </button>
        </Tooltip>
      </div>
      {/* What one of those three buttons just answered, BELOW them - because the card is
          taller than the pane and the buttons are at the bottom of it, so a note at the top
          put the answer off screen above the question. That is worst for the one sentence
          that has to be read: preflight naming the credential to go and fix. `lastError`
          stays up with the status line, since that is health rather than an answer. */}
      {note && (
        <p className={`${note.problem ? "settings-error" : "settings-hint"} ts-note`}>{note.say}</p>
      )}
    </div>
  );
}

type SourceFilter = "all" | "healthy" | "attention" | "pending" | "paused";
type SourceHealth = Exclude<SourceFilter, "all">;

function sourceHealth(src: TaskSourceInstance, status: TaskSourceStatus | undefined): SourceHealth {
  if (!src.enabled) return "paused";
  if (status?.lastError) return "attention";
  if (!status || status.lastSweepAt === null) return "pending";
  return "healthy";
}

interface SourceDirectoryFilters {
  health: SourceFilter;
  query: string;
  kind: TaskSourceKind | "all";
}

/**
 * How many sources are in each health, for the metrics strip and the filter chips.
 *
 * One function because the two read the same four numbers and sit a few pixels apart: a
 * strip saying "1 needs attention" over a chip saying "Attention 0" is the kind of
 * disagreement nobody reports and everybody distrusts.
 */
function healthCounts(
  sources: TaskSourceInstance[],
  statuses: Map<string, TaskSourceStatus>,
): Record<SourceHealth, number> {
  return sources.reduce(
    (all, src) => {
      all[sourceHealth(src, statuses.get(src.id))] += 1;
      return all;
    },
    { healthy: 0, attention: 0, pending: 0, paused: 0 },
  );
}

/** Status rows by source id - the join every health question needs. */
function statusesById(statuses: TaskSourceStatus[]): Map<string, TaskSourceStatus> {
  return new Map(statuses.map((s) => [s.sourceId, s]));
}

function SourceDirectory({
  sources,
  kinds,
  statuses,
  filters,
  selectedId,
  onFiltersChange,
  restoreFocusId,
  onFocusRestored,
  onSelect,
}: {
  sources: TaskSourceInstance[];
  kinds: { kind: TaskSourceKind; label: string; blurb: string }[];
  statuses: TaskSourceStatus[];
  filters: SourceDirectoryFilters;
  /** Which source the editor beside this list is showing, so the row can say it is the one. */
  selectedId: string | null;
  onFiltersChange: (filters: SourceDirectoryFilters) => void;
  restoreFocusId: string | null;
  onFocusRestored: () => void;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const directoryRef = useRef<HTMLDivElement>(null);
  const byId = statusesById(statuses);
  const counts = healthCounts(sources, byId);
  const needle = filters.query.trim().toLowerCase();
  const visible = sources.filter((src) => {
    const status = byId.get(src.id);
    const label = kinds.find((k) => k.kind === src.kind)?.label ?? src.kind;
    const matchesFilter = filters.health === "all" || sourceHealth(src, status) === filters.health;
    const matchesKind = filters.kind === "all" || src.kind === filters.kind;
    const haystack = `${nameOf(src, label)} ${label} ${src.repoRoot}`.toLowerCase();
    return matchesFilter && matchesKind && (!needle || haystack.includes(needle));
  });

  useEffect(() => {
    if (!restoreFocusId) return;
    const row = rowRefs.current.get(restoreFocusId);
    if (row) row.focus();
    else directoryRef.current?.focus();
    onFocusRestored();
  }, [onFocusRestored, restoreFocusId]);

  return (
    <>
      <div className="ts-directory-tools">
        <input
          className="field-input"
          value={filters.query}
          placeholder="Search sources, repositories or types…"
          aria-label="Search task sources"
          onChange={(e) => onFiltersChange({ ...filters, query: e.target.value })}
        />
        <Tooltip label="Show only sources of one type">
          <select className="harnesses-select" value={filters.kind} aria-label="Filter task sources by type" onChange={(e) => onFiltersChange({ ...filters, kind: e.target.value as TaskSourceKind | "all" })}>
            <option value="all">All types</option>
            {kinds.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
          </select>
        </Tooltip>
      </div>
      <div className="ts-filters" aria-label="Filter task sources by health">
        {([
          ["all", `All ${sources.length}`, "Show every configured source"],
          ["healthy", `Healthy ${counts.healthy}`, "Show only sources whose last sweep succeeded"],
          ["attention", `Attention ${counts.attention}`, "Show only sources whose last sweep failed"],
          ["pending", `Pending ${counts.pending}`, "Show only sources that have never swept"],
          ["paused", `Paused ${counts.paused}`, "Show only sources that are switched off"],
        ] as const).map(([id, label, hint]) => (
          <Tooltip key={id} label={hint}>
            <button
              className={filters.health === id ? "is-active" : ""}
              aria-pressed={filters.health === id}
              onClick={() => onFiltersChange({ ...filters, health: id })}
            >
              {label}
            </button>
          </Tooltip>
        ))}
      </div>

      <div ref={directoryRef} className="ts-directory" role="list" aria-label="Configured task sources" tabIndex={-1}>
        {visible.map((src) => {
          const status = byId.get(src.id);
          const kindLabel = kinds.find((k) => k.kind === src.kind)?.label ?? src.kind;
          const health = sourceHealth(src, status);
          const healthText = health === "attention" ? "Failed" : health === "paused" ? "Paused" : status?.sweeping ? "Sweeping" : health === "pending" ? status ? "Never swept" : "No status" : "Healthy";
          return (
            <div className="ts-directory-item" role="listitem" key={src.id}>
              <Tooltip
                label={`Open ${nameOf(src, kindLabel)} - ${healthText.toLowerCase()} - ${src.repoRoot}`}
              >
                <button
                  ref={(node) => {
                    if (node) rowRefs.current.set(src.id, node);
                    else rowRefs.current.delete(src.id);
                  }}
                  className={`ts-directory-row${selectedId === src.id ? " is-active" : ""}`}
                  // The editor beside this list shows what the row names, so the row is
                  // "current" rather than "selected": one of a set of destinations, the
                  // way a nav item is, not a checkbox.
                  aria-current={selectedId === src.id}
                  onClick={() => onSelect(src.id)}
                >
                  <span className="ts-directory-main"><strong>{nameOf(src, kindLabel)}</strong><span>{kindLabel} · {repoLeaf(src.repoRoot)} · every {minutesOf(src.intervalMs)} min</span></span>
                  <span className={`ts-health ts-health-${health}`}><i />{healthText}</span>
                </button>
              </Tooltip>
            </div>
          );
        })}
        {visible.length === 0 && <p className="ts-directory-empty">No sources match these filters.</p>}
      </div>
    </>
  );
}

export function TaskSourcesPanel({ state }: { state: TaskSourcesState }): React.JSX.Element {
  const { view, save, error } = state;
  const [repos, setRepos] = useState<string[]>([]);
  const [draftRepo, setDraftRepo] = useState("");
  const [draftKind, setDraftKind] = useState<TaskSourceKind | "">("");
  const [adding, setAdding] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [restoreFocusId, setRestoreFocusId] = useState<string | null>(null);
  const [directoryFilters, setDirectoryFilters] = useState<SourceDirectoryFilters>({
    health: "all",
    query: "",
    kind: "all",
  });

  useEffect(() => {
    void fetchRepos().then(setRepos);
  }, []);

  const sources = view?.sources ?? [];
  const kinds = view?.kinds ?? [];
  // Same stale-closure guard as the Foreman panel's: `add` does a server round-trip while
  // the view polls underneath it, so the write must extend whatever is in force when it
  // lands rather than what was on screen when the button was clicked.
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const now = Date.now();
  const kind = draftKind || kinds[0]?.kind;
  const counts = healthCounts(sources, statusesById(view?.status ?? []));

  function replace(next: TaskSourceInstance): void {
    void save(sourcesRef.current.map((s) => (s.id === next.id ? next : s)));
  }

  function remove(id: string): void {
    void save(sourcesRef.current.filter((s) => s.id !== id));
  }

  async function add(): Promise<void> {
    const path = draftRepo.trim();
    if (!path || !kind || adding || !view) return;
    setAdding(true);
    setAddError(null);
    // Resolved before the source is minted, so a typo cannot enter a config that would
    // then be refused wholesale on every later edit to any OTHER source in the list.
    const res = await resolveRepo(path);
    setAdding(false);
    if (!res.ok) {
      setAddError(res.error);
      return;
    }
    setDraftRepo("");
    const added: TaskSourceInstance = {
      id: crypto.randomUUID(),
      kind,
      label: "",
      // Off, always. Adding a source is configuration; turning it on is consent.
      enabled: false,
      repoRoot: res.repoRoot,
      intervalMs: DEFAULT_SWEEP_INTERVAL_MS,
      defaults: {
        kind: "ship",
        // Inherit, not Claude. A source the operator never opened a picker on has not chosen
        // a harness, and saying otherwise is what kept the kind default from reaching here.
        agent: null,
        priority: null,
        labels: [],
        // Parked, matching the schema's own default: what a sweep files is a machine's
        // guess at work, and reviewing it is a separate act from filing it.
        enabled: false,
      },
      maxPerSweep: DEFAULT_MAX_PER_SWEEP,
      config: {},
    };
    const saved = await save([...sourcesRef.current, added]);
    if (saved) {
      setShowAdd(false);
      // Straight into the editor beside the list: what you just added is off, unlabelled
      // and pointed at a repo, and the next thing anyone does is configure it.
      setSelectedId(added.id);
    }
  }

  // The source under the editor went away - removed here, or by another tab between two
  // polls. Drop the selection and hand focus back to the list rather than leaving it on a
  // button that no longer exists (`restoreFocusId` falls through to the list container
  // when the row it names has gone).
  useEffect(() => {
    if (selectedId && !sources.some((s) => s.id === selectedId)) {
      setSelectedId(null);
      setRestoreFocusId(selectedId);
    }
  }, [selectedId, sources]);

  // Master-detail always has a detail: with sources configured and nothing selected, show
  // the first one rather than an empty pane beside a full list.
  useEffect(() => {
    const first = sources[0];
    if (selectedId === null && first) setSelectedId(first.id);
  }, [selectedId, sources]);

  const selected = selectedId ? sources.find((s) => s.id === selectedId) : undefined;

  return (
    // Anchored at the section, not only at the controls inside it: everything below is
    // conditional on the daemon having answered, and a search hit for "task sources" has
    // to land somewhere even when it hasn't.
    <section className="settings-section ts-panel" data-anchor="task-sources/sources">
      <p className="settings-hint settings-blurb">
        Pulls work <strong>into</strong> the backlog from systems that already hold it. A
        sweep files backlog tasks and nothing else: <strong>it never dispatches an agent,
        never cuts a worktree and never types into a session</strong>. What it files is a
        list you read and delete from, and a task you delete stays deleted. Work goes the
        other way only when you send it: <strong>Create GitHub issue</strong>, in a backlog
        task's own editor, files that one task upstream and links it here.
      </p>
      {/* The daemon has not answered. Said out loud rather than drawing an empty list,
          which is indistinguishable from "no sources are configured" - and would tell an
          operator nothing is being swept while the stored config sweeps on. */}
      {!view && (
        <p className="settings-warn ts-unknown">
          Can't reach the daemon, so which sources are configured is unknown. This is not
          an empty list.
        </p>
      )}

      {error && <p className="settings-error">{error}</p>}

      {view && (
        <>
          <div className="ts-overview" aria-label="Task source overview">
            <div className="ts-metric"><strong>{sources.length}</strong><span>configured sources</span></div>
            <div className="ts-metric"><strong className="ts-good">{counts.healthy}</strong><span>running normally</span></div>
            <div className="ts-metric"><strong className={counts.attention > 0 ? "ts-attention" : "ts-good"}>{counts.attention}</strong><span>need attention</span></div>
            <div className="ts-metric"><strong>{counts.pending}</strong><span>awaiting first sweep</span></div>
          </div>
          {counts.attention > 0 && (
            <p className="ts-attention-callout">
              <strong>Attention:</strong> {counts.attention} source{counts.attention === 1 ? "" : "s"} had a failed sweep. Filter to review and repair {counts.attention === 1 ? "it" : "them"}.
            </p>
          )}

          {/* Master-detail at page width, which is what the modal could not give this
              category: the directory and the source you are editing are on screen at once,
              so comparing two sources - or fixing the one that failed while the healthy
              ones stay visible - is a glance rather than a back-and-forth. */}
          <div className="ts-master-detail">
            <div className="ts-list-col" data-anchor="task-sources/directory">
              <div className="settings-section-head ts-list-head">
                <h3>Configured <span className="ts-count">· {sources.length}</span></h3>
                <Tooltip label={showAdd ? "Close the add form" : "Configure a new upstream to pull work from into the backlog"}>
                  <button className="btn" aria-expanded={showAdd} onClick={() => setShowAdd((v) => !v)}>
                    {showAdd ? "Cancel" : "+ Add source"}
                  </button>
                </Tooltip>
              </div>

              {/* Inline, above the list it will join, rather than a screen of its own: the
                  add form is three fields, and replacing the whole category with it lost
                  sight of what is already configured while you typed. */}
              {showAdd && (
                <div className="ts-add" data-anchor="task-sources/add">
                  {kinds.length > 0 && (
                    <p className="settings-hint">{kinds.find((k) => k.kind === kind)?.blurb}</p>
                  )}
                  <div className="foreman-repo-add">
                    <Tooltip label="Which upstream this new source pulls work from">
                      <select
                        className="harnesses-select"
                        value={kind ?? ""}
                        aria-label="What kind of source to add"
                        onChange={(e) => setDraftKind(e.target.value as TaskSourceKind)}
                      >
                        {kinds.map((k) => (
                          <option key={k.kind} value={k.kind}>
                            {k.label}
                          </option>
                        ))}
                      </select>
                    </Tooltip>
                    <RepoCombobox
                      repos={repos}
                      value={draftRepo}
                      onChange={(v) => {
                        setDraftRepo(v);
                        setAddError(null);
                      }}
                    />
                    <Tooltip
                      label={
                        !draftRepo.trim()
                          ? "Pick the checkout this source files tasks against"
                          : "Add this source - it starts switched off"
                      }
                    >
                      <button className="btn" disabled={!draftRepo.trim() || adding} onClick={() => void add()}>
                        {adding ? "Adding…" : "Add"}
                      </button>
                    </Tooltip>
                  </div>
                  {addError && <p className="settings-error">{addError}</p>}
                </div>
              )}

              <SourceDirectory
                sources={sources}
                kinds={kinds}
                statuses={view.status}
                filters={directoryFilters}
                selectedId={selectedId}
                onFiltersChange={setDirectoryFilters}
                restoreFocusId={restoreFocusId}
                onFocusRestored={() => setRestoreFocusId(null)}
                onSelect={setSelectedId}
              />
            </div>

            <div className="ts-detail-col" data-anchor="task-sources/editor">
              {selected ? (
                <SourceCard
                  src={selected}
                  kindLabel={kinds.find((k) => k.kind === selected.kind)?.label ?? selected.kind}
                  status={view.status.find((s) => s.sourceId === selected.id)}
                  repos={repos}
                  now={now}
                  onChange={replace}
                  onRemove={() => remove(selected.id)}
                  state={state}
                />
              ) : (
                <p className="settings-hint ts-empty">
                  {sources.length === 0
                    ? "No sources yet - nothing is being swept. Add one; it starts switched off."
                    : "Select a source on the left to configure it."}
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
