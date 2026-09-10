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
import { executableChildEnv } from "../server/executables/locator.ts";
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
 * How long a cancelled build is given to actually be gone.
 *
 * SIGKILL cannot be caught, so this is not a grace period - it is the wait for the group's
 * `close`, which arrives only once every process holding the output pipes has exited. That is
 * precisely the condition the caller needs: `npm` and `electron-builder` write into the shared
 * clone, and the next preparation force-checks-out and reinstalls in that same directory. A
 * bound exists because a process wedged in uninterruptible I/O would otherwise hang the
 * cancellation itself, and a cancel that never returns is worse than one that reports late.
 */
export const CANCEL_EXIT_TIMEOUT_MS = 10_000;

/**
 * Preserve the user's CLI PATH for a child that has to find git, npm, and node.
 *
 * Shared by the staged build and the detached helper: Electron's own environment is not the
 * login shell's, and both children run the same tools for the same reason.
 */
export function updateChildEnvironment(
  current: NodeJS.ProcessEnv = process.env,
  path?: string,
): NodeJS.ProcessEnv {
  return path === undefined ? executableChildEnv(current) : { ...current, PATH: path };
}

/**
 * Clones whose last build was killed without ever being seen to exit.
 *
 * Settling on a bound rather than on `close` is what makes this necessary: `close` is the only
 * proof that every descendant let go of the output pipes, and therefore of the clone, so when
 * the bound wins instead the group may still be writing in there. The promise here resolves if
 * and when `close` finally arrives, and the next build for that clone waits on it - because the
 * first thing a build does is `git checkout --force` and `npm ci` in exactly that directory.
 *
 * Keyed by clone, module-scoped, and deliberately in memory only: it exists to stop THIS app
 * from starting a second build over a dying one. A fresh app after a quit has no dying build of
 * its own, and the install script's own guards - a dirty checkout fails the build, and the
 * packaged version is verified against the source tree - are what stand behind that case.
 */
const unsettledBuilds = new Map<string, Promise<void>>();

export interface StagedBuild {
  version: string;
  bundlePath: string;
  /**
   * What the bundle was when the install script verified it, straight from the marker.
   *
   * Null only from a clone whose script predates the field, and then the caller has to read it
   * itself and accept the gap that reading it later leaves.
   */
  revision: string | null;
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
  /** Environment validated by the updater, pinned for all build children. */
  env?: NodeJS.ProcessEnv;
  sourceClone: string;
  targetTag: string;
  signal: AbortSignal;
  onStage(stage: UpdatePrepareStage): void;
  log(line: string): void;
  timeoutMs?: number;
  /** Overrides CANCEL_EXIT_TIMEOUT_MS; the wait for a killed group to actually be gone. */
  exitTimeoutMs?: number;
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
export async function stageUpdateBuild(request: StageRequest): Promise<StageOutcome> {
  const unsettled = unsettledBuilds.get(request.sourceClone);
  if (unsettled) {
    const waited = await Promise.race([
      unsettled.then(() => true),
      new Promise<false>((resolve) => {
        const timer = setTimeout(() => resolve(false), request.exitTimeoutMs ?? CANCEL_EXIT_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    if (!waited) {
      request.log(
        "a previous build of this clone was killed and has still not exited; refusing to start another one over it",
      );
      return {
        ok: false,
        reason: "failed",
        message:
          "The previous update build has not finished shutting down yet. Try again in a moment.",
      };
    }
  }
  return runStagedBuild(request);
}

function runStagedBuild(request: StageRequest): Promise<StageOutcome> {
  const script = stageScriptPath(request.sourceClone);
  const timeoutMs = request.timeoutMs ?? STAGE_TIMEOUT_MS;
  const exitTimeoutMs = request.exitTimeoutMs ?? CANCEL_EXIT_TIMEOUT_MS;

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
    let exitTimer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    let cancelling = false;

    const settle = (outcome: StageOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (exitTimer) clearTimeout(exitTimer);
      request.signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    const cancelled = (message = "The update was cancelled."): StageOutcome => ({
      ok: false,
      reason: "cancelled",
      message,
    });

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

    /**
     * Kill the group, then wait for it to be gone before telling the caller - but not forever.
     *
     * Resolving on the signal alone let the offer come straight back while `npm` and
     * `electron-builder` were still shutting down, and one click on Update Now then started a
     * fresh `git checkout --force` and `npm ci` in the directory those processes were still
     * writing to. `close` is the signal that they are all gone, because it waits for every
     * holder of the output pipes.
     *
     * Which is also why the wait needs a bound. SIGKILL cannot be caught, but a descendant that
     * escaped the group - or one stuck in uninterruptible I/O - can hold those pipes open
     * indefinitely, and then `close` never arrives. Waiting on it unconditionally would leave
     * the promise unsettled and the banner reading `preparing` forever, which is the opposite
     * of what both the cancel and the timeout exist to guarantee. So `close` wins when it comes,
     * and this settles anyway when it does not, saying that the shutdown is uncertain.
     */
    const killAndSettle = (outcome: StageOutcome, uncertain: () => StageOutcome): void => {
      killGroup();
      if (!child) {
        settle(outcome);
        return;
      }
      exitTimer = setTimeout(() => {
        request.log(
          `the build did not exit within ${Math.round(exitTimeoutMs / 1000)} seconds of being killed; something in its process group is still holding on`,
        );
        // Settle, so nothing is left hanging - but leave the clone marked. `close` is the only
        // proof the group let go of it, and until that arrives the next build must not check
        // out and reinstall in the same directory.
        const closed = new Promise<void>((resolve) => {
          child?.once("close", () => resolve());
        });
        unsettledBuilds.set(request.sourceClone, closed);
        void closed.then(() => {
          if (unsettledBuilds.get(request.sourceClone) === closed) {
            unsettledBuilds.delete(request.sourceClone);
            request.log("the previously killed build has finally exited; its clone is free again");
          }
        });
        settle(uncertain());
      }, exitTimeoutMs);
      exitTimer.unref?.();
    };

    function onAbort(): void {
      if (cancelling) return;
      cancelling = true;
      killAndSettle(cancelled(), () =>
        cancelled(
          "The update was cancelled, but its build may still be shutting down. Try again in a moment.",
        ),
      );
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
      staged = {
        version: marker.version,
        bundlePath: marker.bundlePath,
        revision: marker.revision,
      };
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
        env: request.env ?? updateChildEnvironment(),
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

    const timedOutOutcome = (): StageOutcome => ({
      ok: false,
      reason: "failed",
      message: `The update build did not finish within ${Math.round(timeoutMs / 60_000)} minutes and was stopped.`,
    });

    timer = setTimeout(() => {
      timedOut = true;
      request.log(`the staged build passed its ${Math.round(timeoutMs / 60_000)} minute limit`);
      // Bounded like the cancel, and for the same reason: the documented timeout has to hold
      // even when the thing it is killing will not let go of the output pipes.
      killAndSettle(timedOutOutcome(), timedOutOutcome);
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
      if (request.signal.aborted || cancelling) {
        // The group is gone now, which is what the caller was waiting for.
        settle(cancelled());
        return;
      }
      if (timedOut) {
        settle(timedOutOutcome());
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
