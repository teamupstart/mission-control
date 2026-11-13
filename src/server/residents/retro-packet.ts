// The instruction a resident's retrospective types into its own conversation.
//
// A memory retro's procedure lives in the retro skill, because its one hard rule - nothing is
// written a human did not approve - is enforced only by the agent following it. A resident's
// retro needs no skill: its only write is `propose_resident_instruction_changes`, and the daemon
// applies nothing a person did not select. So the procedure travels in the packet itself, and the
// retro works whether or not any skill is switched on.

export const RESIDENT_RETRO_ACTION_NAME = "Resident retro";

/** The packet's first sentence. The e2e fake agent recognizes a delivered retro by it. */
export const RESIDENT_RETRO_LEAD =
  "Run a retrospective over your work as this resident, and turn what the operator taught you into proposed changes to your standing instructions.";

export const RESIDENT_RETRO_PROMPT = [
  RESIDENT_RETRO_LEAD,
  "",
  "1. Read your conversation back rather than relying on memory, which compaction has trimmed:",
  "   `curl -s \"http://127.0.0.1:${MISSION_PORT:-7317}/api/sessions/<session-id>/transcript?turns=200\"`,",
  "   using the session id above.",
  "2. Find the steering: every turn where the operator corrected you, redirected you, set a new rule,",
  "   or agreed a new way of working with you. Mission Control's own wake prompts are not steering.",
  "3. Call `get_resident_instructions` for the exact current text of your profile instructions and",
  "   your Persona's guidance. Do not restate a rule that is already there.",
  "4. Decide where each lesson belongs. How THIS resident should work goes in the profile. Only",
  "   guidance every user of the Persona should follow goes in the Persona. When unsure, use the",
  "   profile.",
  "5. Call `propose_resident_instruction_changes` once, with at most five changes. Replace or remove",
  "   one exact passage, or append a new one. Give each a short title and, in `rationale`, the",
  "   conversation evidence for it. Prefer one precise sentence over a paragraph.",
  "6. The operator selects which changes to apply, and Mission Control writes only those. When the",
  "   tool returns, say in one short message what was applied and what was not. If they left",
  "   guidance, follow it with one revised proposal at most. Never edit files or settings to make a",
  "   change yourself.",
  "",
  "If nothing in the conversation warrants a change, or neither your profile nor your Persona can be",
  "edited, say so in one message and do not call the tool. This retro changes only what future",
  "launches read: this session keeps its instructions until the operator chooses Restart on new",
  "profile.",
].join("\n");
