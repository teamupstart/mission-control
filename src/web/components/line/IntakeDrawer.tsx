import { useEffect, useState } from "react";
import type { MissionSchedule } from "@shared/schedules.ts";
import type { TaskSourcesView } from "@shared/task-source.ts";
import { relativeTime, untilTime } from "../../lib/format.ts";
import { fetchTaskSources } from "../../lib/api.ts";
import { Tooltip } from "../Tooltip.tsx";
import { LineDrawer, LineDrawerEmpty } from "./LineDrawer.tsx";

/**
 * INTAKE - the two machineries that file work without being asked, and whether either is ill.
 *
 * Missions arrive over SSE like everything else on the fleet, so they cost nothing to render
 * here. Task sources do not: they are settings-shaped, and `useTaskSources` polls them every
 * four seconds for the panel that edits them. This reads them ONCE, on mount, and this
 * component only mounts while the drawer is open - so a fleet sitting with the drawer shut
 * makes no request at all, and an open one makes exactly one. Choosing the poll would have
 * put a four-second timer on the fleet page to keep a sweep timestamp fresh that nobody is
 * watching tick.
 *
 * Neither half is editable here. A row opens the surface that owns it - the Missions overlay,
 * or Settings → Task sources - which is the same escalation the other two drawers make.
 */

/** A source's own name, falling back to its kind. The daemon's fold uses the same rule. */
function sourceName(label: string, kind: string): string {
  return label.trim() || kind;
}

function IntakeRow({
  name,
  kind,
  fact,
  tone,
  openLabel,
  onOpen,
  hint,
}: {
  name: string;
  /** The mono eyebrow: which machinery this row is. */
  kind: string;
  fact: string;
  tone: "ok" | "off" | "warn";
  openLabel: string;
  onOpen: () => void;
  hint: string;
}): React.JSX.Element {
  return (
    <li className={`line-intake-row${tone === "warn" ? " is-waiting" : ""}`}>
      <span className="line-intake-who">
        <strong>{name}</strong>
        <span className="line-intake-kind">{kind}</span>
      </span>
      <span className={`line-intake-state is-${tone}`}>{fact}</span>
      <span className="line-intake-ops">
        <Tooltip label={hint}>
          <button type="button" className="btn btn-ghost" onClick={onOpen}>
            {openLabel}
          </button>
        </Tooltip>
      </span>
    </li>
  );
}

