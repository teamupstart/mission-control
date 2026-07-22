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
 * "Never swept" and "swept, found nothing" are deliberately different sentences: they are
 * the two states a background feature is most often confused about, and reading the first
 * as the second is how a source that has been broken since setup goes unnoticed.
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
      <button className="foreman-repo-remove" onClick={onRemove} aria-label={`Stop mapping ${label}`}>
        ✕
      </button>
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
            <span>{text}</span>
          </label>
        ))}
      </fieldset>

      <label className="alert-row ts-check">
        <input
          type="checkbox"
          checked={cfg.copyLabels}
          onChange={(e) => onChange({ ...cfg, copyLabels: e.target.checked })}
        />
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
          <input
            type="checkbox"
            checked={src.enabled}
            aria-label={`Sweep ${nameOf(src, kindLabel)} on a schedule`}
            onChange={(e) => onChange({ ...src, enabled: e.target.checked })}
          />
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
        <button
          className="foreman-repo-remove"
          onClick={onRemove}
          title="Remove this source"
          aria-label={`Remove ${nameOf(src, kindLabel)}`}
        >
          ✕
        </button>
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
            <button
              className="btn"
              disabled={!text.repoRoot?.trim() || text.repoRoot.trim() === src.repoRoot}
              onClick={() => commit("repoRoot", (v) => onChange({ ...src, repoRoot: v.trim() }))}
            >
              Set repo
            </button>
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
          </label>

          <label className="ts-field">
            <span className="ts-field-label">Kind</span>
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
          </label>

          <label className="ts-field">
            <span className="ts-field-label">Priority</span>
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
        <button
          className="btn"
          disabled={busy !== null || (status?.seenCount ?? 0) === 0}
          title="Everything this source has filed becomes fileable again"
          onClick={() =>
            void run("forget", async () => {
              await state.forget(src.id);
              return "Forgotten - the next sweep will file these items again.";
            })
          }
        >
          {busy === "forget" ? "Forgetting…" : "Forget seen items"}
        </button>
      </div>
    </div>
  );
}

type SourceFilter = "all" | "enabled" | "attention" | "paused";
type SourceHealth = Exclude<SourceFilter, "all">;

function sourceHealth(src: TaskSourceInstance, status: TaskSourceStatus | undefined): SourceHealth {
  if (status?.lastError) return "attention";
  if (!src.enabled) return "paused";
  return "enabled";
}

