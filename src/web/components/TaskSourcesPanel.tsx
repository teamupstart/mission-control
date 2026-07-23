import { useEffect, useRef, useState } from "react";
import { AGENT_TYPES, type AgentType, type TaskKind, type TaskPriority } from "@shared/types.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { PRIORITY_LABELS, TASK_PRIORITIES } from "@shared/task.ts";
import {
  DEFAULT_SWEEP_INTERVAL_MS,
  DEFAULT_MAX_PER_SWEEP,
  GithubIssuesConfigSchema,
  MAX_SWEEP_INTERVAL_MS,
  MIN_SWEEP_INTERVAL_MS,
  type GithubIssuesConfig,
  type TaskSourceInstance,
  type TaskSourceKind,
  type TaskSourceStatus,
} from "@shared/task-source.ts";
import type { TaskSourcesState } from "../useTaskSources.ts";
import { fetchRepos, resolveRepo } from "../lib/api.ts";
import { RepoCombobox } from "./RepoCombobox.tsx";
import { ago } from "./InspectorSettingsPanel.tsx";
import { Tooltip } from "./Tooltip.tsx";

// The Task sources settings category: what pulls work INTO the backlog from systems that
// already hold it.
//
// The copy here carries one claim the controls cannot: a source files backlog rows and
// NOTHING else. It never dispatches an agent, never cuts a worktree and never types into
// a pane, which is what makes turning one on a much smaller decision than turning on the
// Inspector or Shipping. Said out loud, because "a background thing that watches GitHub
// and creates work" reads as far more alarming than it is.

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
  // Text fields commit on blur, not per keystroke: every change is a PUT, and a PUT per
  // character would both hammer the daemon and let the 4s poll snap a half-typed value
  // back under the cursor.
  const [text, setText] = useState<Record<string, string>>({});
  const val = (key: string, stored: string): string => text[key] ?? stored;
  const edit = (key: string, v: string): void => setText((t) => ({ ...t, [key]: v }));
  const commit = (key: string, apply: (v: string) => void): void => {
    const v = text[key];
    setText((t) => {
      const next = { ...t };
      delete next[key];
      return next;
    });
    if (v !== undefined) apply(v);
  };

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

/** One configured source's editor. The overview chooses which source reaches this surface. */
function SourceCard({
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
  const [text, setText] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const val = (key: string, stored: string): string => text[key] ?? stored;
  const edit = (key: string, v: string): void => setText((t) => ({ ...t, [key]: v }));
  const commit = (key: string, apply: (v: string) => void): void => {
    const v = text[key];
    setText((t) => {
      const next = { ...t };
      delete next[key];
      return next;
    });
    if (v !== undefined) apply(v);
  };

  async function run(what: string, fn: () => Promise<string | null>): Promise<void> {
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
      {note && <p className="settings-hint ts-note">{note}</p>}

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
                disabled={!text.repoRoot?.trim() || text.repoRoot.trim() === src.repoRoot}
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

      {src.kind === "github-issues" && (
        <GithubFields
          cfg={githubConfigOf(src)}
          onChange={(config) => onChange({ ...src, config })}
        />
      )}

      <div className="ts-defaults">
        <p className="settings-group-label">What a swept task looks like</p>
        <div className="ts-fields">
          <label className="ts-field">
            <span className="ts-field-label">Agent</span>
            <Tooltip label="Which harness a task swept by this source is dispatched to">
              <select
                className="harnesses-select"
                value={src.defaults.agent}
                onChange={(e) =>
                  onChange({
                    ...src,
                    defaults: { ...src.defaults, agent: e.target.value as AgentType },
                  })
                }
              >
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
            <Tooltip label="Whether a swept task asks for a delivered change or an investigation">
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
                <option value="ship">Ship - deliver a change</option>
                <option value="scout">Scout - investigate and report</option>
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
                if (!r) return "The sweep could not run.";
                if (r.error) return r.error;
                const bits = [`filed ${r.filed}`, `${r.alreadySeen} already filed`];
                if (r.overCap > 0) bits.push(`${r.overCap} left for the next sweep`);
                if (r.refused.length > 0) bits.push(`${r.refused.length} refused`);
                return `Swept: ${bits.join(", ")}.`;
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
                return problem ?? "Looks good - gh is reachable and this repo lists issues.";
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
                return "Forgotten - the next sweep will file these items again.";
              })
            }
          >
            {busy === "forget" ? "Forgetting…" : "Forget seen items"}
          </button>
        </Tooltip>
      </div>
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

