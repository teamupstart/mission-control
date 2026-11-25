import { isAbsolute } from "node:path";
import { z } from "zod";
import { VOICE_BACKENDS, VOICE_MODEL_STATUSES, VOICE_MODES, VoiceRevisionSchema } from "../shared/voice.ts";

// Only these daemon fields drive the native listener and tray. Other event families,
// including roster-only updates, have no consumer in this shell.
export const ShellVoiceStateSchema = z.object({
  mode: z.enum(VOICE_MODES),
  modeVersion: VoiceRevisionSchema.optional(),
  pushToTalkSession: z.uuid().optional(),
  configuredHotkey: z.string().nullable().optional(),
  pendingHotkey: z.string().optional(),
  pendingHotkeyId: z.uuid().optional(),
  recordingHotkey: z.literal(true).optional(),
  recordingHotkeyId: z.uuid().optional(),
  capabilities: z.object({listener: z.object({reason: z.string().nullable(), code: z.string().optional()}).optional()}).optional(),
  speech: z.object({job: z.object({id: z.string(), state: z.string()}).nullable()}).optional(),
  muted: z.boolean().optional(),
  model: z.object({
    status: z.enum(VOICE_MODEL_STATUSES),
    backend: z.enum(VOICE_BACKENDS).nullable(),
    directory: z.string().refine(path => isAbsolute(path) && !path.includes("\0")).nullable(),
  }).refine(model => model.status !== "ready" || (model.directory !== null && model.backend !== null)),
});
export type ShellVoiceState = z.infer<typeof ShellVoiceStateSchema>;
