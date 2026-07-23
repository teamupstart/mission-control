import { ENFORCEMENT_LABEL, enforcementHint } from "@shared/skills.ts";
import { agentList } from "@shared/agent.ts";
import { capabilitiesFor, skillLoadingAgents, skillsAgents } from "@shared/harness-capabilities.ts";
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
const SKILLED = skillLoadingAgents();
const SKILLED_LABEL = agentList(SKILLED);
const UNSKILLED = AGENT_TYPES.filter((a) => !capabilitiesFor(a).skills);
/**
 * The agents a change still has to be TYPED at, which is a different list from `SKILLED`
 * and is why the pending count below names its own.
 *
 * Codex loads the same skills and watches its directory for them, so it is in `SKILLED`
 * and not here. Counting it as pending would leave the panel promising a pick-up that no
 * keystroke is coming for; leaving it out of `SKILLED` would say the switch does not
 * reach it, which is the "toggle that lies about what it does" failure the rest of this
 * panel is careful about.
 */
const RELOADED = skillsAgents();
const SELF_RELOADING = SKILLED.filter((a) => !RELOADED.includes(a));
/**
 * Where the links actually go, read off the same `homeDir` the reconciler symlinks
 * into. Spelled out rather than said in prose because the operator may want to look:
 * a path typed here by hand is one that can quietly stop being where the files are.
 */
const SKILLED_DIRS = SKILLED.map((a) => `~/${capabilitiesFor(a).skills!.homeDir.join("/")}`);

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

            And rendered only while there IS someone it leaves out. With every shipped
            harness reached, "claude only" is false and the title composes to a sentence
            that opens with a blank - a caveat about nobody, which is worse than silence.
          */}
          {UNSKILLED.length > 0 && (
            <span
              className="skill-badge skill-badge-agent"
              title={`${agentList(UNSKILLED)} sessions are unaffected - they have no skills directory.`}
            >
              {agentList(SKILLED)} only
            </span>
          )}
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
        Skills switched on here are symlinked into{" "}
        {SKILLED_DIRS.map((dir, i) => (
          <span key={dir}>
            {i > 0 && " and "}
            <code>{dir}</code>
          </span>
        ))}
        , so they reach <strong>every</strong> {SKILLED_LABEL} session on this machine - including
        ones this app never launched.
        {RELOADED.length > 0 && ` Running ${agentList(RELOADED)} sessions pick changes up at their next idle moment.`}
        {SELF_RELOADING.length > 0 && ` Changes are picked up automatically by ${agentList(SELF_RELOADING)}.`}
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
        Counts only harnesses a reload has to be TYPED at (`RELOADED`), not everyone the
        skill reaches, or the number lies on a mixed set of sessions in the other
        direction: a Codex session that already has the skill would be counted as still
        waiting for it, and the figure would never reach zero. Phrased as a promise about
        WHEN, not whether: the daemon waits for a session to be genuinely at its prompt
        before typing, so a busy session is behind rather than missed.
      */}
      {view && view.pending > 0 && (
        <p className="settings-hint">
          {view.pending === 1
            ? `1 ${agentList(RELOADED)} session will pick this up when it next goes idle.`
            : `${view.pending} ${agentList(RELOADED)} sessions will pick this up when they next go idle.`}
        </p>
      )}
    </section>
  );
}
