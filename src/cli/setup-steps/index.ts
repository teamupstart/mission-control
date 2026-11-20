import * as agents from "./agents.ts";
import * as codex from "./codex.ts";
import * as daemon from "./daemon.ts";
import * as doctor from "./doctor.ts";
import * as flag from "./flag.ts";
import * as mod from "./mod.ts";
import type { SetupStep } from "./types.ts";

export type { SetupStep, SetupStepId, SetupStepOptions, SetupStepResult } from "./types.ts";

/**
 * The ordered steps of `mctl setup` (spec 7.14), one file each. After P2 only P14 edits this
 * file; P7 replaces `codex.ts` and P15 replaces `agents.ts`. A stub has `implemented: false`
 * and the runner skips it.
 */
export const SETUP_STEPS: readonly SetupStep[] = [daemon, flag, mod, agents, codex, doctor];
