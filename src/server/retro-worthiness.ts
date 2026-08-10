import type { RetroReason, RetroSummary, Session, TranscriptMessage } from "@shared/types.ts";
import { envVar } from "./config.ts";
import { sessionMessages } from "./harness/index.ts";
import type { Registry } from "./registry.ts";
import { attributeTranscript } from "./transcript-attribution.ts";
import { unref } from "./util/timers.ts";

// Whether a session has anything worth retrospecting, computed here and pushed onto the
// Session so every surface that offers a retro reads one answer.
//
// Two independent halves, because the two reasons cost completely different things to know:
//
//  - FINDINGS is free. The Inspector's ledger row already carries `resolvedFindings`, the
//    registry already holds those rows to build the inspector chip, and both are recomputed
//    on the same events. So that half lives in the registry beside `inspectorSummaryFor`
//    and needs nothing from this file but `retroSummary`.
//  - CORRECTIONS costs a file read. It is a fact about the TRANSCRIPT, which no other part
//    of the daemon summarises per session, so it is polled - and everything below exists to
//    make that poll cost approximately nothing in the steady state.
//
// Three properties do that, in increasing order of how much they save:
//
//  1. STICKY. A correction that happened cannot un-happen, so a session that has flipped is
//     never read again - not even stat'd. The scan state is deleted outright.
//  2. INCREMENTAL. A transcript is append-only, so after the first pass each poll reads only
//     the bytes appended since the last one (`appended`), which is usually zero - and it
//     advances over exactly what it consumed, so nothing can be stepped over unread.
//  3. GUARDED BY SIZE. `size` is one `stat`; an unchanged file costs that and nothing else.
//
// What the first pass reads is deliberately different from every pass after it. It uses the
// head+tail `window` rather than `since(path, 0)`, because the question is "is there a human
// turn BEYOND the opening brief" and `since` reads from the tail: on a long transcript it
// would miss the opening entirely, take a correction for the brief, and undercount by one.
// The head slice is what makes the brief reliably present.

/** How often to look for new human turns (ms). One `stat` per unflipped live session. */
const RETRO_SCAN_MS = Number(envVar("RETRO_SCAN_MS") ?? 10_000);

/** Opening turns the first pass reads, so the session's own brief is always in the window. */
const SCAN_HEAD_TURNS = 12;
/** Recent turns the first pass reads. */
const SCAN_TAIL_TURNS = 48;

/**
 * The summary for a session, or null when neither reason holds.
 *
 * Pure, and the ONE place the two halves are combined, so the registry cannot decide the
 * question differently from a test. Reason order is fixed rather than incidental:
 * `corrections` first because it is the stronger argument for a retrospective - somebody had
 * to intervene - and because a stable order keeps the rendered tooltip stable.
 */
export function retroSummary(input: {
  corrections: boolean;
  resolvedFindings: number;
}): RetroSummary | null {
  const reasons: RetroReason[] = [];
  if (input.corrections) reasons.push("corrections");
  if (input.resolvedFindings > 0) reasons.push("findings");
  return reasons.length > 0 ? { reasons } : null;
}

/**
 * A turn's identity for the purposes of "have I already counted this one".
 *
 * TEXT ALONE, and every other candidate was tried and is wrong:
 *
 *  - NOT the message id. Ids are stable for a harness whose records carry one (Claude's
 *    record uuid) and synthesized per parse batch for one whose records do not (the Codex
 *    rollout), so an id-keyed count double-counts on exactly the harness where two reads can
 *    overlap.
 *  - NOT text plus the timestamp, which is what this shipped as first. It looks strictly
 *    safer and is strictly weaker: `ts` is the turn's real epoch time, so a human who resends
 *    the SAME instruction later - a nudge after nothing happened - gets a different print
 *    purely because the clock moved, and the offer lights. That is the false positive this
 *    whole predicate exists to avoid, and it made the paragraph below a claim the code did
 *    not honour.
 *
 * Overlap is the problem being solved, and it is not hypothetical: `size` is read before
 * `since`, and `since` reads to the file's CURRENT end, so a turn written in that window is
 * returned by this pass and again by the next. Counting it twice would make one human turn
 * look like two and light the offer on a session nobody ever corrected. Text alone settles it
 * completely - an overlapping re-read is the same on-disk record, so its text is identical by
 * construction - and it needs no separator, no escape, and no assumption about `ts`.
 *
 * The cost is real and is accepted: two identical human turns read as one, so a verbatim
 * resend is not a correction. That is the right way to be wrong here - repeating yourself is
 * a nudge, and the safe direction for a prompt that spends a session's turn is to under-offer.
 *
 * The slice is the pre-existing bound on how much of a turn is compared; two different turns
 * sharing a 200-character prefix collapse, which costs the same under-offer.
 */
