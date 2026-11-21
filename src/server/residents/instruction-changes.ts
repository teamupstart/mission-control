import type { PlanDecisionAnswer, ReviewActor, ReviewItem, Session } from "@shared/types.ts";
import type { Persona } from "@shared/workflow.ts";
import { WORKFLOW_LIMITS } from "@shared/workflow.ts";
import {
  RESIDENT_LIMITS,
  ResidentProfileRevisionSchema,
  residentRoleProblem,
  type ResidentProfile,
  type ResidentRun,
} from "@shared/residents.ts";
import {
  RESIDENT_INSTRUCTION_DECISION_ID,
  applyResidentInstructionChanges,
  locateResidentInstructionChanges,
  residentInstructionOptionId,
  residentInstructionOutcomeText,
  residentInstructionQuestion,
  type ProposeResidentInstructionChanges,
  type ResidentInstructionChange,
  type ResidentInstructionOutcome,
  type ResidentInstructionOutcomeChange,
  type ResidentInstructionTarget,
  type ResidentInstructionsView,
} from "@shared/resident-instructions.ts";
import { requestInputReview } from "@shared/request-input.ts";
import { inputQuestionProblem } from "@shared/protocol.ts";
import { openDb } from "../db.ts";
import type { ReviewAction } from "../reviews.ts";
import { getResidentProfile, residentRunForTask, updateResidentProfile } from "./store.ts";

// A resident proposes changes to its own standing instructions; the operator decides which land.
//
// The approval is the daemon's to enforce, not the agent's. A resident reads untrusted text all
// day, so a tool that rewrote its standing role on the agent's say-so would let any page it read
// rewrite who it is. Instead the proposal is stored beside a review the daemon opens itself, and
// only a PERSON's answer to that review applies it - inside the same transaction that records the
// answer, so the outcome and the resolution can never disagree, and an answer that arrives after
// the agent's MCP call has timed out still lands. Foreman and session-control answers are refused
// before anything is written.
//
// Writes go through the stores the editors use: the profile as its next revision, compare-and-set
// on the revision the proposal was made against, and the Persona the same way. A running resident
// keeps its pinned revision; `Restart on new profile` is how it adopts the edit.

export interface InstructionRefusal {
  status: 400 | 403 | 404 | 409;
  error: string;
}

export interface PersonaGuidanceWrite {
  ok: boolean;
  persona?: Persona;
  reason?: string;
}

export interface ResidentInstructionDeps {
  registry: {
    getReview(id: string): ReviewItem | undefined;
    upsertResidentProfile(profile: ResidentProfile): void;
  };
  reviews: {
    create(
      sessionId: string,
      kind: ReviewItem["kind"],
      title: string,
      body: string,
      decisions: ReviewItem["decisions"],
    ): ReviewItem;
  };
  /** Any Persona the Library can name, built-in or authored, or null. */
  persona(id: string): Persona | null;
  /** Compare-and-set a Persona's guidance, joining the caller's transaction. Publishes nothing. */
  writePersonaGuidance(id: string, expectedRevision: number, guidance: string, at: number): PersonaGuidanceWrite;
  /** Announce a committed Persona write. */
  publishPersona(persona: Persona): void;
  now?: () => number;
}

interface ProposalRow {
  review_id: string;
  session_id: string;
  run_id: string;
  profile_id: string;
  profile_revision: number;
  persona_id: string | null;
  persona_revision: number | null;
  proposal: string;
  created_at: number;
  outcome: string | null;
  settled_at: number | null;
}

interface ResidentContext {
  run: ResidentRun;
  profile: ResidentProfile;
  persona: Persona | null;
  refusals: Record<ResidentInstructionTarget, string | null>;
}

/** The pieces of a review resolution the resolve route threads through `ReviewManager`. */
export type InstructionResolution =
  | { refusal: InstructionRefusal }
  | { persist: () => void; publish: () => void };