function SourceDirectory({
  sources,
  kinds,
  statuses,
  filters,
  onFiltersChange,
  restoreFocusId,
  onFocusRestored,
  onSelect,
  onAdd,
}: {
  sources: TaskSourceInstance[];
  kinds: { kind: TaskSourceKind; label: string; blurb: string }[];
  statuses: TaskSourceStatus[];
  filters: SourceDirectoryFilters;
  onFiltersChange: (filters: SourceDirectoryFilters) => void;
  restoreFocusId: string | null;
  onFocusRestored: () => void;
  onSelect: (id: string) => void;
  onAdd: () => void;
}): React.JSX.Element {
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const directoryRef = useRef<HTMLDivElement>(null);
  const byId = new Map(statuses.map((s) => [s.sourceId, s]));
  const counts = sources.reduce(
    (all, src) => {
      const health = sourceHealth(src, byId.get(src.id));
      all[health] += 1;
      return all;
    },
    { healthy: 0, attention: 0, pending: 0, paused: 0 },
  );
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
      <div className="settings-section-head">
        <h3>Task sources <span className="ts-count">· {sources.length} configured</span></h3>
        <Tooltip label="Configure a new upstream to pull work from into the backlog">
          <button className="btn" onClick={onAdd}>+ Add source</button>
        </Tooltip>
      </div>

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
              <Tooltip label={`Open ${nameOf(src, kindLabel)} - ${healthText.toLowerCase()}`}>
                <button
                  ref={(node) => {
                    if (node) rowRefs.current.set(src.id, node);
                    else rowRefs.current.delete(src.id);
                  }}
                  className="ts-directory-row"
                  onClick={() => onSelect(src.id)}
                >
                  <span className="ts-directory-main"><strong>{nameOf(src, kindLabel)}</strong><span>{kindLabel} · {src.repoRoot} · every {minutesOf(src.intervalMs)} min</span></span>
                  <span className={`ts-health ts-health-${health}`}><i />{healthText}</span>
                  <span className="ts-directory-chevron" aria-hidden>›</span>
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
  const editorRef = useRef<HTMLButtonElement>(null);

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
      defaults: { kind: "ship", agent: "claude", priority: null, labels: [] },
      maxPerSweep: DEFAULT_MAX_PER_SWEEP,
      config: {},
    };
    const saved = await save([...sourcesRef.current, added]);
    if (saved) setShowAdd(false);
  }

  useEffect(() => {
    if (selectedId && !sources.some((s) => s.id === selectedId)) {
      setSelectedId(null);
      setRestoreFocusId(null);
    }
  }, [selectedId, sources]);

  const selected = selectedId ? sources.find((s) => s.id === selectedId) : undefined;

  useEffect(() => {
    if (selected) editorRef.current?.focus();
  }, [selected?.id]);

  return (
    <section className="settings-section">
      <p className="settings-hint settings-blurb">
        Pulls work <strong>into</strong> the backlog from systems that already hold it. A
        source files backlog tasks and nothing else: <strong>it never dispatches an agent,
        never cuts a worktree and never types into a session</strong>. What it files is a
        list you read and delete from, and a task you delete stays deleted.
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

      {view && sources.length === 0 && !showAdd ? (
        <p className="settings-hint ts-empty">
          No sources yet - nothing is being swept. Add one below; it starts switched off.
        </p>
      ) : null}

      {view && selected && !showAdd && (
        <div className="ts-editor-view">
          <Tooltip label="Back to the list of configured sources">
            <button ref={editorRef} className="ts-back" onClick={() => setSelectedId(null)}>← All task sources</button>
          </Tooltip>
          <SourceCard
            src={selected}
            kindLabel={kinds.find((k) => k.kind === selected.kind)?.label ?? selected.kind}
            status={view.status.find((s) => s.sourceId === selected.id)}
            repos={repos}
            now={now}
            onChange={replace}
            onRemove={() => {
              remove(selected.id);
              setSelectedId(null);
              setRestoreFocusId(null);
            }}
            state={state}
          />
        </div>
      )}

      {view && !selected && !showAdd && sources.length > 0 && (
        <SourceDirectory
          sources={sources}
          kinds={kinds}
          statuses={view.status}
          filters={directoryFilters}
          onFiltersChange={setDirectoryFilters}
          restoreFocusId={restoreFocusId}
          onFocusRestored={() => setRestoreFocusId(null)}
          onSelect={(id) => {
            setRestoreFocusId(id);
            setSelectedId(id);
          }}
          onAdd={() => setShowAdd(true)}
        />
      )}

      {view && showAdd && <div className="ts-add ts-add-panel">
        <Tooltip label="Back to the list of configured sources">
          <button className="ts-back" onClick={() => setShowAdd(false)}>← All task sources</button>
        </Tooltip>
        <div className="settings-section-head"><h3>Add a task source</h3></div>
        <p className="settings-group-label">Add a source</p>
        {kinds.length > 0 && (
          <p className="settings-hint">{kinds.find((k) => k.kind === kind)?.blurb}</p>
        )}
        <div className="foreman-repo-add">
          <Tooltip label="Which upstream this new source pulls work from">
            <select
              className="harnesses-select"
              value={kind ?? ""}
              disabled={!view}
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
            <button className="btn" disabled={!view || !draftRepo.trim() || adding} onClick={() => void add()}>
              {adding ? "Adding…" : "Add"}
            </button>
          </Tooltip>
        </div>
        {addError && <p className="settings-error">{addError}</p>}
      </div>}

      {view && sources.length === 0 && !showAdd && (
        <Tooltip label="Configure a new upstream to pull work from into the backlog">
          <button className="btn ts-empty-add" onClick={() => setShowAdd(true)}>+ Add source</button>
        </Tooltip>
      )}
    </section>
  );
}
