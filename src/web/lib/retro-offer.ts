import type { RetroReason, Session } from "@shared/types.ts";
import type { WorkflowRunSummary } from "@shared/workflow.ts";
import { inspectorChipView } from "../components/session-bits.tsx";

// WHEN the dashboard offers a retro, said once for every surface that offers one.
//
// The source plan picked the moment: "after the PR exists and the Inspector's findings are
// all addressed". By then the session holds everything worth remembering - the coding, the
// human's corrections, and the findings-and-fixes cycle - and the branch is usually still
// open, so approved memories ride the same pull request through normal review.
//
// Three surfaces render this and one of them has no workflow run in scope, so the predicate
// takes the run as an OPTION rather than as its subject. That shape is also what makes the
// answer the same everywhere: an offer that appeared on the Board tile's ladder and not on
// the console footer beside it would read as a bug in whichever one you looked at second.
//
// The offer only ever PROPOSES. Every path from here is a button; nothing in the daemon
// delivers a retro on its own (`src/server/skills/reload.ts` documents why a second
// autonomous pane-writer is not something this codebase adds).

/** A ready-to-render offer: what the control says, and why it is being offered. */
export interface RetroOffer {
  label: string;
  tooltip: string;
  /** Non-empty. Ordered as the daemon ordered them; drives the tooltip's second sentence. */
  reasons: RetroReason[];
}

const WHAT_IT_DOES =
  "Ask this session to review its own transcript and propose up to 3 repository memories."
  + " You approve or reject each one, and nothing is written or committed until you do.";

/**
 * Why this session is worth retrospecting, in one clause.
 *
 * Falls back to the plain sentence for a reason this build does not recognise rather than
 * dropping it: `RetroReason` is display vocabulary the daemon may extend, and a newer daemon's
 * reason arriving at an older dashboard must still explain the offer it is attached to.
 */
function because(reasons: RetroReason[]): string {
  const clauses = reasons.map((reason): string | null =>
    reason === "corrections"
      ? "you corrected it during the work"
      : reason === "findings"
        ? "the Inspector raised findings that were then resolved"
        : null,
  ).filter((clause): clause is string => clause !== null);
  return clauses.length > 0
    ? `Offered because ${clauses.join(", and ")}.`
    : "Offered because this session has something worth cataloguing.";
}

/**
 * Whether the Inspector has finished with this session's pull request and found nothing left.
 *
 * Reads the CHIP rather than the summary's raw counts, so "clean" means here exactly what the
 * chip means by it on the same card - including the dry-run case, which is clean by the same
 * rule and where the operator chose not to post. A second spelling of the rule is how the
 * offer eventually starts disagreeing with the chip sitting next to it.
 *
 * A null summary is not clean: the Inspector only adopts pull requests it can prove Mission
 * Control opened, so no chip means nothing here reviewed anything.
 */
function inspectorClean(session: Session): boolean {
  return inspectorChipView(session.inspector)?.tone === "insp-clean";
}

/**
 * The retro offer for a session, or null when the moment has not arrived.
 *
 * Two ways the moment can arrive, and it is a disjunction rather than a preference:
 *
 *  - The bound run's Inspector gate reads `clean`, which is precisely "adopted pull request,
 *    reviewed head equals target head, zero unresolved findings". The strongest form of the
 *    predicate, and the one the source plan named.
 *  - The session's own Inspector chip reads clean. This is what covers a session with no
 *    workflow at all, and it is also the auto-merge backstop: a pull request that merges
 *    before the gate clears leaves the RUN blocked on `inspector_pr_closed`, while the
 *    session's own review outcome is unchanged and still says the findings were addressed.
 *
 * Deliberately NOT "the run is bound, so ignore the chip". That reading would withdraw the
 * offer at exactly the moment the plan wanted it kept.
 */
export function retroOffer(
  session: Session,
  run: WorkflowRunSummary | null,
): RetroOffer | null {
  const reasons = session.retro?.reasons ?? [];
  if (reasons.length === 0) return null;
  if (run?.gate !== "clean" && !inspectorClean(session)) return null;
  return {
    label: "Run retro",
    tooltip: `${WHAT_IT_DOES} ${because(reasons)}`,
    reasons,
  };
}

/**
 * The Complete-flow backstop: the same offer with the timing condition dropped.
 *
 * A session that never opened a pull request never satisfies either arm above, and Complete
 * is the last moment anybody is looking at it - so the plan puts the offer there too, under
 * the worthiness condition alone. It is a secondary action in a dialog the operator opened
 * on purpose, not a prompt competing for attention on a card, which is what makes the weaker
 * condition the right one in that one place.
 */
export function retroBackstopOffer(session: Session): RetroOffer | null {
  const reasons = session.retro?.reasons ?? [];
  if (reasons.length === 0) return null;
  return {
    label: "Run a retro first",
    tooltip: `${WHAT_IT_DOES} ${because(reasons)} The task stays open and this session stays`
      + " alive so it can answer.",
    reasons,
  };
}

/**
 * One retro request, and the session it is about.
 *
 * Keyed by SESSION and not by run, because that is what `POST /api/sessions/:id/retro` takes.
 * The surface that holds this state is a per-RUN panel, so without the key it belonged to
 * neither: cleared on a run change it dropped the answer to a click the operator had just
 * made and re-enabled a button whose second press sends a second retro into the same pane;
 * left alone it outlived whatever the panel had moved on to.
 */
export interface RetroCall {
  sessionId: string;
  status: "sending" | "sent" | "failed";
  /** The outcome sentence once settled; null while sending. */
  message: string | null;
}

/** What a surface should draw for its own session, given whatever call is on record. */
export interface RetroCallView {
  /** A request is in flight FOR THIS SESSION, so the control reads "Sending…" and refuses. */
  sending: boolean;
  /** A settled success worth stating - typed into the session, or filed as a task. */
  notice: string | null;
  /** A settled refusal, in the daemon's own words. */
  error: string | null;
}

/**
 * Narrow a recorded call to the session actually being rendered.
 *
 * The one place the scoping rule lives, and a pure function rather than three ternaries at
 * the render site, because the defect this replaces was invisible in exactly that shape: a
 * boolean that no longer named its subject. Everything here is "only if it is mine".
 */
export function retroCallView(
  call: RetroCall | null | undefined,
  sessionId: string | null | undefined,
): RetroCallView {
  const mine = call && sessionId && call.sessionId === sessionId ? call : null;
  return {
    sending: mine?.status === "sending",
    notice: mine?.status === "sent" ? mine.message : null,
    error: mine?.status === "failed" ? mine.message : null,
  };
}

/** What the daemon's two success arms mean to the person who clicked, in one line each. */
export function retroOutcome(result: { kind?: string }): string {
  return result.kind === "dispatched"
    ? "This session can no longer be typed into, so a retro task was filed in the backlog."
    : "Retro sent - the session will propose memories for you to approve.";
}