function turnPrint(message: TranscriptMessage): string {
  return message.text.slice(0, 200);
}

/** Per-session scan state. Present only while the session has NOT flipped. */
interface CorrectionScan {
  /**
   * The transcript this state describes. A `/clear` mints a new conversation and a new file;
   * carrying a byte offset across that would seek past the whole new transcript.
   */
  path: string;
  /** Bytes already scanned. The next pass reads forward from here. */
  offset: number;
  /** The first human turn seen - the session's opening brief, whoever supplied it. */
  opening: string | null;
}

export interface RetroCorrectionScanner {
  /**
   * Whether this session's transcript now shows a human turn beyond its opening brief.
   *
   * `false` means "not as far as this has read", never "definitely not": the window is
   * bounded and attribution is best-effort (`originOf` is in-memory, so a daemon restart
   * loses it). Both errors point the same way - toward not offering - which is the safe
   * direction for a prompt that spends a session's turn.
   */
  advance(session: Session): boolean;
  /** Drop scan state for sessions that are gone, so a long-lived daemon does not accrete it. */
  retain(liveIds: ReadonlySet<string>): void;
}

export function createRetroCorrectionScanner(): RetroCorrectionScanner {
  const scans = new Map<string, CorrectionScan>();
  /** Sessions already known to carry corrections. Never read from disk again. */
  const flipped = new Set<string>();

  const advance = (session: Session): boolean => {
    if (flipped.has(session.id)) return true;
    const located = sessionMessages(session);
    // A harness that keeps no conversation (Codex kept none for years) is not evidence of
    // no corrections - it is evidence of nothing, which is what `false` says here.
    if (!located) return false;

    const size = located.read.size(located.path);
    if (size === null) return false;

    let scan = scans.get(session.id);
    if (!scan || scan.path !== located.path) {
      scan = { path: located.path, offset: 0, opening: null };
      scans.set(session.id, scan);
    } else if (size === scan.offset) {
      return false; // nothing appended since the last pass: one `stat`, no read
    } else if (size < scan.offset) {
      // The file shrank, so it was rewritten under us. The offset names a byte that no
      // longer exists; start over rather than seek into the middle of a record.
      scan.offset = 0;
      scan.opening = null;
    }

    let messages: TranscriptMessage[];
    try {
      if (scan.offset === 0) {
        messages = located.read.window(located.path, SCAN_HEAD_TURNS, SCAN_TAIL_TURNS).messages;
        // The window is head+tail, so there is no honest byte boundary to resume from -
        // its own middle may be elided. Resuming at EOF is what that costs, and it is the
        // documented gap: a correction in an elided middle is missed on a cold start.
        scan.offset = size;
      } else {
        // `appended`, NOT `since`, and the difference is permanent data loss rather than
        // taste. `since` is TAIL-anchored: past 512KB or 48 turns it drops the PREFIX of
        // the range and says so with `truncated`. Advancing the offset past a dropped
        // prefix - which is what reading `size` here used to do - means the turns in it are
        // never read on this pass and can never be read on any later one, because the
        // offset has already moved beyond them. A busy session that appends fifty turns
        // between two ticks would silently lose the correction sitting at the front of them.
        //
        // `appended` reads every complete record from the offset and reports the boundary
        // it actually reached, so the scan advances over exactly what it consumed. The
        // partial trailing line a writer is mid-way through is left for the next pass
        // rather than skipped, which `size` also got wrong.
        //
        // The read is bounded by what one session wrote since the last tick rather than by
        // a byte cap, and that is the right trade here: a cap that skipped bytes would
        // reintroduce the loss, the delta is small on any ordinary tick, and a session that
        // has already flipped is never read again at all.
        const read = located.read.appended(located.path, scan.offset);
        messages = read.messages;
        scan.offset = read.pos;
      }
    } catch {
      return false; // an unreadable transcript is not a session without corrections
    }

    // Attribution first, and it is load-bearing rather than tidy: the daemon types into
    // sessions itself - workflow repair packets, `/reload-skills`, and the retro packet this
    // very offer delivers - and every one of those is a `user` record on disk. Counted as
    // human they would make the offer self-fulfilling: deliver a retro, and the session it
    // was delivered to becomes retro-worthy.
    for (const message of attributeTranscript(session.id, messages)) {
      if (message.role !== "user" || message.origin !== undefined || !message.text.trim()) continue;
      const print = turnPrint(message);
      if (scan.opening === null) {
        scan.opening = print;
        continue;
      }
      if (print === scan.opening) continue;
      flipped.add(session.id);
      scans.delete(session.id);
      return true;
    }
    return false;
  };

  return {
    advance,
    retain: (liveIds) => {
      for (const id of scans.keys()) if (!liveIds.has(id)) scans.delete(id);
      for (const id of flipped) if (!liveIds.has(id)) flipped.delete(id);
    },
  };
}

