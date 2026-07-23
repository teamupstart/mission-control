import type { Session } from "@shared/types.ts";
import type { SkillsConfig } from "@shared/protocol.ts";
import { harnessFor } from "../harness/index.ts";
import { hasPane, settledIdle } from "../foreman/queue-machine.ts";
import { injectPrompt } from "../actions.ts";
import type { InjectResult } from "../actions.ts";
import { POLL_INTERVAL_MS, envVar } from "../config.ts";
import { getSkillsAcks, setSkillsAck } from "../db.ts";
import { readPaneModeLine } from "../discovery/pane-mode.ts";
import { recordInjection } from "../injections.ts";
import type { PaneModeLine } from "../discovery/pane-mode.ts";
import { noteKeyFor } from "../registry.ts";
import type { Registry } from "../registry.ts";
import { getSkillsConfig } from "./config.ts";
import { unref } from "../util/timers.ts";

/*
  The broadcast loop: type `/reload-skills` into sessions that haven't picked up the
  current symlink set yet.

  THIS IS THE ONE GENUINELY NEW MECHANISM IN THE FEATURE, and it is worth naming
  plainly: the daemon is no longer strictly reactive. Until now it typed into a pane
  only downstream of a route call, which meant downstream of a person; the only
  autonomous typing in the system was quarantined in Foreman, a separate, leased,
  opt-in worker process. This loop ends that invariant - it lives in the daemon, it
  is not leased (the port bind is the mutex: two daemons cannot both hold :7317), and
  it types unprompted.

  The risk isn't this feature. It's the next one, written by someone who reads the old
  rule and reasons from it. If you are here to add a second autonomous writer, this
  paragraph is the thing you needed to know.
*/

/** The settle window when the env says nothing usable. Mirrors FOREMAN_QUEUE_SETTLE_MS. */
const DEFAULT_SETTLE_MS = 10_000;

/**
 * How long a session must sit idle before we'll type into it.
 *
 * Validated rather than `Number(envVar(...) ?? default)`, which is the pattern its
 * siblings use and which is wrong HERE for a reason they don't share: this knob gates
 * typing into a live pane. `envVar` returns the raw string, so an exported-but-empty
 * `MISSION_SKILLS_SETTLE_MS=` is `""`, and `Number("")` is **0** - a settle window of
 * nothing, which types into a session the instant it reports idle, i.e. straight into
 * the gap between a Stop and the PostToolUse that lands after it. A typo'd value gives
 * `NaN`, and every comparison against NaN is false, which silently disables the whole
 * feature instead. Both failures are silent, and one of them is a keystroke.
 *
 * The default value is NOT the floor: 0 is a legitimate ask from someone who knows what
 * they're doing. Only unusable input falls back.
 */
function resolveSettleMs(raw = envVar("SKILLS_SETTLE_MS")): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_SETTLE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SETTLE_MS;
}

const SETTLE_MS = resolveSettleMs();

/**
 * The sessions this tick should try to reload. Pure, `now` injected, no I/O - the
 * discipline `decideQueueTick` holds, and for the same reason: a selector is policy,
 * so it has to be testable as a table.
 *
 * Cheapest filter first, because step 4 of the gate (reading the pane) costs a
 * subprocess per session per tick and everything here exists to keep it from running.
 *
 * Deliberately NOT gated on `cfg.enabled`. The master switch governs what is
 * SYMLINKED, not who gets told: turning it off empties the desired set, which changes
 * the disk, which bumps the generation - and those sessions need a reload to DROP the
 * skills. A loop that went quiet when the switch went off would leave every session using
 * skills the panel says are off, which is the worst state this feature can be in.
 */
export function reloadTargets(
  sessions: Session[],
  acks: Map<string, number>,
  cfg: SkillsConfig,
  now: number,
  settleMs = SETTLE_MS,
): Session[] {
  if (cfg.generation === 0) return []; // the set has never changed: nothing is owed
  return sessions.filter((s) => reloadNeeded(s, acks, cfg, now, settleMs));
}

