import type { SkillsState } from "../useSkills.ts";
import {
  GRILL_FIRST_TASK_KINDS,
  HARNESS_LAUNCHED_TASK_KINDS,
  TASK_KIND_INFO,
  isGrillFirstTaskKind,
  type HarnessLaunchedTaskKind,
} from "@shared/task.ts";
import { Tooltip } from "./Tooltip.tsx";
import { ConsoleCard } from "./settings-console.tsx";
import { InfoTip } from "./InfoTip.tsx";
import { GRILL_FIRST_TIP } from "../lib/grill-first.ts";
import { GRILL_SKILL } from "@shared/skills.ts";

// Settings that shape what each kind of task is dispatched with, as one section per kind
// holding every setting this page keeps for it. Today that is Grill me first.
//
// Grill me first's per-kind defaults are stored in the Skills config, beside the skill they
// need, because like Plan storage they are pinned on each task at creation; they are drawn
// from the same `useSkills` state Settings › Skills reads, so no screen polls a second copy.
export function TaskSettingsPanel({
  skills,
}: {
  /** The Skills config and catalog, which carry the Grill me first defaults. */
  skills?: SkillsState;
}): React.JSX.Element {
  const view = skills?.view ?? null;
  const grillFirstKinds = view?.grillFirstKinds ?? [];
  const grill = view?.skills.find((row) => row.id === GRILL_SKILL);
  const grillOff = view !== null && (!view.enabled || grill?.enabled !== true);

  /** Whether a new task of this kind starts with Grill me first on. */
  function grillFirst(kind: HarnessLaunchedTaskKind): React.JSX.Element | null {
    if (!isGrillFirstTaskKind(kind)) return null;
    const label = TASK_KIND_INFO[kind].label;
    return (
      <div className="task-kind-setting">
        <span className="task-kind-setting-name" aria-hidden>Grill me first</span>
        <span className="task-kind-setting-control">
          <Tooltip label={`Start every new ${label} task with Grill me first`}>
            <input
              type="checkbox"
              checked={grillFirstKinds.includes(kind)}
              disabled={!skills || !view}
              aria-label={`Grill me first for ${label} tasks`}
              onChange={(event) => {
                if (!skills) return;
                void skills.update({
                  grillFirstKinds: event.target.checked
                    ? GRILL_FIRST_TASK_KINDS.filter((k) => k === kind || grillFirstKinds.includes(k))
                    : grillFirstKinds.filter((k) => k !== kind),
                });
              }}
            />
          </Tooltip>
          <InfoTip about="Grill me first" text={GRILL_FIRST_TIP} />
        </span>
      </div>
    );
  }

  return (
    <section className="settings-section sc-section">
      <p className="settings-hint sc-lede">
        What each kind of task starts with when nothing names its own choice: a task from the
        dispatch form, the API, a task source or a recurring mission alike. The dispatch form can
        override each of these per task, and existing tasks keep what they were filed with.
      </p>

      {skills && !view && (
        <p className="settings-warn">
          Can't reach the daemon, so the stored defaults are unknown. The controls below are
          showing defaults, not its current state.
        </p>
      )}
      {grillFirstKinds.length > 0 && grillOff && (
        <p className="settings-warn">
          The grill skill is off, so a task that grills first is refused at dispatch. Turn it on
          under Settings › Skills.
        </p>
      )}

      <div className="task-kind-sections" data-anchor="tasks/kinds">
        {HARNESS_LAUNCHED_TASK_KINDS.map((kind) => (
          <ConsoleCard key={kind} title={TASK_KIND_INFO[kind].label} anchor={`tasks/kind-${kind}`}>
            <div
              className="task-kind-settings"
              role="group"
              aria-label={`${TASK_KIND_INFO[kind].label} task settings`}
            >
              {grillFirst(kind)}
            </div>
          </ConsoleCard>
        ))}
      </div>

      {skills?.error && <p className="settings-error" role="alert">{skills.error}</p>}
    </section>
  );
}
