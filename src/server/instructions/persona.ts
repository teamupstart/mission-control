import type { PipelineLaunchRuntime } from "@shared/pipeline.ts";
import type { AgentType, SessionRuntime } from "@shared/types.ts";
import type { StandingInstructionsDelivery } from "@shared/standing-instructions.ts";
import type { Persona } from "@shared/workflow.ts";
import { appendStandingSections } from "./compose.ts";

// A dispatch Persona: the Library Persona an ordinary task names, delivered as part of the
// launch's standing instructions.
//
// It rides the SAME channel the repository rules do - `--append-system-prompt` on Claude in a
// terminal, `systemPrompt.append` in the Agent SDK, developer instructions on Codex, a turn-one
// prefix where a pair has no channel of its own - so the agent reads it before the first turn
// and a resume replays the snapshot the launch recorded. A resident's Persona is not this: it
// is composed by the resident launch contributors from its profile's pinned snapshot.

/** Reads any Persona the Library can name, built-in or authored, or null. */
export type PersonaLookup = (id: string) => Persona | null;

/** The heading the Persona section of the standing instructions opens with. */
export const TASK_PERSONA_HEADING = "## Persona";

/**
 * The Persona a task names, or why it cannot be launched with it.
 *
 * One answer for the three moments that ask: creating the task, editing it, and launching it.
 * An archived or deleted Persona is refused rather than skipped, because a task launched
 * without the role the operator chose for it would read as the Persona having been delivered.
 */
export function resolveTaskPersona(
  lookup: PersonaLookup | undefined,
  personaId: string,
): { ok: true; persona: Persona } | { ok: false; error: string } {
  if (!lookup) {
    return { ok: false, error: "this daemon cannot read Personas, so it cannot launch a task with one" };
  }
  const persona = lookup(personaId);
  if (!persona) return { ok: false, error: "the selected Persona no longer exists" };
  if (persona.archivedAt !== null) return { ok: false, error: `the Persona ${persona.name} is archived` };
  return { ok: true, persona };
}

/**
 * The Persona's section: its name as the heading, then its guidance as written.
 *
 * Only blank lines before the guidance and whitespace after it are dropped, because the heading
 * and separators supply those. Leading indentation is content - a guidance that opens with an
 * indented code block is still a code block - so the guidance is never trimmed from the left.
 */
export function taskPersonaSection(persona: Pick<Persona, "name" | "guidanceMarkdown">): string {
  const heading = `${TASK_PERSONA_HEADING}: ${persona.name}`;
  const guidance = persona.guidanceMarkdown.replace(/^(?:[ \t]*\r?\n)+/u, "").trimEnd();
  return guidance ? `${heading}\n\n${guidance}` : heading;
}

/**
 * The launch's standing instructions with the Persona section appended.
 *
 * After the repository block, for the reason a resident's role follows it: the operator's rules
 * for the checkout read first, and the role that works inside them follows.
 */
export function withTaskPersona(
  repository: StandingInstructionsDelivery,
  persona: Pick<Persona, "name" | "guidanceMarkdown">,
  agent: AgentType,
  runtime: SessionRuntime,
): StandingInstructionsDelivery {
  return appendStandingSections(repository, [taskPersonaSection(persona)], agent, runtime);
}

/** A launch whose repositories contribute no standing instructions. Fresh each time. */
function noStandingInstructions(): StandingInstructionsDelivery {
  return { text: "", mechanism: "none", sources: [] };
}

/**
 * What a Pipeline Engineer host is sent as standing instructions, for the launch and for the
 * Dispatch preview alike, so the two cannot describe different launches.
 *
 * Repository standing instructions are not part of a Pipeline launch. The managed Agent SDK host
 * takes the dispatch Persona alone, on its own channel. The Terminal host is Conductor's CLI with
 * no channel for instructions: it gets none, and the dispatcher refuses a Terminal launch whose
 * task carries a Persona.
 */
export function pipelineHostStanding(
  persona: Pick<Persona, "name" | "guidanceMarkdown"> | null,
  agent: AgentType,
  launchRuntime: PipelineLaunchRuntime,
): StandingInstructionsDelivery {
  return persona && launchRuntime === "agent-sdk"
    ? withTaskPersona(noStandingInstructions(), persona, agent, "sdk")
    : noStandingInstructions();
}