/**
 * Whether a session can pick up the current generation, excluding only its transient
 * idle/settle state.
 *
 * The split from `reloadNeeded` is the `hooksSeen` / `instrumented` distinction the
 * queue machine already documents, and the two halves must not drift: this one answers
 * "is a reload owed to this session at all", which is what the panel's counter reports,
 * while `reloadNeeded` adds "and is it safe to type right now".
 *
 * The base clauses are permanent. A transcript-driven harness additionally needs a
 * currently attributable file, so the counter never promises a reload for a session
 * whose passive idle source cannot be tied to that pane.
 */
function reloadOwedBase(s: Session, acks: Map<string, number>, cfg: SkillsConfig): boolean {
  // 1. This harness has no skills to reload - no directory we symlink into, and no
  //    command that would make a running session notice if there were. Typing one anyway
  //    would put a stray line in someone's prompt and change nothing.
  const skills = harnessFor(s.agent).skills;
  if (!skills?.reloadCommand || !skills.reloadIdleSource) return false;
  if (s.state === "exited") return false;

  // 2. Nowhere to type, ever. `capturePaneText` answers null for a handleless session,
  //    so the gate below would refuse it every tick until it exited - and the counter
  //    would promise a pick-up that cannot happen.
  if (!hasPane(s)) return false;

  // 3. The harness's declared idle source must exist for this session.
  if (skills.reloadIdleSource === "hooks" && !s.hooksSeen) return false;

  // 4. Already current. The watermark, not a queue: five toggles land at generation 5,
  //    and ONE reload re-reads the directory and satisfies all of them.
  if (ackOf(s, acks) >= cfg.generation) return false;

  // 5. Booted after the change, so it loaded the current set at startup and has nothing
  //    to pick up. Without this, every session discovered from here to the end of time
  //    gets an unsolicited `/reload-skills` the first time it goes quiet - it has no ack
  //    row, and `0 < generation` forever.
  //
  //    Conservative in the safe direction: claude scans the directory some moment AFTER
  //    its process starts, so a process that started once the symlink was already on
  //    disk certainly saw it. A session that started just BEFORE the write gets a reload
  //    it might not have needed, which costs two lines of transcript.
  if (s.startedAt !== null && s.startedAt >= cfg.generationAt) return false;

  return true;
}

function hasCurrentReloadIdleSource(s: Session): boolean {
  const harness = harnessFor(s.agent);
  if (harness.skills?.reloadIdleSource !== "transcript") return true;
  return harness.transcript?.locate(s) !== null;
}

export function reloadOwed(s: Session, acks: Map<string, number>, cfg: SkillsConfig): boolean {
  return reloadOwedBase(s, acks, cfg) && hasCurrentReloadIdleSource(s);
}

/** Whether one session is owed a reload AND is ready for it right now. */
export function reloadNeeded(
  s: Session,
  acks: Map<string, number>,
  cfg: SkillsConfig,
  now: number,
  settleMs = SETTLE_MS,
): boolean {
  if (!reloadOwedBase(s, acks, cfg)) return false;

  // `settledIdle` and NOT `reportBucket(s) === "idle"`: idle is that function's
  // catch-all fallthrough, so it's true for UNINSTRUMENTED sessions, where idleness is
  // a default rather than a report. `settledIdle` insists on `state === "idle"`, a claim
  // only ever made by a real source - a fresh hook OR the transcript-derived passive
  // state - so it holds for a healthy session whose hook merely lapsed (the transcript
  // still proves it parked) while refusing the `working` rebuild default. It's the one
  // transient gate here, which is why it isn't in `reloadOwed`.
  if (!settledIdle(s, now, settleMs)) return false;
  return hasCurrentReloadIdleSource(s);
}