function proposalRow(reviewId: string): ProposalRow | null {
  return (openDb()
    .prepare("SELECT * FROM resident_instruction_proposals WHERE review_id = ?")
    .get(reviewId) as ProposalRow | undefined) ?? null;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export class ResidentInstructionChanges {
  private readonly now: () => number;

  constructor(private readonly deps: ResidentInstructionDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The resident this session runs, with why each target can or cannot take an edit. */
  private context(session: Session): ResidentContext | InstructionRefusal {
    if (session.task?.kind !== "resident") {
      return { status: 409, error: "This session is not a resident, so it has no standing instructions to edit." };
    }
    const stored = residentRunForTask(session.task.id);
    if (!stored) return { status: 409, error: "This resident's run record is unavailable." };
    const profile = getResidentProfile(stored.run.profileId);
    if (!profile) return { status: 409, error: "This resident's profile no longer exists." };
    const personaId = profile.settings.persona.personaId;
    const persona = personaId ? this.deps.persona(personaId) : null;
    const profileRefusal = profile.builtin
      ? `${profile.name} is a built-in resident that ships with Mission Control, so its profile cannot be edited. The operator can choose Duplicate on the Residents page to make an editable copy.`
      : profile.archivedAt !== null
        ? `The profile ${profile.name} is archived.`
        : null;
    const personaRefusal = !personaId
      ? "This profile names no Persona. Propose a profile instruction instead."
      : !persona
        ? "The Persona this profile names no longer exists."
        : persona.builtin
          ? `The Persona ${persona.name} ships with Mission Control and cannot be edited. Propose a profile instruction instead.`
          : persona.archivedAt !== null
            ? `The Persona ${persona.name} is archived.`
            : null;
    return { run: stored.run, profile, persona, refusals: { profile: profileRefusal, persona: personaRefusal } };
  }

  read(session: Session): ResidentInstructionsView | InstructionRefusal {
    const context = this.context(session);
    if ("error" in context) return context;
    const { profile, persona, run, refusals } = context;
    return {
      profile: {
        id: profile.id,
        name: profile.name,
        revision: profile.revision,
        builtin: profile.builtin === true,
        instructions: profile.settings.instructions.markdown,
      },
      persona: persona
        ? { id: persona.id, name: persona.name, revision: persona.revision, builtin: persona.builtin, guidance: persona.guidanceMarkdown }
        : null,
      runProfileRevision: run.profileRevision,
      refusals,
    };
  }

  /**
   * Validate a proposal against the CURRENT texts, ask it as a `request_input` question, and store it.
   *
   * Refused whole, before any review exists, when a change cannot apply as written: the operator
   * is only ever shown changes every subset of which applies.
   */
  propose(session: Session, input: ProposeResidentInstructionChanges): { reviewId: string } | InstructionRefusal {
    const context = this.context(session);
    if ("error" in context) return context;
    const { profile, persona, run, refusals } = context;
    for (const [index, change] of input.changes.entries()) {
      const refusal = refusals[change.target];
      if (refusal) return { status: 409, error: `Change ${index + 1} ("${change.title}") edits the ${change.target}: ${refusal}` };
    }
    const problem = this.subsetProblem(input.changes, profile, persona);
    if (problem) return { status: 400, error: problem };

    // Asked as a `request_input` question, built exactly as the `request_input` tool builds one:
    // the operator selects the changes on the same card every other agent question uses.
    const question = residentInstructionQuestion({
      profileName: profile.name,
      profileRevision: profile.revision,
      personaName: persona?.name ?? null,
      summary: input.summary,
      changes: input.changes,
    });
    const unanswerable = inputQuestionProblem(question.question, question.options);
    if (unanswerable) return { status: 400, error: `Not proposed: ${unanswerable}.` };
    const ask = requestInputReview(question);
    const review = this.deps.reviews.create(session.id, ask.kind, ask.title, ask.body, ask.decisions ?? null);
    // An identical ask from the same session re-attaches to the open review, and the question names
    // the profile revision, so a re-attached review is always the same proposal: keep the first row.
    openDb()
      .prepare(
        `INSERT OR IGNORE INTO resident_instruction_proposals
          (review_id, session_id, run_id, profile_id, profile_revision, persona_id, persona_revision, proposal, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        review.id,
        session.id,
        run.id,
        profile.id,
        profile.revision,
        persona?.id ?? null,
        persona?.revision ?? null,
        JSON.stringify(input),
        this.now(),
      );
    return { reviewId: review.id };
  }

  /**
   * Why some subset of these changes could not be written, or null.
   *
   * Every passage must locate in the text it edits, and the largest text any subset can produce
   * (every growing change applied) must fit the target's limit. A subset that empties a role is
   * caught again when it is applied, because that one depends on which changes were picked.
   */
  private subsetProblem(
    changes: readonly ResidentInstructionChange[],
    profile: ResidentProfile,
    persona: Persona | null,
  ): string | null {
    // Each target is measured in the unit its limit counts: profile instructions in characters,
    // Persona guidance in UTF-8 bytes. A change "grows" when it adds to that measure, so a
    // replacement of the same character length can still grow guidance by bytes.
    const targets: Array<{
      target: ResidentInstructionTarget;
      text: string;
      size: (text: string) => number;
      fits: (worst: string) => string | null;
    }> = [
      {
        target: "profile",
        text: profile.settings.instructions.markdown,
        size: (text) => text.length,
        fits: (worst) => worst.length > RESIDENT_LIMITS.instructionsLength
          ? `Applying every growing change would take the profile instructions past ${RESIDENT_LIMITS.instructionsLength} characters; shorten the proposal.`
          : null,
      },
      {
        target: "persona",
        text: persona?.guidanceMarkdown ?? "",
        size: utf8Bytes,
        fits: (worst) => utf8Bytes(worst) > WORKFLOW_LIMITS.personaGuidanceBytes
          ? `Applying every growing change would take the Persona guidance past ${WORKFLOW_LIMITS.personaGuidanceBytes} UTF-8 bytes; shorten the proposal.`
          : null,
      },
    ];
    for (const { target, text, size, fits } of targets) {
      const mine = changes
        .map((change, index) => ({ ...change, index }))
        .filter((change) => change.target === target);
      if (mine.length === 0) continue;
      const located = locateResidentInstructionChanges(text, mine);
      if (!located.ok) return `Not proposed: ${located.problem}.`;
      const growing = located.located.filter((change) =>
        change.range === null || size(change.replace) > size(text.slice(change.range.start, change.range.end)));
      const problem = fits(applyResidentInstructionChanges(text, growing));
      if (problem) return `Not proposed: ${problem}`;
    }
    return null;
  }

  /**
   * How the resolve route settles a review that carries a proposal, or null for any other review.
   *
   * `persist` runs inside the transaction that writes the review's status, so the edits, the
   * recorded outcome and the answer commit together or not at all. `publish` announces the
   * written revisions once that transaction has committed.
   */
  resolution(
    reviewId: string,
    action: ReviewAction,
    by: ReviewActor,
    selections: PlanDecisionAnswer[] | null,
  ): InstructionResolution | null {
    const row = proposalRow(reviewId);
    if (!row || row.outcome !== null) return null;
    if (this.deps.registry.getReview(reviewId)?.status !== "pending") return null;
    if (action !== "dismiss" && by !== "human") {
      return {
        refusal: {
          status: 403,
          error: "Only the operator can approve changes to a resident's standing instructions.",
        },
      };
    }
    const announcements: Array<() => void> = [];
    return {
      persist: () => {
        const outcome = this.settle(row, action, selections, announcements);
        openDb()
          .prepare("UPDATE resident_instruction_proposals SET outcome = ?, settled_at = ? WHERE review_id = ? AND outcome IS NULL")
          .run(JSON.stringify(outcome), this.now(), reviewId);
      },
      publish: () => {
        for (const announce of announcements) announce();
      },
    };
  }

  /** Decide, and when approved write, what the human's answer means for this proposal. */
  private settle(
    row: ProposalRow,
    action: ReviewAction,
    selections: PlanDecisionAnswer[] | null,
    announcements: Array<() => void>,
  ): ResidentInstructionOutcome {
    const proposal = JSON.parse(row.proposal) as ProposeResidentInstructionChanges;
    const all: ResidentInstructionOutcomeChange[] = proposal.changes.map((change, index) => ({
      index,
      title: change.title,
      target: change.target,
    }));
    const base = { reviewId: row.review_id, applied: [], skipped: all, profileRevision: null, personaRevision: null, feedback: null };
    if (action !== "answer") {
      return { ...base, status: "dismissed", message: "The operator dismissed the proposal, so nothing was changed. Do not propose these changes again unless they ask." };
    }
    const answer = selections?.find((selection) => selection.decisionId === RESIDENT_INSTRUCTION_DECISION_ID);
    if (answer?.chat) {
      return { ...base, status: "chat", message: "The operator moved this proposal to the conversation, so nothing was changed. Discuss it there; do not decide it or propose it again until they ask." };
    }
    const feedback = [answer?.other, answer?.note].filter((text): text is string => Boolean(text?.trim())).join("\n\n") || null;
    const chosen = new Set(answer?.selected ?? []);
    const selected = all.filter((change) => chosen.has(residentInstructionOptionId(change.index)));
    const skipped = all.filter((change) => !chosen.has(residentInstructionOptionId(change.index)));
    if (selected.length === 0) {
      return {
        ...base,
        feedback,
        status: "none_selected",
        message: feedback
          ? "The operator applied none of the proposed changes and left guidance for a revised proposal."
          : "The operator applied none of the proposed changes, so nothing was changed.",
      };
    }
    const refused = (status: "stale" | "refused", message: string): ResidentInstructionOutcome =>
      ({ ...base, feedback, status, message });

    const touches = (target: ResidentInstructionTarget) => selected.some((change) => change.target === target);
    const profile = getResidentProfile(row.profile_id);
    if (!profile) return refused("refused", "The profile no longer exists, so nothing was changed.");
    let nextProfileText: string | null = null;
    if (touches("profile")) {
      if (profile.builtin || profile.archivedAt !== null) {
        return refused("refused", `The profile ${profile.name} can no longer be edited, so nothing was changed.`);
      }
      if (profile.revision !== row.profile_revision) {
        return refused("stale", `The profile ${profile.name} changed after this was proposed (now revision ${profile.revision}), so nothing was changed. Read the instructions again and propose against the current text.`);
      }
      nextProfileText = this.applySelected(profile.settings.instructions.markdown, proposal.changes, selected, "profile");
    }
    let persona: Persona | null = null;
    let nextGuidance: string | null = null;
    if (touches("persona")) {
      // A Persona change is the resident's only while its profile still names that Persona. A
      // profile switched to another Persona, or to none, makes the proposal stale even when its
      // own revision check is skipped because no profile change was selected.
      if (profile.settings.persona.personaId !== row.persona_id) {
        return refused("stale", `The profile ${profile.name} no longer names the Persona this was proposed for, so nothing was changed. Read the instructions again and propose against the current Persona.`);
      }
      persona = row.persona_id ? this.deps.persona(row.persona_id) : null;
      if (!persona || persona.builtin || persona.archivedAt !== null) {
        return refused("refused", "The Persona can no longer be edited, so nothing was changed.");
      }
      if (persona.revision !== row.persona_revision) {
        return refused("stale", `The Persona ${persona.name} changed after this was proposed (now revision ${persona.revision}), so nothing was changed. Read the instructions again and propose against the current text.`);
      }
      nextGuidance = this.applySelected(persona.guidanceMarkdown, proposal.changes, selected, "persona");
    }

    // Validate the exact results before writing either one, so a refusal writes nothing.
    let nextSettings: ResidentProfile["settings"] | null = null;
    if (nextProfileText !== null) {
      const parsed = ResidentProfileRevisionSchema.safeParse({
        ...profile.settings,
        instructions: { ...profile.settings.instructions, markdown: nextProfileText },
      });
      if (!parsed.success) {
        return refused("refused", `The selected changes would make the profile invalid (${parsed.error.issues[0]?.message ?? "invalid"}), so nothing was changed.`);
      }
      const role = residentRoleProblem(parsed.data);
      if (role) return refused("refused", `The selected changes would leave the resident with no role (${role}), so nothing was changed.`);
      nextSettings = parsed.data;
    }
    if (nextGuidance !== null) {
      if (!nextGuidance.trim()) return refused("refused", "The selected changes would empty the Persona's guidance, so nothing was changed.");
      if (utf8Bytes(nextGuidance) > WORKFLOW_LIMITS.personaGuidanceBytes) {
        return refused("refused", `The selected changes would take the Persona guidance past ${WORKFLOW_LIMITS.personaGuidanceBytes} UTF-8 bytes, so nothing was changed.`);
      }
    }

    const at = this.now();
    let personaRevision: number | null = null;
    if (persona && nextGuidance !== null) {
      const written = this.deps.writePersonaGuidance(persona.id, persona.revision, nextGuidance, at);
      if (!written.ok || !written.persona) {
        return refused("refused", `The Persona ${persona.name} could not be updated (${written.reason ?? "refused"}), so nothing was changed.`);
      }
      const committed = written.persona;
      personaRevision = committed.revision;
      announcements.push(() => this.deps.publishPersona(committed));
    }
    let profileRevision: number | null = null;
    if (nextSettings !== null) {
      const write = updateResidentProfile({ id: profile.id, expectedRevision: profile.revision, settings: nextSettings, at });
      // Every refusal this can return was ruled out above, inside the same transaction. Throwing
      // rolls back the Persona write with it, and leaves the review pending for another answer.
      if (write.status !== "ok") throw new Error(`the profile write was refused (${write.status}) after it was validated`);
      profileRevision = write.profile.revision;
      announcements.push(() => this.deps.registry.upsertResidentProfile(write.profile));
    }

    const landed = [
      profileRevision !== null ? `${profile.name} is now at profile revision ${profileRevision}` : null,
      personaRevision !== null && persona ? `the Persona ${persona.name} is now at revision ${personaRevision}` : null,
    ].filter((part): part is string => part !== null);
    return {
      reviewId: row.review_id,
      status: "applied",
      applied: selected,
      skipped,
      profileRevision,
      personaRevision,
      feedback,
      message: `Applied ${plural(selected.length, "change")}: ${landed.join(", and ")}. `
        + "This running session keeps the instructions it launched with until the operator chooses Restart on new profile.",
    };
  }

  private applySelected(
    text: string,
    changes: readonly ResidentInstructionChange[],
    selected: readonly ResidentInstructionOutcomeChange[],
    target: ResidentInstructionTarget,
  ): string {
    const mine = selected
      .filter((change) => change.target === target)
      .map((change) => ({ ...changes[change.index]!, index: change.index }));
    const located = locateResidentInstructionChanges(text, mine);
    // The revision is unchanged since the proposal located every passage, so this cannot fail.
    if (!located.ok) throw new Error(`a validated proposal no longer locates: ${located.problem}`);
    return applyResidentInstructionChanges(text, located.located);
  }

  /**
   * What the answer did, for the continuation a detached wait receives. Null for any review that
   * carries no proposal, or one whose answer recorded no outcome.
   */
  continuationNote(reviewId: string): string | null {
    const outcome = proposalRow(reviewId)?.outcome;
    if (!outcome) return null;
    return `What Mission Control did with your proposed instruction changes:\n${residentInstructionOutcomeText(JSON.parse(outcome) as ResidentInstructionOutcome)}`;
  }

  /** What became of a proposal this session made, read after its review settled. */
  outcome(session: Session, reviewId: string): ResidentInstructionOutcome | InstructionRefusal {
    const row = proposalRow(reviewId);
    const review = this.deps.registry.getReview(reviewId);
    // A runtime transfer moves a pending review to its successor session; either side may ask.
    if (!row || (row.session_id !== session.id && review?.sessionId !== session.id)) {
      return { status: 404, error: "No proposal by that review id belongs to this session." };
    }
    if (row.outcome) return JSON.parse(row.outcome) as ResidentInstructionOutcome;
    const proposal = JSON.parse(row.proposal) as ProposeResidentInstructionChanges;
    const all = proposal.changes.map((change, index) => ({ index, title: change.title, target: change.target }));
    const base = { reviewId, applied: [], skipped: all, profileRevision: null, personaRevision: null, feedback: null };
    if (!review || review.status === "pending") {
      return { ...base, status: "pending", message: "The operator has not answered yet. Their selection is applied when they do." };
    }
    if (review.status === "orphaned") {
      return { ...base, status: "orphaned", message: "The review closed because this session went away before the operator answered, so nothing was changed." };
    }
    return { ...base, status: "dismissed", message: "The review was settled without an answer that applies changes, so nothing was changed." };
  }
}