/**
 * Poll live sessions for the corrections half and hand every flip to the registry.
 *
 * Its own timer rather than a sixth reader bolted onto the runtime-meta poll: that loop is
 * declared as "the highest-authority passive source for a session's model, effort and context",
 * reads one file per session for all five of its facts, and runs at a cadence chosen for a
 * live status meter. This asks a different question of a different read, needs no cadence at
 * all once a session has flipped, and is the kind of thing an operator should be able to slow
 * down or switch off without touching the meter.
 *
 * `retain` is scoped to LIVE sessions, while the registry's own flag is scoped to the session
 * ROW. That asymmetry is deliberate: an exited session lingers on the board and can still be
 * offered a retro (the route files a task for it), so the answer must outlive the scanning.
 *
 * The tick alone is NOT enough, and the gap it leaves is the reason `onSessionExit` is
 * subscribed below. `liveSessions()` excludes anything already `exited`, and a session is
 * removed outright `EXIT_LINGER_MS` (8s) later - shorter than this poll's own default
 * interval. So a human whose LAST message was the correction, on a one-shot dispatch that
 * then finished, would have that correction read by nothing: the session leaves the live set
 * before the next tick and is deleted before any later one. It would lose the corrections
 * reason permanently and silently, which is precisely the case the offer is most for.
 *
 * The exit hook closes it deterministically rather than by shortening the interval, which
 * would only have narrowed the race. One last scan on the transition, while the row and the
 * transcript are both still there.
 */
export function startRetroWorthinessPoller(
  registry: Registry,
  scanner: RetroCorrectionScanner = createRetroCorrectionScanner(),
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** One scan, with the registry told only when the answer is yes. Never throws. */
  const scan = (session: Session): void => {
    try {
      if (scanner.advance(session)) registry.recordRetroCorrections(session.id);
    } catch (err) {
      console.error("[retro] worthiness scan failed:", err);
    }
  };

  const tick = (): void => {
    if (stopped) return;
    try {
      const live = registry.liveSessions();
      for (const session of live) scan(session);
      scanner.retain(new Set(live.map((session) => session.id)));
    } catch (err) {
      console.error("[retro] worthiness scan failed:", err);
    }
    if (stopped) return;
    timer = unref(setTimeout(tick, RETRO_SCAN_MS));
  };

  // The last chance to read this session's transcript, taken before `retain` can drop its
  // scan state on the next tick. Cheap by construction: everything up to the previous tick
  // has already been consumed, so this reads only what was appended since - usually the one
  // turn that made the session worth retrospecting in the first place.
  const stopExitScan = registry.onSessionExit(scan);

  // Off entirely at 0, the same switch `MISSION_POLL_MS` offers - a daemon whose operator
  // does not want transcripts scanned still gets the findings half, which costs nothing.
  // The exit hook goes with it: "off" has to mean no transcript is read, not "read fewer".
  if (RETRO_SCAN_MS <= 0) {
    stopExitScan();
    return () => {};
  }
  void tick();
  return () => {
    stopped = true;
    stopExitScan();
    if (timer) clearTimeout(timer);
  };
}