/** A session's acked generation. Absent and 0 mean the same thing: never acked. */
function ackOf(s: Session, acks: Map<string, number>): number {
  return acks.get(noteKeyFor(s)) ?? 0;
}

/**
 * How many live skill-loading sessions are owed a reload - the panel's "N sessions will
 * pick this up when they next go idle".
 *
 * The selector's predicate minus the settle gate, SHARED rather than restated: the
 * count and the loop must agree on who is owed a reload, or the panel promises a
 * pick-up that never comes. A session that is merely busy is owed one and the human
 * should be told so; a session nothing can ever reload is not, and must not be counted.
 */
export function pendingReloads(sessions: Session[], acks: Map<string, number>, cfg: SkillsConfig): number {
  if (cfg.generation === 0) return 0;
  return sessions.filter((s) => reloadOwed(s, acks, cfg)).length;
}

/**
 * The side effects a reload performs, injectable so the ordering below can be
 * asserted without a tmux pane. Mirrors `KillDeps` in actions.ts, and for the same reason: the ORDER of these three calls is the safety argument, and an
 * argument no test can see is one that quietly stops being true.
 */
export interface ReloadDeps {
  readModeLine: (s: Session) => Promise<PaneModeLine | null>;
  inject: (s: Session, text: string) => Promise<InjectResult>;
  ack: (noteKey: string, generation: number) => void;
}

const defaultReloadDeps: ReloadDeps = {
  readModeLine: readPaneModeLine,
  inject: injectPrompt,
  ack: setSkillsAck,
};

/**
 * Type `/reload-skills` into one session, if it is genuinely at its prompt.
 *
 * THE ENTER KEY IS THE WHOLE PROBLEM. `injectPrompt` sends Enter unconditionally, and
 * a Claude dialog is a SELECT LIST, not a text prompt: the pasted text is swallowed
 * and the Enter activates whichever option is highlighted. Fired across every
 * session, that is an unattended answer to a permission prompt nobody read, in every
 * pane at once.
 *
 * This is not hypothetical. It happened on the first attempt at the probe that proved
 * this feature works. A freshly spawned claude in an unfamiliar directory does not
 * open at its prompt - it opens on:
 *
 *     Quick safety check: Is this a project you created or one you trust?
 *     ❯ 1. Yes, I trust this folder
 *       2. No, exit
 *
 * The probe pasted its text and would have pressed Enter into that list, answering
 * "Yes, I trust this folder" on the operator's behalf. It only escaped because a
 * readiness check didn't match and it timed out instead. So the pane read is not
 * paperwork, and it is the LAST gate rather than a filter - it costs a subprocess.
 *
 * `readPaneModeLine` is the check, and it already means exactly this: a dialog or menu
 * replaces Claude's footer entirely, so a mode line on screen IS the evidence that no
 * dialog is up. `setPermissionMode` has drawn that same inference since it shipped.
 * Its one false negative - a pre-2.1.203 claude sitting in `manual`, which drew no
 * line - fails CLOSED: that session never reloads, which is a skill that doesn't
 * arrive, not a button pressed by a machine.
 */
