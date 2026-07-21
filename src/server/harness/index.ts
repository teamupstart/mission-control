import { AGENT_TYPES } from "@shared/types.ts";
import type { AgentType, Session } from "@shared/types.ts";
import type { Harness, HookSpec, TranscriptMessages, TranscriptSpec } from "./types.ts";
import { claudeHooks } from "./claude/hooks.ts";
import { claudeTranscript } from "./claude/transcript.ts";
import { codexTranscript } from "./codex/transcript.ts";

// The registry of agent harnesses. Extend this; do not start a parallel list.
//
// `Record<AgentType, Harness>` is the enforcement mechanism, the same one `LLM_RUNNERS`
// and `SESSION_FIELD_COMPARATORS` use: adding an id to `AGENT_TYPES` and stopping there
// does not compile. Every capability then has to be either implemented or explicitly
// declared `null`, so "I forgot transcripts existed" stops being a possible outcome for
// the next harness - which is exactly how Codex ended up with capabilities that silently
// did nothing.
//
// Not to be confused with `src/server/harnesses.ts`, which is the settings blob behind the
// Harnesses panel - operator choices, not capabilities.
//
// Server-side, because a spec reads the filesystem. What the web bundle needs about an
// agent it gets from `@shared/agent.ts` (names) and `@shared/goal.ts` (what a card says
// when a capability is absent). Test: `session-contracts.test.ts` pins the record,
// `harness-transcript.test.ts` pins the degradation.

export const HARNESSES: Record<AgentType, Harness> = {
  claude: { id: "claude", transcript: claudeTranscript, hooks: claudeHooks },
  // `hooks: null` is a statement, not a gap: Codex pushes nothing at us, so a Codex card
  // is read passively (discovery, and whatever the rollout says) and the dispatcher does
  // not spend 20s waiting for a first hook. `todo/codex-instrumentation.md` has the spike
  // that would change this answer - a Codex-native hook reporting session id, rollout
  // path, cwd and lifecycle - and it lands here, as a spec, not as a second pipeline.
  codex: { id: "codex", transcript: codexTranscript, hooks: null },
};

/** The harness for an agent. Total by construction - the Record cannot have a hole. */
export function harnessFor(agent: AgentType): Harness {
  return HARNESSES[agent];
}

/** Every harness, in declaration order. For anything enumerating agents. */
export function allHarnesses(): Harness[] {
  return AGENT_TYPES.map((id) => HARNESSES[id]);
}

/** A session's transcript capability, or null when its harness records nothing readable. */
export function transcriptFor(session: Session): TranscriptSpec | null {
  return HARNESSES[session.agent].transcript;
}

/**
 * An agent's push-instrumentation capability, or null when it pushes nothing.
 *
 * Null is what every hook-shaped caller degrades on: the ingest is refused rather than
 * interpreted by another agent's vocabulary, and the dispatcher skips a wait for a
 * signal that is never coming. Ask this rather than `agent === "claude"`, which says
 * nothing about why.
 */
export function hooksFor(agent: AgentType): HookSpec | null {
  return HARNESSES[agent].hooks;
}

/** A located file and the capability that can read its CONVERSATION. */
export interface SessionMessages {
  read: TranscriptMessages;
  path: string;
}

/**
 * The way to read a session's turns: the message capability plus the file it applies to,
 * or null when there is nothing to read.
 *
 * One helper rather than a `locate` at each call site, because null has three causes that
 * every caller degrades the same way - the harness keeps no record, it keeps one with no
 * messages in it (Codex), or it has not written the file yet - and a call site that
 * checked only the last of those is how a capability-less harness gets a directory walk
 * and an empty array instead of its declared "unavailable".
 *
 * Order matters: the capability is checked BEFORE the file is located, so a harness that
 * cannot answer never pays for the search.
 */
export function sessionMessages(session: Session): SessionMessages | null {
  const spec = transcriptFor(session);
  if (!spec?.messages) return null;
  const path = spec.locate(session);
  return path ? { read: spec.messages, path } : null;
}
