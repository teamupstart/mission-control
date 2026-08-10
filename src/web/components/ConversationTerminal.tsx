import { AGENT_IDENTITY } from "@shared/agent.ts";
import type { Session } from "@shared/types.ts";
import { stateDisplay } from "../lib/format.ts";
import { formatChord, useKeybindingHints, useKeybindings } from "../lib/keybindings.ts";
import type { ActionId } from "../lib/keybindings.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * The frame around the Native PTY reading of a conversation: the titlebar above the log
 * and the status line below the composer.
 *
 * Separate from `TranscriptPanel` because none of it touches a transcript row - it is
 * session facts, drawn - and because that makes it renderable, and therefore assertable,
 * on its own. The rows themselves stay beside their chat counterparts in the panel, where
 * they can share `Highlighted` and `ToolChips` with them.
 *
 * THE HONESTY RULE, inherited whole from the observed-activity sideband: this frame may
 * say what Mission Control actually knows about the session, and must not dress a guess as
 * a reading. Every field below is a real value or is absent - there are no placeholder
 * dashes standing in for facts we do not have, because a dash in a status bar reads as
 * "zero" or "none" rather than "unknown".
 */

/** Whether the dashboard is tailing this session's transcript right now. */
export type TerminalAttach = "connecting" | "live" | "unavailable";

const ATTACH_TEXT: Record<TerminalAttach, string> = {
  connecting: "attaching…",
  live: "attached",
  unavailable: "detached",
};

/**
 * The `<shell>` slot of the titlebar.
 *
 * A terminal session names its controlling tty, which is a real handle an operator can go
 * looking for. An SDK session has no tty at all, so it names its runtime rather than
 * inventing `zsh` - the mockup's placeholder - for a process that never had a shell.
 */
function shellName(session: Session): string {
  return session.tty ?? session.runtime;
}

/**
 * The titlebar: window lights, what this window is, and whether we are attached to it.
 *
 * The lights are decoration and say so (`aria-hidden`); they are not controls, and this
 * frame deliberately does not grow close/minimize buttons that would imply a window
 * manager it does not have.
 */
export function TerminalTitlebar({
  session,
  attach,
}: {
  session: Session;
  attach: TerminalAttach;
}): React.JSX.Element {
  const agentLabel = AGENT_IDENTITY[session.agent].speaker;
  return (
    <header className="pty-titlebar">
      <span className="pty-lights" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="pty-title">
        mission-control: conversation · {agentLabel} · {shellName(session)}
      </span>
      <Tooltip
        label={
          attach === "live"
            ? "Tailing this session's transcript"
            : attach === "connecting"
              ? "Opening this session's transcript stream"
              : "This session's transcript could not be read"
        }
      >
        <span className="pty-attach" data-attach={attach}>
          ● {ATTACH_TEXT[attach]}
        </span>
      </Tooltip>
    </header>
  );
}

/** One taught shortcut: the action whose chord to print, and the word beside it. */
export interface LegendEntry {
  action: ActionId;
  label: string;
}

/**
 * The shortcuts this session actually has, in the mockup's order.
 *
 * Derived rather than a constant list, because a legend that teaches a chord which does
 * nothing here is worse than teaching nothing: the reader tries it, gets silence, and
 * learns to distrust the row. Every entry below is drawn only where the action bar draws
 * its own button for the same thing, and this function mirrors those conditions exactly
 * (`ActionBar`'s `variant="foot"`, plus the `live` gate both hosts put around it).
 *
 * The first entry is the one the mockup got wrong for most sessions. `handoff` (Shift+T,
 * "Continue in terminal") is an SDK-only action - its handler returns immediately unless
 * `session.runtime === "sdk"` - so on any pane-backed session the chord that actually
 * reaches the terminal is `focus`. Same slot, same place in the row, different action and
 * different word, exactly as the footer already switches them.
 */
export function terminalLegend(session: Session): readonly LegendEntry[] {
  // A finished session has no action bar in either host, so it has nothing to teach.
  if (session.state === "exited" || session.state === "stopping") return [];
  const rows: LegendEntry[] = [
    session.runtime === "sdk"
      ? { action: "handoff", label: "terminal" }
      : { action: "focus", label: "focus" },
  ];
  // No checkout, no diff to open.
  if (session.cwd) rows.push({ action: "diff", label: "diff" });
  // Completing is completing a TASK; the footer's button is disabled without one.
  if (session.task) rows.push({ action: "complete", label: "complete" });
  rows.push({ action: "kill", label: "kill" });
  return rows;
}

/**
 * The chord legend, in the operator's own bindings.
 *
 * A LEGEND, not a second row of buttons, and that is a deliberate refusal of the mockup's
 * shape. Each of these actions has exactly one control in this app (the action bar) and
 * exactly one chord; a second `kill` button living in a status bar would be a second path
 * to the most destructive thing here, kept in step with the first by hand. The row teaches
 * the chords instead - which is the one thing a status bar is actually for - and hides
 * entirely when the operator has turned chord hints off, because teaching is all it was
 * doing.
 *
 * A chord an operator has unbound is dropped for the same reason `terminalLegend` drops an
 * action this session cannot take: the row only ever prints keys that do something.
 */
function TerminalKeyLegend({ session }: { session: Session }): React.JSX.Element | null {
  const { bindings } = useKeybindings();
  const [hints] = useKeybindingHints();
  if (!hints) return null;
  const rows = terminalLegend(session)
    .map((entry) => ({ ...entry, chord: formatChord(bindings[entry.action]) }))
    .filter((entry) => entry.chord);
  if (rows.length === 0) return null;
  return (
    <span className="pty-keys">
      {rows.map((entry) => (
        <span key={entry.action} className="pty-key">
          <kbd className="kb-hint">{entry.chord}</kbd>
          {entry.label}
        </span>
      ))}
    </span>
  );
}

/**
 * The status line: what this process is doing, and what you can do to it.
 *
 * Every fact is conditional on being known. `pid` is 0 for an SDK driver that reports no
 * subprocess, `gitBranch` is null off a checkout, and `contextPct` is null until a harness
 * reports usage - and in each case the field is simply not drawn. The run state is the
 * same `stateDisplay()` the card badge uses, so the terminal frame and the card behind it
 * can never describe the session differently.
 */
export function TerminalStatusLine({ session }: { session: Session }): React.JSX.Element {
  const state = stateDisplay(session);
  const agentLabel = AGENT_IDENTITY[session.agent].speaker;
  // `meta` is null until a harness has reported anything about the run, so the context
  // share is absent twice over: no meta at all, or meta that does not know yet.
  const ctx = session.meta?.contextPct ?? null;
  return (
    <section className="pty-status" aria-label="Session status">
      <span className={`pty-live tone-${state.tone}`}>
        ● {agentLabel}: {state.label}
      </span>
      {session.pid > 0 && <span className="pty-stat">pid {session.pid}</span>}
      {session.gitBranch && (
        <span className="pty-stat pty-branch">
          <span aria-hidden="true">⌁ </span>
          {session.gitBranch}
        </span>
      )}
      {ctx !== null && (
        <Tooltip label="Share of the context window this session has used">
          <span className="pty-stat pty-optional">ctx {ctx}%</span>
        </Tooltip>
      )}
      <span className="pty-status-sp" />
      <TerminalKeyLegend session={session} />
    </section>
  );
}