export async function reloadOne(
  session: Session,
  generation: number,
  prior: number,
  deps: ReloadDeps = defaultReloadDeps,
): Promise<boolean> {
  // Re-asked here rather than assumed from the selector, because this is the boundary the
  // KEYSTROKE crosses: `reloadOwed` runs against a snapshot, and the command about to be
  // typed has to come from the harness of the session actually in hand.
  //
  // The same clause `reloadOwed` opens with, restated rather than trusted, and it is
  // one clause and not two: a harness with a skills directory but no reload command
  // (Codex, which watches its own) is owed NOTHING here. Its skills are installed by
  // `reconcileSkillLinks`, which walks every harness's directory, and it notices them
  // by itself. Acking a generation for it instead would record a reload that never
  // happened - and since `reloadOwed` refuses these sessions upstream, an ack branch
  // here is unreachable code that reads like a live one.
  const harness = harnessFor(session.agent);
  const skills = harness.skills;
  if (!skills?.reloadCommand) return false;

  if (!hasCurrentReloadIdleSource(session)) return false;
  if (harness.tui?.modeLine) {
    const line = await deps.readModeLine(session);
    if (!line) return false;
  }

  // Ack BEFORE typing, mirroring the auto-wrapup path: the write that retires the
  // action lands before the act, so a crash in between costs a reload rather than
  // repeating one.
  //
  // Where this deliberately parts company with that path is the rollback below.
  // Auto-wrapup's rule is "never retry", and its reason - "a retry IS the
  // double-push", because `/no-mistakes` opens a PR - is exactly what does NOT
  // transfer: `/reload-skills` does not push, does not commit, and re-reading a
  // directory twice reaches the same answer. So the two failures point opposite ways.
  // For the wrap-up, silence beats a duplicate. Here, a duplicate costs two lines of
  // transcript while a silent miss is the panel claiming a skill is live in a session
  // that never heard about it - which is precisely the "toggle that silently no-ops"
  // failure the plan disqualified codex over.
  deps.ack(noteKeyFor(session), generation);
  const sent = await deps.inject(session, skills.reloadCommand);
  if (sent.ok) {
    // Nobody asked for this one - the dashboard typed it because a skill changed on
    // disk. Say so, or the conversation log shows the human interrupting their agent
    // with a slash command they've never heard of.
    recordInjection(session.id, skills.reloadCommand, "harness");
    return true;
  }

  // `pasted: false` is the codebase's one definition of positive evidence that
  // nothing reached the pane (the lock refused, or tmux rejected the target before
  // writing). Only then is the ack a lie worth taking back. `pasted: true` means the
  // text IS in the pane and only the Enter failed - retrying would paste a second
  // copy after the first and mangle a prompt, so that ack stands.
  if (!sent.pasted) deps.ack(noteKeyFor(session), prior);
  return false;
}

/**
 * Drive the reload broadcast on the discovery poll's interval.
 *
 * Its own timer rather than a callback bolted onto `startPoller`, matching the three
 * sibling pollers (nomistakes, pr, runtime-meta) - discovery's tick is about sweeping
 * the OS, and threading an unrelated concern through it buys nothing. What the plan
 * actually wanted from "ride the poller" is kept: the same interval constant (no new
 * knob to tune), and a per-target re-read rather than a fan-out from one snapshot.
 * The re-read is the load-bearing half - see `tick`.
 *
 * Ticks never overlap: a slow sweep just delays the next one.
 */
export function startSkillsReloader(registry: Registry): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const cfg = getSkillsConfig();
      const acks = getSkillsAcks();
      const targets = reloadTargets(registry.snapshot().sessions, acks, cfg, Date.now());

      // Concurrent, like `annotatePaneState` - which already spawns a
      // capture-pane per claude session on every 1.5s discovery tick, so this is a
      // shape the dashboard is known to tolerate. Serially, one unreachable pane's 1s
      // capture timeout would delay every session behind it.
      await Promise.all(
        targets.map(async (t) => {
          // Re-resolve against the live registry before acting. The snapshot above is
          // already a second old by the time a capture-pane returns, and deciding
          // from it reads a long-dead `idle` against a fresh `now`, which makes
          // `settledIdle` trivially true and types into an agent that went back to
          // work. A session that vanished decides nothing: skip and re-decide next
          // tick. Same rule the queue worker's per-target re-read exists for.
          const fresh = registry.getSession(t.id);
          if (!fresh) return;
          if (!reloadNeeded(fresh, acks, cfg, Date.now())) return;
          await reloadOne(fresh, cfg.generation, acks.get(noteKeyFor(fresh)) ?? 0);
        }),
      );
    } catch (err) {
      console.error("[skills] reload sweep failed:", err);
    }
    if (stopped) return;
    timer = unref(setTimeout(tick, POLL_INTERVAL_MS));
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
