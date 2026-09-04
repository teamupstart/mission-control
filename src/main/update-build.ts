// The half of an update that does not need the app to be gone.
//
// `install-app.mjs --stage-only` fetches, builds, and verifies the new version inside the
// updater-owned clone and stops one step short of the installed app. That is where all the
// minutes are, and running it from the LIVE app - rather than from the detached helper after
// the quit - is what puts a progress bar in front of the person instead of a closed window
// and a two-minute silence. The swap still belongs to the helper, and still takes seconds.

import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  isUpdatePrepareStage,
  parseUpdateProgressLine,
  type UpdatePrepareStage,
} from "../shared/update-stages.mjs";
import { loginShellPath } from "../server/util/path-env.ts";
import { sanitizeLogLine } from "./update-log.ts";

/**
 * How long the staged build may run before it is treated as hung.
 *
 * Matches the detached helper's own bound, because it is the same `npm ci` plus Electron
 * package doing the same work; only the audience changed. A person watching the bar can also
 * cancel, which is the difference that matters in practice - this is the backstop for the
 * cases where nobody is watching at all.
 */
export const STAGE_TIMEOUT_MS = 45 * 60 * 1000;

/**
 * Preserve the user's CLI PATH for a child that has to find git, npm, and node.
 *
 * Shared by the staged build and the detached helper: Electron's own environment is not the
 * login shell's, and both children run the same tools for the same reason.
 */
export function updateChildEnvironment(
  current: NodeJS.ProcessEnv = process.env,
  path: string = loginShellPath(),
): NodeJS.ProcessEnv {
  return { ...current, PATH: path };
}

export interface StagedBuild {
  version: string;
  bundlePath: string;
}

export type StageFailureReason =
  /** The clone's install script predates `--stage-only`, so the caller must build the old way. */
  | "unsupported"
  | "cancelled"
  | "failed";

export type StageOutcome =
  | { ok: true; staged: StagedBuild }
  | { ok: false; reason: StageFailureReason; message: string };

export interface StageRequest {
  /** A system Node.js binary; Electron's own executable cannot run npm. */
  node: string;
  sourceClone: string;
  targetTag: string;
  signal: AbortSignal;
  onStage(stage: UpdatePrepareStage): void;
  log(line: string): void;
  timeoutMs?: number;
}

export function stageScriptPath(sourceClone: string): string {
  return join(sourceClone, "scripts", "install-app.mjs");
}

export function stageInstallArgs(script: string, targetTag: string): string[] {
  // No `--apps-dir`: a staged build never touches an installed app, so the directory it would
  // eventually go into is the helper's business and not this run's.
  return [script, "--ref", targetTag, "--stage-only", "--progress"];
}

/**
 * Whether this clone's install script is too old to stage.
 *
 * The script that runs is the one checked out in the updater-owned clone, which is the
 * version currently installed - normally the same release as the running app, but not
 * necessarily, because `--ref` can install any ref. An install script without `--stage-only`
 * says so in exactly these words, and the caller then falls back to the single-shot handoff
 * that has always worked, rather than reporting an update failure the person cannot act on.
 */
export function stagingUnsupported(output: string): boolean {
  // `(?![-\w])` rather than `\b`, so a flag that merely STARTS with one of these names - the
  // sort of thing a future release might add - is not read as this one missing.
  return /unknown argument: --(?:stage-only|progress)(?![-\w])/.test(output);
}

/**
 * Run the staged build to completion, reporting each stage as the script reaches it.
 *
 * Every line of the child's output goes to the update log, because npm and electron-builder
 * failures are only ever diagnosable from their own words. Only the two marker lines mean
 * anything structurally.
 */
