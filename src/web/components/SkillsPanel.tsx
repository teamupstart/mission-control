import { ENFORCEMENT_LABEL, enforcementHint } from "@shared/skills.ts";
import { AGENT_NAMES } from "@shared/agent.ts";
import { capabilitiesFor, skillsAgents } from "@shared/harness-capabilities.ts";
import { AGENT_TYPES } from "@shared/types.ts";
import type { SkillRow } from "@shared/types.ts";
import type { SkillsState } from "../useSkills.ts";

// The skills catalog, as a settings section. Rows are the `.kb-row` shape the
// keyboard editor already uses - label, description, control - because that is what
// this is. The master toggle plus a `fieldset disabled` cascade is ForemanBar's
// pattern, for the same reason: a row you can still click while the master switch is
// off is a row that lies about what it does.

/**
 * Who this switch actually reaches, and who it leaves alone - read off the `skills`
 * capability rather than off the word "claude".
 *
 * Every sentence in this panel names an agent, and each one was a separate literal. A
 * second skill-loading harness would have left all of them saying "Claude" over a grid
 * that is no longer only Claude - which is the same "a toggle that lies about what it
 * does" failure the panel is otherwise careful about.
 */
const SKILLED = skillsAgents();
const SKILLED_LABEL = SKILLED.map((a) => AGENT_NAMES[a].label).join(" / ");
const UNSKILLED_LABEL = AGENT_TYPES.filter((a) => !capabilitiesFor(a).skills)
  .map((a) => AGENT_NAMES[a].label)
  .join(" / ");

/**
 * What the enforcement rung actually promises, said out loud on every row.
 *
 * Native skills are MODEL-INVOKED. Enabling one loads its description into context;
 * whether the agent reaches for it is the agent's call. A reload command fixes delivery,
 * not activation - a reloaded skill is loaded, not obeyed - so a panel that renders a
 * toggle and nothing else is quietly promising enforcement it cannot deliver. The
 * badge is where the promise gets scoped back down to the truth.
 */
function EnforcementBadge({ row }: { row: SkillRow }): React.JSX.Element {
  return (
    <span className={`skill-badge skill-badge-${row.enforcement}`} title={enforcementHint(row.enforcement)}>
      {ENFORCEMENT_LABEL[row.enforcement]}
    </span>
  );
}

/** One catalog row: what it is, how firmly it binds, and who it reaches. */
function SkillRowView({
  row,
  disabled,
  onToggle,
}: {
  row: SkillRow;
  disabled: boolean;
  onToggle: (on: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="kb-row skill-row">
      <div className="kb-row-text">
        <span className="kb-row-label">
          /{row.name}
          <EnforcementBadge row={row} />
          {/*
            Named on every row, because there is no version of this that works on a
            harness with no `skills` capability: no reload command and no skills
            directory, so the loop filters it out entirely. A toggle that silently
            no-ops on half the grid is the same failure that disqualified launch flags -
            saying so on the row is what keeps it from being one.
          */}
          <span
            className="skill-badge skill-badge-agent"
            title={`${UNSKILLED_LABEL} sessions are unaffected - they have no skills directory.`}
          >
            {SKILLED.join(" / ")} only
          </span>
        </span>
        <span className="kb-row-desc">{row.description}</span>
      </div>
      <div className="kb-row-controls">
        <label className="skill-switch">
          <input
            type="checkbox"
            checked={row.enabled}
            disabled={disabled}
            onChange={(e) => onToggle(e.target.checked)}
            aria-label={`Enable /${row.name} in every ${SKILLED_LABEL} session`}
          />
        </label>
      </div>
    </div>
  );
}

export function SkillsPanel({ state }: { state: SkillsState }): React.JSX.Element {
  const { view, update, error } = state;

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3>Skills</h3>
      </div>

      <p className="settings-hint skills-blurb">
        Skills switched on here are symlinked into <code>~/.claude/skills</code>, so they reach{" "}
        <strong>every</strong> {SKILLED_LABEL} session on this machine - including ones this app
        never launched. Running sessions pick them up at their next idle moment, without
        restarting.
      </p>

      {error && <p className="settings-error">{error}</p>}
      {/*
        A catalog problem is persistent and needs a human (a malformed SKILL.md, a
        directory in the way), so it renders separately from `error`, which is about
        the click you just made and is cleared by the next one that works.
      */}
      {view?.problems.map((p) => (
        <p className="settings-error" key={p}>
          {p}
        </p>
      ))}

      <label className="alert-row skills-master">
        <input
          type="checkbox"
          checked={view?.enabled ?? false}
          disabled={!view}
          onChange={(e) => void update({ enabled: e.target.checked })}
        />
        Enable Mission Control skills
      </label>

      {/* Cascade from the master switch, ForemanBar's pattern: off means nothing is
          symlinked whatever the rows say, so the rows must not look clickable. */}
      <fieldset className="skills-list" disabled={!view?.enabled}>
        {view?.skills.map((row) => (
          <SkillRowView
            key={row.id}
            row={row}
            disabled={!view.enabled}
            onToggle={(on) => void update({ skills: { [row.id]: on } })}
          />
        ))}
      </fieldset>

      {view && view.skills.length === 0 && (
        <p className="settings-hint">
          No skills in the catalog yet. They live in <code>skills/</code> in this repo, one
          directory per skill.
        </p>
      )}

      {/*
        Counts only harnesses that declare `skills`, or the number lies on a mixed set of
        sessions. Phrased as a promise about WHEN, not whether: the daemon waits for a
        session to be genuinely at its prompt before typing, so a busy session is behind
        rather than missed.
      */}
      {view && view.pending > 0 && (
        <p className="settings-hint">
          {view.pending === 1
            ? `1 ${SKILLED_LABEL} session will pick this up when it next goes idle.`
            : `${view.pending} ${SKILLED_LABEL} sessions will pick this up when they next go idle.`}
        </p>
      )}
    </section>
  );
}
