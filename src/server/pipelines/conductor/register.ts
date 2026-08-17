import type { PipelineRepoRegistrationResult } from "@shared/pipeline.ts";

import { resolveBinPath, run, type RunResult } from "../../util/exec.ts";
import { conductorBin } from "./probe.ts";

const REGISTER_TIMEOUT_MS = 10_000;
const REGISTER_MAX_BUFFER = 16 * 1024;
const MAX_DISPLAY_CHARS = 4_000;

interface RegisterDeps {
  resolveBinPath(bin: string): Promise<string | null>;
  run(
    bin: string,
    args: string[],
    opts: { timeoutMs: number; maxBuffer: number; cwd: string },
  ): Promise<RunResult>;
}

const DEFAULT_DEPS: RegisterDeps = { resolveBinPath, run };

function clipped(value: string): string {
  const text = value.trim();
  return text.length <= MAX_DISPLAY_CHARS ? text : `${text.slice(0, MAX_DISPLAY_CHARS - 1)}…`;
}

function outputOf(result: RunResult): string {
  return clipped([result.stdout, result.stderr].filter(Boolean).join("\n"));
}

/**
 * Register one repository through Conductor's CLI and confirm the exact root in its reply.
 *
 * Exit zero is not sufficient: Conductor has commands that print usage and exit cleanly. The
 * provider therefore owns the output grammar, while its caller only acts on this total result.
 */
export async function registerConductorRepo(
  repoRoot: string,
  deps: RegisterDeps = DEFAULT_DEPS,
): Promise<PipelineRepoRegistrationResult> {
  const refused = (detail: string, output = ""): PipelineRepoRegistrationResult => ({
    ok: false,
    provider: "ai-conductor",
    repoRoot,
    detail,
    output: clipped(output),
  });

  try {
    const configured = conductorBin();
    const bin = await deps.resolveBinPath(configured);
    if (!bin) return refused(`${configured} is not on this daemon's PATH`);

    const result = await deps.run(bin, ["register", repoRoot], {
      timeoutMs: REGISTER_TIMEOUT_MS,
      maxBuffer: REGISTER_MAX_BUFFER,
      cwd: repoRoot,
    });
    const output = outputOf(result);
    if (result.outcomeUnknown) {
      return refused("Conductor registration timed out before it confirmed the result.", output);
    }
    if (result.overflowed) {
      return refused("Conductor registration produced too much output to confirm safely.", output);
    }
    if (result.code !== 0) {
      return refused(`Conductor registration exited with code ${result.code ?? "unknown"}.`, output);
    }

    const confirmation = result.stdout.trim();
    const match = /^Registered (.+) \((.*)\)\.$/.exec(confirmation);
    if (!match || match[1]!.trim() === "" || match[2] !== repoRoot) {
      return refused("Conductor exited cleanly without confirming this exact repository.", output);
    }

    return {
      ok: true,
      provider: "ai-conductor",
      repoRoot,
      detail: `Registered ${match[1]} with Conductor.`,
      output: "",
    };
  } catch (error) {
    return refused(error instanceof Error ? error.message : "Conductor registration failed.");
  }
}