export function IntakeDrawer({
  schedules,
  now,
  onClose,
  onOpenMissions,
  onOpenTaskSources,
}: {
  schedules: readonly MissionSchedule[];
  /** Injected so "swept 4m ago" is a pure function of props - see the render tests. */
  now: number;
  onClose: () => void;
  onOpenMissions: () => void;
  onOpenTaskSources: () => void;
}): React.JSX.Element {
  // THREE states, not two, and the third is the whole point of this hook.
  //
  // `fetchTaskSources` swallows every failure - network, non-2xx, unparseable body - and
  // resolves `null`. Held as `null` here, that is indistinguishable from "has not answered
  // yet", and both then render as `0 sources`: a drawer whose ONE job is to say whether
  // anything feeding the backlog is broken would report a daemon it cannot reach as a tidy,
  // empty, healthy intake. Silence is the one answer this surface must never give.
  //
  // A successful read of an empty configuration is `{ sources: [], … }`, so `null` means
  // failure unambiguously and the three states never collapse.
  const [sources, setSources] = useState<TaskSourcesView | "loading" | "failed">("loading");
  useEffect(() => {
    let alive = true;
    void fetchTaskSources()
      .then((view) => {
        if (alive) setSources(view ?? "failed");
      })
      // `fetchJson` cannot currently reject, and this is here anyway: it is a shared helper
      // several surfaces call, and the day it grows a throw this drawer must not answer with
      // a permanent "loading" that reads as an empty intake.
      .catch(() => {
        if (alive) setSources("failed");
      });
    return () => {
      alive = false;
    };
  }, []);

  const loaded = typeof sources === "object" ? sources : null;
  const failed = sources === "failed";
  const missions = schedules.filter((schedule) => schedule.archivedAt === null);
  const configured = loaded?.sources ?? [];
  const statusById = new Map((loaded?.status ?? []).map((status) => [status.sourceId, status]));
  // A load that failed counts as needing a look. Unknown health is not health, and the count
  // beside the title is what an operator reads before deciding whether to open anything.
  const unhealthy = missions.filter((m) => m.health === "attention").length
    + configured.filter((source) => statusById.get(source.id)?.lastError != null).length
    + (failed ? 1 : 0);
  // Only ever asked of a LOADED view - see the empty state below.
  const total = missions.length + configured.length;
  const sourceCount = loaded
    ? `${configured.length} source${configured.length === 1 ? "" : "s"}`
    : failed
      ? "sources unavailable"
      : "sources loading…";

  return (
    <LineDrawer
      stage="intake"
      // Counted separately rather than summed. They are two different machineries with two
      // different remedies, and "3 in intake" would hide a fleet whose only source is off.
      // The sources half is a phrase rather than a number while it is not known, because a
      // `0` an operator cannot distinguish from a real zero is worse than no figure at all.
      count={`${sourceCount} · ${missions.length} mission${missions.length === 1 ? "" : "s"}`}
      attention={unhealthy > 0 ? `${unhealthy} need${unhealthy === 1 ? "s" : ""} a look` : ""}
      onClose={onClose}
      actions={(
        <>
          <Tooltip label="Open recurring missions - cadence, preview, and run history">
            <button type="button" className="btn btn-ghost" onClick={onOpenMissions}>
              Missions <span aria-hidden>→</span>
            </button>
          </Tooltip>
          <Tooltip label="Open task sources in Settings - what pulls a real backlog in">
            <button type="button" className="btn btn-ghost" onClick={onOpenTaskSources}>
              Sources <span aria-hidden>→</span>
            </button>
          </Tooltip>
        </>
      )}
    >
      {/* The empty state is a CLAIM - "nothing files work on its own yet" - so it is made
          only from a view that actually arrived. Claiming it over a failed read is how a
          fleet with four configured sources reports itself as having none. */}
      {loaded && total === 0 ? (
        <LineDrawerEmpty>
          Nothing files work on its own yet. A recurring mission files a task on a cadence; a
          task source pulls your real backlog in. Neither ever launches an agent.
        </LineDrawerEmpty>
      ) : !loaded && !failed && missions.length === 0 ? (
        // The one tick between opening the drawer and the read landing, on a fleet with no
        // missions to fill it. Saying so beats a blank panel, and it must not be the sentence
        // above - which would assert an absence nobody has confirmed yet.
        <LineDrawerEmpty>Reading task sources…</LineDrawerEmpty>
      ) : (
        <ul className="line-drawer-rows">
          {/* A read that failed is drawn as a row rather than tucked into the header,
              because at triage grain that is exactly what it is: the machinery that pulls
              work in is not answering, which is a thing to go and look at. It sits where the
              source rows would be, and the missions below it still render - one half being
              unreadable is no reason to withhold the other. */}
          {failed && (
            <IntakeRow
              name="Task sources"
              kind="source"
              fact="could not be read - the daemon did not answer"
              tone="warn"
              openLabel="Settings"
              onOpen={onOpenTaskSources}
              hint="Open task sources in Settings and check what is configured"
            />
          )}
          {configured.map((source) => {
            const status = statusById.get(source.id);
            const failing = status?.lastError != null;
            return (
              <IntakeRow
                key={source.id}
                name={sourceName(source.label, source.kind)}
                kind="source"
                fact={!source.enabled
                  ? "switched off"
                  : failing
                    // The daemon's own words for what went wrong, clipped by the row rather
                    // than summarised here - a paraphrased error is one an operator cannot
                    // search for.
                    ? `last sweep failed: ${status!.lastError}`
                    : status?.sweeping
                      ? "sweeping now"
                      : status?.lastSweepAt
                        ? `swept ${relativeTime(status.lastSweepAt, now)} · ${status.lastFiled} filed`
                        : "never swept"}
                tone={failing ? "warn" : source.enabled ? "ok" : "off"}
                openLabel="Settings"
                onOpen={onOpenTaskSources}
                hint={`Configure ${sourceName(source.label, source.kind)} in Settings`}
              />
            );
          })}
          {missions.map((mission) => (
            <IntakeRow
              key={mission.id}
              name={mission.name}
              kind="mission"
              fact={!mission.enabled
                ? "paused"
                : mission.health === "attention"
                  ? `${mission.expression} · needs attention`
                  : mission.nextRunAt
                    ? `${mission.expression} · next ${untilTime(mission.nextRunAt, now)}`
                    : `${mission.expression} · not scheduled`}
              tone={mission.health === "attention"
                ? "warn"
                : mission.enabled ? "ok" : "off"}
              openLabel="Open"
              onOpen={onOpenMissions}
              hint={`Open ${mission.name} in recurring missions`}
            />
          ))}
        </ul>
      )}
    </LineDrawer>
  );
}
