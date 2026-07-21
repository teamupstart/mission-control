import { AGENT_TYPES } from "@shared/types.ts";
import type { AgentType, Session } from "@shared/types.ts";
import { HARNESS_CAPABILITIES } from "@shared/harness-capabilities.ts";
import { envVar } from "@shared/harness-runtime.mjs";
import type {
  ControlSpec,
  Harness,
  HookSpec,
  TranscriptMessages,
  TranscriptSpec,
} from "./types.ts";
import { claudeHooks } from "./claude/hooks.ts";
import { claudeTranscript } from "./claude/transcript.ts";
import { claudeDetect } from "./claude/detect.ts";
import { claudeBin } from "./claude/bin.ts";
import { claudeControl } from "./claude/control.ts";
import { codexTranscript } from "./codex/transcript.ts";
import { codexDetect } from "./codex/detect.ts";
import { codexBin } from "./codex/bin.ts";
import { codexControl } from "./codex/control.ts";

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
// Server-side, because a spec reads the filesystem or a wire payload. The capabilities
// that DON'T - permission modes, skills, the work queue, context clearing, MCP
// registration - live in `@shared/harness-capabilities.ts`, because the dashboard has to
// answer them in the browser, and are spread in below. So this record forces the decisions
// that need a `node:` import (what a harness records on disk, and how it pushes its
// lifecycle at us) and the shared one forces the rest; neither is a copy of the other, and
// `Harness extends HarnessCapabilities` means a call site holding a harness still reads
// every slot off one object. Naming still comes from `@shared/agent.ts`.
//
// Test: `session-contracts.test.ts` pins both records, `harness-transcript.test.ts` and
// `harness-capabilities.test.ts` pin the degradations.

export const HARNESSES: Record<AgentType, Harness> = {
  claude: {
    ...HARNESS_CAPABILITIES.claude,
    transcript: claudeTranscript,
    hooks: claudeHooks,
    detect: claudeDetect,
    bin: claudeBin,
    control: claudeControl,
  },
  // `hooks: null` is a statement, not a gap: Codex pushes nothing at us, so a Codex card
  // is read passively (discovery, and whatever the rollout says) and the dispatcher does
  // not spend 20s waiting for a first hook. `todo/codex-instrumentation.md` has the spike
  // that would change this answer - a Codex-native hook reporting session id, rollout
  // path, cwd and lifecycle - and it lands here, as a spec, not as a second pipeline.
  codex: {
    ...HARNESS_CAPABILITIES.codex,
    transcript: codexTranscript,
    hooks: null,
    detect: codexDetect,
    bin: codexBin,
    control: codexControl,
  },
};

/** The harness for an agent. Total by construction - the Record cannot have a hole. */
export function harnessFor(agent: AgentType): Harness {
  return HARNESSES[agent];
}

/**
 * Resolve the CLI to run for a harness: the `MISSION_`/`FLEET_`/`HARNESS_` chain first,
 * then any legacy names the harness still honours, then its own fallback command.
 *
 * THE one resolver, for both of the things that spawn an agent CLI - a dispatched session
 * (`dispatcher.ts`) and a headless `claude -p` (`claude-cli.ts`, which read a second,
 * differently-ordered chain of its own). Two resolvers meant an operator pointing
 * `MISSION_CLAUDE_BIN` at a wrapper got it in one path and not the other, with no error
 * either way. Resolution lives here rather than in `config.ts` because the spec is the
 * harness's; what `config.ts` kept was the map, which is what let the two drift.
 *
 * An empty value counts as unset throughout: `MISSION_CLAUDE_BIN=` is an operator clearing
 * an override, not a request to spawn "". Test: `harness-bin.test.ts`.
 */
export function resolveAgentBin(agent: AgentType): string {
  const spec = HARNESSES[agent].bin;
  const chain = envVar(spec.env);
  if (chain) return chain;
  for (const name of spec.legacyEnv) {
    const legacy = process.env[name];
    if (legacy) return legacy;
  }
  return spec.command;
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

/**
 * How a turn reaches this session's agent. Never null - every harness declares a delivery.
 *
 * A function rather than a field read at each call site so that the delivery path asks the
 * SESSION how to talk to it, not the other way around: `injectPrompt` is generic over
 * harnesses and must not grow a branch naming one.
 */
export function controlFor(session: Session): ControlSpec {
  return HARNESSES[session.agent].control;
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