export function stageUpdateBuild(request: StageRequest): Promise<StageOutcome> {
  const script = stageScriptPath(request.sourceClone);
  const timeoutMs = request.timeoutMs ?? STAGE_TIMEOUT_MS;

  return new Promise<StageOutcome>((resolve) => {
    if (request.signal.aborted) {
      resolve({ ok: false, reason: "cancelled", message: "The update was cancelled." });
      return;
    }

    let staged: StagedBuild | null = null;
    let settled = false;
    // Bounded on purpose: this exists to tell a missing flag apart from a broken build, and a
    // full electron-builder log in memory would serve neither. Redacted, like the logged copy:
    // an argument-parsing complaint survives redaction untouched, so nothing this reads is
    // lost by holding the safe form.
    const tail: string[] = [];
    let child: ReturnType<typeof spawn> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;

    const settle = (outcome: StageOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    /**
     * Kill the whole process group, not just the script.
     *
     * The script's own children are npm and electron-builder, and they are what actually hold
     * the CPU. Killing the parent alone would leave them running in the clone that the next
     * attempt is about to check out - the collision the detached helper documents at length.
     */
    const killGroup = (): void => {
      const pid = child?.pid;
      if (!pid) return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child?.kill("SIGKILL");
        } catch {
          // The child is already gone, which is the state this wanted.
        }
      }
    };

    function onAbort(): void {
      killGroup();
      settle({ ok: false, reason: "cancelled", message: "The update was cancelled." });
    }

    const consume = (line: string): void => {
      const trimmed = line.replace(/\s+$/, "");
      if (!trimmed) return;
      // Redacted HERE, where content this process did not write enters the log pipeline, and
      // not only in whatever logger the caller injected. `npm` and `electron-builder` print
      // absolute paths as a matter of course, and a registry line can carry a credential;
      // this is the only update channel whose text comes from outside. The rotating logger
      // applies the same rule again on its way to disk, which is safe because
      // `sanitizeLogLine` is idempotent over its own output - and the redundancy is the
      // point: neither side can be the one place that forgets.
      //
      // Only the logged copy is redacted. Parsing below reads `trimmed`, because the staged
      // marker's whole payload is an absolute bundle path that redaction would replace with
      // `<path>`.
      const redacted = sanitizeLogLine(trimmed);
      request.log(redacted);
      if (tail.length >= 40) tail.shift();
      tail.push(redacted);
      const marker = parseUpdateProgressLine(trimmed);
      if (!marker) return;
      if (marker.kind === "stage") {
        // A stage the bar does not draw - `install`, `receipt`, or one a future release adds -
        // is logged and ignored rather than mapped onto the wrong step.
        if (isUpdatePrepareStage(marker.stage)) request.onStage(marker.stage);
        return;
      }
      staged = { version: marker.version, bundlePath: marker.bundlePath };
    };

    /** Line-buffered, because a marker split across two chunks is not a marker. */
    const reader = (): ((chunk: Buffer | string) => void) => {
      let buffer = "";
      return (chunk) => {
        buffer += String(chunk);
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          consume(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
        }
        // A very long line with no newline in sight is output, not a marker; flush it so the
        // log keeps up and the buffer cannot grow without bound.
        if (buffer.length > 8192) {
          consume(buffer);
          buffer = "";
        }
      };
    };

    try {
      child = spawn(request.node, stageInstallArgs(script, request.targetTag), {
        cwd: request.sourceClone,
        // Its own process group, so cancelling can take the npm and electron-builder children
        // with it - killing this script alone would leave them holding the clone. The cost of
        // a group of its own is that the group survives an abnormal end of this app, so the
        // controller aborts on quit; a build orphaned by a crash writes only inside the clone
        // and installs nothing.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: updateChildEnvironment(),
      });
    } catch (error) {
      settle({
        ok: false,
        reason: "failed",
        message: `The update could not be built: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    request.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", reader());
    child.stderr?.on("data", reader());

    timer = setTimeout(() => {
      timedOut = true;
      request.log(`the staged build passed its ${Math.round(timeoutMs / 60_000)} minute limit`);
      killGroup();
    }, timeoutMs);
    timer.unref?.();

    child.once("error", (error) => {
      settle({
        ok: false,
        reason: "failed",
        message: `The update could not be built: ${error.message}`,
      });
    });

    child.once("close", (code) => {
      if (request.signal.aborted) {
        settle({ ok: false, reason: "cancelled", message: "The update was cancelled." });
        return;
      }
      if (timedOut) {
        settle({
          ok: false,
          reason: "failed",
          message: `The update build did not finish within ${Math.round(timeoutMs / 60_000)} minutes and was stopped.`,
        });
        return;
      }
      const output = tail.join("\n");
      if (stagingUnsupported(output)) {
        settle({
          ok: false,
          reason: "unsupported",
          message: "This installed version cannot build the update in the background.",
        });
        return;
      }
      if (code !== 0) {
        settle({
          ok: false,
          reason: "failed",
          message: `The update build failed (exit ${code ?? 1}). Check the update log and try again.`,
        });
        return;
      }
      if (!staged) {
        settle({
          ok: false,
          reason: "failed",
          message: "The update build finished without reporting an app to install.",
        });
        return;
      }
      settle({ ok: true, staged });
    });
  });
}
