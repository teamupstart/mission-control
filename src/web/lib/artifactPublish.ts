import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import { messageBlockReason, type Messageable } from "@shared/pane.ts";
import type { AgentType } from "@shared/types.ts";

/**
 * Whether the Files tab's Publish control can ask this session to publish this file, and
 * the exact turn it would send.
 *
 * Every refusal is a sentence, because the control is drawn on every harness and every file
 * and a disabled button with no reason is the one a person cannot act on. The order is the
 * order a person can fix them in: nothing about the file matters on a harness that cannot
 * publish, the file type matters before the session's state, and saving is the last step.
 */
export type ArtifactPublishState =
  | { ok: true; label: string; prompt: string }
  | { ok: false; label: string; reason: string };

const BLOCK_REASON: Record<NonNullable<ReturnType<typeof messageBlockReason>>, string> = {
  pipeline: "A workflow engine drives this session, so it cannot take a publish request",
  "no-pane": "This session has no pane to send a publish request to",
};

function listed(extensions: readonly string[]): string {
  if (extensions.length <= 1) return extensions.join("");
  return `${extensions.slice(0, -1).join(", ")} and ${extensions.at(-1)}`;
}

export function artifactPublishState(
  session: Messageable & { agent: AgentType },
  path: string | null,
  unsaved: boolean,
): ArtifactPublishState {
  const spec = capabilitiesFor(session.agent).artifactPublishing;
  if (!spec.publishes) return { ok: false, label: "artifact", reason: spec.unavailable };
  const { label } = spec;
  if (!path) return { ok: false, label, reason: `Open a file to publish it as a ${label}` };
  const lower = path.toLowerCase();
  if (!spec.sourceExtensions.some((extension) => lower.endsWith(extension))) {
    return {
      ok: false,
      label,
      reason: `Only ${listed(spec.sourceExtensions)} files can be published as a ${label}`,
    };
  }
  const block = messageBlockReason(session);
  if (block) return { ok: false, label, reason: BLOCK_REASON[block] };
  if (unsaved) {
    return {
      ok: false,
      label,
      reason: "Save this file first, so the published page is the file on disk",
    };
  }
  return { ok: true, label, prompt: spec.prompt(path) };
}