function SourceDirectory({
  sources,
  kinds,
  statuses,
  onSelect,
  onAdd,
}: {
  sources: TaskSourceInstance[];
  kinds: { kind: TaskSourceKind; label: string; blurb: string }[];
  statuses: TaskSourceStatus[];
  onSelect: (id: string) => void;
  onAdd: () => void;
}): React.JSX.Element {
  const [filter, setFilter] = useState<SourceFilter>("all");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<TaskSourceKind | "all">("all");
  const byId = new Map(statuses.map((s) => [s.sourceId, s]));
  const counts = sources.reduce(
    (all, src) => {
      const health = sourceHealth(src, byId.get(src.id));
      all[health] += 1;
      return all;
    },
    { enabled: 0, attention: 0, paused: 0 },
  );
  const needle = query.trim().toLowerCase();
  const visible = sources.filter((src) => {
    const status = byId.get(src.id);
    const label = kinds.find((k) => k.kind === src.kind)?.label ?? src.kind;
    const matchesFilter = filter === "all" || sourceHealth(src, status) === filter;
    const matchesKind = kind === "all" || src.kind === kind;
    const haystack = `${nameOf(src, label)} ${label} ${src.repoRoot}`.toLowerCase();
    return matchesFilter && matchesKind && (!needle || haystack.includes(needle));
  });

  return (
    <>
      <div className="settings-section-head">
        <h3>Task sources <span className="ts-count">· {sources.length} configured</span></h3>
        <button className="btn" onClick={onAdd}>+ Add source</button>
      </div>

      <div className="ts-overview" aria-label="Task source overview">
        <div className="ts-metric"><strong>{sources.length}</strong><span>configured sources</span></div>
        <div className="ts-metric"><strong className="ts-good">{counts.enabled}</strong><span>running normally</span></div>
        <div className="ts-metric"><strong className={counts.attention > 0 ? "ts-attention" : "ts-good"}>{counts.attention}</strong><span>need attention</span></div>
      </div>
      {counts.attention > 0 && (
        <p className="ts-attention-callout">
          <strong>Attention:</strong> {counts.attention} source{counts.attention === 1 ? "" : "s"} had a failed sweep. Filter to review and repair {counts.attention === 1 ? "it" : "them"}.
        </p>
      )}

      <div className="ts-directory-tools">
        <input
          className="field-input"
          value={query}
          placeholder="Search sources, repositories or types…"
          aria-label="Search task sources"
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className="harnesses-select" value={kind} aria-label="Filter task sources by type" onChange={(e) => setKind(e.target.value as TaskSourceKind | "all")}>
          <option value="all">All types</option>
          {kinds.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
        </select>
      </div>
      <div className="ts-filters" aria-label="Filter task sources by health">
        {([
          ["all", `All ${sources.length}`],
          ["enabled", `Enabled ${counts.enabled}`],
          ["attention", `Attention ${counts.attention}`],
          ["paused", `Paused ${counts.paused}`],
        ] as const).map(([id, label]) => (
          <button key={id} className={filter === id ? "is-active" : ""} onClick={() => setFilter(id)}>{label}</button>
        ))}
      </div>

      <div className="ts-directory" role="list" aria-label="Configured task sources">
        {visible.map((src) => {
          const status = byId.get(src.id);
          const kindLabel = kinds.find((k) => k.kind === src.kind)?.label ?? src.kind;
          const health = sourceHealth(src, status);
          const healthText = health === "attention" ? "Failed" : health === "paused" ? "Paused" : status?.sweeping ? "Sweeping" : "Healthy";
          return (
            <button className="ts-directory-row" role="listitem" key={src.id} onClick={() => onSelect(src.id)}>
              <span className="ts-directory-main"><strong>{nameOf(src, kindLabel)}</strong><span>{kindLabel} · {src.repoRoot} · every {minutesOf(src.intervalMs)} min</span></span>
              <span className={`ts-health ts-health-${health}`}><i />{healthText}</span>
              <span className="ts-directory-chevron" aria-hidden>›</span>
            </button>
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
    if (selectedId && !sources.some((s) => s.id === selectedId)) setSelectedId(null);
  }, [selectedId, sources]);

  const selected = selectedId ? sources.find((s) => s.id === selectedId) : undefined;

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
        <>
          <button className="ts-back" onClick={() => setSelectedId(null)}>← All task sources</button>
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
            }}
            state={state}
          />
        </>
      )}

      {view && !selected && !showAdd && sources.length > 0 && (
        <SourceDirectory
          sources={sources}
          kinds={kinds}
          statuses={view.status}
          onSelect={setSelectedId}
          onAdd={() => setShowAdd(true)}
        />
      )}

      {view && showAdd && <div className="ts-add ts-add-panel">
        <button className="ts-back" onClick={() => setShowAdd(false)}>← All task sources</button>
        <div className="settings-section-head"><h3>Add a task source</h3></div>
        <p className="settings-group-label">Add a source</p>
        {kinds.length > 0 && (
          <p className="settings-hint">{kinds.find((k) => k.kind === kind)?.blurb}</p>
        )}
        <div className="foreman-repo-add">
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
          <RepoCombobox
            repos={repos}
            value={draftRepo}
            onChange={(v) => {
              setDraftRepo(v);
              setAddError(null);
            }}
          />
          <button className="btn" disabled={!view || !draftRepo.trim() || adding} onClick={() => void add()}>
            {adding ? "Adding…" : "Add"}
          </button>
        </div>
        {addError && <p className="settings-error">{addError}</p>}
      </div>}

      {view && sources.length === 0 && !showAdd && (
        <button className="btn ts-empty-add" onClick={() => setShowAdd(true)}>+ Add source</button>
      )}
    </section>
  );
}
