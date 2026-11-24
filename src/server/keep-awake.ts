import { spawn as nodeSpawn } from "node:child_process";
import type { KeepAwakeStatus } from "@shared/types.ts";
import { envVar } from "@shared/harness-runtime.mjs";
import {
  loadNativeKeepAwakeBinding,
  type NativeKeepAwakeBinding,
} from "./keep-awake-native.ts";

export type { NativeKeepAwakeBinding } from "./keep-awake-native.ts";

/**
 * The daemon's idle-sleep inhibitor: one owner for one OS assertion.
 *
 * On macOS the daemon itself owns one IOKit
 * `kIOPMAssertionTypePreventUserIdleSystemSleep` assertion. It prevents user-idle
 * SYSTEM sleep and nothing else, so the display still dims and locks. The OS removes
 * the process-owned assertion after a crash or SIGKILL. Display-sleep and synthetic
 * user-activity assertions are deliberately absent because either would break the UI's
 * promise that "the screen can dim and lock normally".
 *
 * `MISSION_KEEP_AWAKE_BIN` selects the legacy command mechanics only as an explicit
 * test seam. It is never a production fallback after native loading or IOKit fails.
 *
 * What is durable is the operator's CHOICE, and only that. The switch the operator last
 * left (`KeepAwakePreferenceStore`) is saved when they flip it and read once, when the daemon
 * has won its port, so a restart or an upgrade puts the Mac back in the state they chose. The
 * assertion itself is never stored: it dies with the process, and the new daemon acquires its
 * own. An orderly shutdown (`stop`) releases the assertion WITHOUT touching the saved choice -
 * a daemon going away is not the operator switching the mode off.
 *
 * The status this class publishes is an OBSERVATION of the assertion, never an echo of the
 * request or of the saved choice - `on` is reachable only after the provider confirms
 * acquisition. A restore that fails lands on `error` like any other failed acquisition, and a
 * command provider's unexpected exit lands on `error` without a restart, so the dashboard
 * cannot claim an assertion the OS is not holding.
 */

/** The slice of `ChildProcess` the manager touches, injectable so tests script it. */
export interface KeepAwakeChild {
  pid?: number | undefined;
  on(event: "spawn", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/**
 * Where the operator's last choice lives. Injectable so the manager stays free of SQLite and
 * a test scripts it; production wires `keepAwakePreferenceStore` (`./keep-awake-preference.ts`).
 */
export interface KeepAwakePreferenceStore {
  /** The saved choice, or `false` when none was saved or what is stored cannot be read. */
  load(): boolean;
  save(enabled: boolean): void;
}

/**
 * The operator's request could not be made durable, so it was not kept. Carries the state
 * the daemon OBSERVES after undoing it, so a caller can draw the truth at once: switching on
 * leaves the mode off (an assertion that would vanish at the next restart is released), and
 * switching off leaves it as it was. Never a half-applied choice - the toggle may only show
 * what a restart will bring back.
 */
export class KeepAwakeSaveError extends Error {
  constructor(
    readonly status: KeepAwakeStatus,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(bounded(`could not save the Keep awake choice, so it was not applied: ${detail}`), { cause });
    this.name = "KeepAwakeSaveError";
  }
}

export interface KeepAwakeDeps {
  /** Host platform. Defaults to `process.platform`; only `darwin` ships a provider. */
  platform?: NodeJS.Platform;
  /**
   * Inhibitor executable override. `undefined` reads `MISSION_KEEP_AWAKE_BIN` through
   * the shared env helper (so the older `FLEET_`/`HARNESS_` prefixes keep working);
   * `null` forces "no override" for tests. When set, it is the provider under test on
   * ANY platform - that is how Linux CI drives the full path without touching host
   * power settings.
   */
  override?: string | null;
  /** The PID `-w` binds the explicit command fixture to. Defaults to `process.pid`. */
  daemonPid?: number;
  now?: () => number;
  spawn?: (bin: string, args: string[]) => KeepAwakeChild;
  loadNativeBinding?: () => NativeKeepAwakeBinding;
  setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn?: (t: NodeJS.Timeout) => void;
  /** How long a SIGTERM gets before the SIGKILL fallback, and the fallback's own wait. */
  forceKillAfterMs?: number;
  /** Where every observed transition goes - production wires the Registry here. */
  onStatus?: (status: KeepAwakeStatus) => void;
  /**
   * The saved choice. Absent means nothing is remembered and every manager starts off, which
   * is what a test that only exercises the transitions wants.
   */
  preference?: KeepAwakePreferenceStore;
}

/**
 * Bound external text before it reaches SSE. Provider errors carry text of arbitrary
 * length and the status rides every snapshot, so an unbounded message would tax each
 * connect for as long as the failure stands.
 */
const ERROR_MAX_CHARS = 200;
const DEFAULT_FORCE_KILL_AFTER_MS = 2000;
const NATIVE_ASSERTION_REASON = "Mission Control is keeping this Mac awake while agent work is active";

function bounded(text: string): string {
  return text.length > ERROR_MAX_CHARS ? `${text.slice(0, ERROR_MAX_CHARS - 1)}…` : text;
}

type KeepAwakeProvider =
  | { kind: "command"; bin: string }
  | { kind: "native"; binding: NativeKeepAwakeBinding }
  | { kind: "unavailable"; reason: string };

export class KeepAwakeManager {
  private readonly provider: KeepAwakeProvider;
  private readonly daemonPid: number;
  private readonly now: () => number;
  private readonly spawnFn: (bin: string, args: string[]) => KeepAwakeChild;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimeoutFn: (t: NodeJS.Timeout) => void;
  private readonly forceKillAfterMs: number;
  private readonly onStatus: ((status: KeepAwakeStatus) => void) | undefined;
  private readonly preference: KeepAwakePreferenceStore | undefined;

  private current: KeepAwakeStatus;
  private child: KeepAwakeChild | null = null;
  private nativeHandle: unknown;
  private hasNativeHandle = false;
  /** The child whose exit `disable()` is awaiting - what separates it from a crash. */
  private expectedExit: { child: KeepAwakeChild; resolve: () => void } | null = null;
  /** The tail of the transition chain; see `transition`. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: KeepAwakeDeps = {}) {
    const platform = deps.platform ?? process.platform;
    const override = deps.override === undefined ? envVar("KEEP_AWAKE_BIN") ?? null : deps.override;
    if (override) {
      this.provider = { kind: "command", bin: override };
    } else if (platform !== "darwin") {
      this.provider = {
        kind: "unavailable",
        reason: bounded(
          `Keep awake is unavailable on this system (${platform}) - ` +
            "the native provider only supports macOS",
        ),
      };
    } else {
      try {
        const loadNativeBinding = deps.loadNativeBinding ?? loadNativeKeepAwakeBinding;
        this.provider = { kind: "native", binding: loadNativeBinding() };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.provider = {
          kind: "unavailable",
          reason: bounded(`Keep awake native binding is unavailable: ${message}`),
        };
      }
    }
    this.daemonPid = deps.daemonPid ?? process.pid;
    this.now = deps.now ?? Date.now;
    this.spawnFn =
      deps.spawn ??
      ((bin, args) =>
        // Direct argv, no shell, no inherited stdio: the command is fixed and the
        // arguments are numbers we produced, so nothing here is interpolatable.
        nodeSpawn(bin, args, { stdio: "ignore", shell: false }));
    this.setTimeoutFn = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = deps.clearTimeoutFn ?? ((t) => clearTimeout(t));
    this.forceKillAfterMs = deps.forceKillAfterMs ?? DEFAULT_FORCE_KILL_AFTER_MS;
    this.onStatus = deps.onStatus;
    this.preference = deps.preference;
    // Always `off`, whatever is saved: the saved choice is applied by `restore()` once the
    // daemon is serving, so a status read before then never claims an assertion not yet held.
    this.current = {
      supported: this.provider.kind !== "unavailable",
      unavailableReason: this.provider.kind === "unavailable" ? this.provider.reason : null,
      state: "off",
      provider: this.provider.kind === "native"
        ? "iokit"
        : this.provider.kind === "command"
          ? "caffeinate"
          : null,
      since: null,
      error: null,
    };
  }

  status(): KeepAwakeStatus {
    return this.current;
  }

  /**
   * The operator's request: flip the mode, make the choice durable, and resolve with the
   * state OBSERVED once it settles - never with an echo of the request.
   *
   * The switch may only show a choice that a restart will bring back, so the request is
   * atomic with its save. Off is saved BEFORE the transition: if the save fails nothing has
   * moved and the assertion is still held, exactly as the error says. On is saved AFTER the
   * OS confirms the assertion - an acquisition the OS refused is never saved, so it cannot
   * re-fail on every boot - and if that save fails the fresh assertion is released again
   * rather than left held for a choice that would be gone after the next restart. A request
   * that finds the assertion already held takes nothing new and so has nothing to undo.
   * Either failure rejects with `KeepAwakeSaveError`.
   */
  async setEnabled(enabled: boolean): Promise<KeepAwakeStatus> {
    return this.transition(async () => {
      if (!enabled) {
        try {
          this.save(false);
        } catch (err) {
          throw new KeepAwakeSaveError(this.current, err);
        }
        return this.disable();
      }
      const alreadyOn = this.current.state === "on";
      const status = await this.enable();
      if (status.state !== "on") return status;
      try {
        this.save(true);
      } catch (err) {
        throw new KeepAwakeSaveError(alreadyOn ? this.current : await this.disable(), err);
      }
      return status;
    });
  }

  /**
   * Apply the saved choice at daemon start. Called once the daemon has won its port, so a
   * second daemon that lost the lock never takes a power assertion. A saved `off` (or none) is
   * a no-op; a saved `on` goes through the ordinary acquisition, so a failure is published as
   * `error` and the saved choice stays for the next boot to try again.
   */
  async restore(): Promise<KeepAwakeStatus> {
    return this.transition(async () => (this.recall() ? this.enable() : this.current));
  }

  /**
   * The daemon-shutdown half: the disable path, and nothing more. The saved choice is left
   * exactly as the operator set it, because a daemon exiting - an upgrade, a restart, a quit -
   * is not a decision about the mode, and clearing it here is what would make every restart
   * switch Keep awake off. IOKit drops a native assertion with its owning process, while the
   * explicit command fixture's `-w <daemon PID>` covers exits that never reach this method.
   */
  async stop(): Promise<void> {
    await this.transition(() => this.disable());
  }

  /**
   * The transition mutex. Every transition chains onto it, so two dashboards clicking at once
   * cannot interleave acquisition with release or produce two assertions; each queued request
   * re-reads the observed state when its turn comes, which is what makes a repeated request for
   * the already-achieved state a no-op rather than a second assertion.
   */
  private transition(run: () => Promise<KeepAwakeStatus>): Promise<KeepAwakeStatus> {
    const result = this.queue.then(run);
    // Keep the chain alive whatever a transition did; the caller still sees its result.
    this.queue = result.catch(() => {});
    return result;
  }

  /** The saved choice, with a store that cannot be read treated as never having been saved. */
  private recall(): boolean {
    if (!this.preference) return false;
    try {
      return this.preference.load();
    } catch (err) {
      console.warn("[mission-control] could not read the saved Keep awake choice:", err);
      return false;
    }
  }

  /** Write the choice. A failure is logged and rethrown for `setEnabled` to turn into its error. */
  private save(enabled: boolean): void {
    if (!this.preference) return;
    try {
      this.preference.save(enabled);
    } catch (err) {
      console.warn("[mission-control] could not save the Keep awake choice:", err);
      throw err;
    }
  }

  private async enable(): Promise<KeepAwakeStatus> {
    if (this.provider.kind === "unavailable") return this.current;
    if (this.current.state === "on") return this.current;
    if (this.provider.kind === "native" && this.hasNativeHandle) {
      // A failed release leaves an exact handle behind while the UI truthfully shows
      // `error`. Its next switch action asks for `on`; reconcile the retained handle
      // first, then acquire a fresh assertion. Returning the error again would wedge
      // the only operator control, while treating the old handle as `on` would guess
      // whether IOKit had released it despite reporting failure.
      const reconciled = this.disableNative(this.provider.binding);
      if (reconciled.state === "error") return reconciled;
    }
    this.publish({ state: "starting", since: null, error: null });
    if (this.provider.kind === "native") {
      try {
        this.nativeHandle = this.provider.binding.create(NATIVE_ASSERTION_REASON);
        this.hasNativeHandle = true;
      } catch (err) {
        this.nativeHandle = undefined;
        this.hasNativeHandle = false;
        const message = err instanceof Error ? err.message : String(err);
        this.publish({
          state: "error",
          since: null,
          error: bounded(`could not start iokit: ${message}`),
        });
        return this.current;
      }
      this.publish({ state: "on", since: this.now(), error: null });
      return this.current;
    }
    const child = this.spawnFn(this.provider.bin, ["-i", "-w", String(this.daemonPid)]);
    this.child = child;
    const outcome = await new Promise<"spawned" | Error>((resolve) => {
      child.on("spawn", () => resolve("spawned"));
      child.on("error", (err) => resolve(err));
    });
    if (outcome !== "spawned") {
      this.child = null;
      this.publish({
        state: "error",
        since: null,
        error: bounded(`could not start ${this.current.provider ?? "the inhibitor"}: ${outcome.message}`),
      });
      return this.current;
    }
    // Registered only after spawn was observed, so a pre-spawn failure cannot also
    // report as an exit. `on` is published here and nowhere earlier: this is the one
    // boundary at which the OS actually holds the assertion.
    child.on("exit", (code, signal) => this.onChildExit(child, code, signal));
    this.publish({ state: "on", since: this.now(), error: null });
    return this.current;
  }

  private async disable(): Promise<KeepAwakeStatus> {
    if (this.provider.kind === "native") return this.disableNative(this.provider.binding);
    const child = this.child;
    if (!child) {
      // Nothing is running: converge to off, which also clears a standing error - the
      // operator's "turn it off" is an acknowledgement, not a request we can fail.
      if (this.current.state !== "off") this.publish({ state: "off", since: null, error: null });
      return this.current;
    }
    this.publish({ state: "stopping", error: null });
    const exited = new Promise<void>((resolve) => {
      this.expectedExit = { child, resolve };
    });
    child.kill("SIGTERM");
    // Bounded escalation, and only ever for the child this manager spawned: SIGTERM is
    // given `forceKillAfterMs`, then SIGKILL the same again. A child that survives both
    // is abandoned with a visible error rather than allowed to hang daemon shutdown.
    const killTimer = this.setTimeoutFn(() => child.kill("SIGKILL"), this.forceKillAfterMs);
    let deadlineTimer: NodeJS.Timeout | null = null;
    const gaveUp = await Promise.race([
      exited.then(() => false),
      new Promise<true>((resolve) => {
        deadlineTimer = this.setTimeoutFn(() => resolve(true), this.forceKillAfterMs * 2);
      }),
    ]);
    this.clearTimeoutFn(killTimer);
    if (deadlineTimer !== null) this.clearTimeoutFn(deadlineTimer);
    this.expectedExit = null;
    this.child = null;
    if (gaveUp) {
      this.publish({
        state: "error",
        since: null,
        error: bounded(
          `the ${this.current.provider ?? "inhibitor"} process (pid ${child.pid ?? "unknown"}) ` +
            "did not exit after SIGTERM and SIGKILL",
        ),
      });
      return this.current;
    }
    this.publish({ state: "off", since: null, error: null });
    return this.current;
  }

  private disableNative(binding: NativeKeepAwakeBinding): KeepAwakeStatus {
    if (!this.hasNativeHandle) {
      if (this.current.state !== "off") this.publish({ state: "off", since: null, error: null });
      return this.current;
    }
    this.publish({ state: "stopping", error: null });
    try {
      binding.release(this.nativeHandle);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.publish({
        state: "error",
        since: null,
        error: bounded(`could not release iokit: ${message}`),
      });
      return this.current;
    }
    this.nativeHandle = undefined;
    this.hasNativeHandle = false;
    this.publish({ state: "off", since: null, error: null });
    return this.current;
  }

  private onChildExit(
    child: KeepAwakeChild,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.expectedExit?.child === child) {
      // The exit `disable()` asked for; it publishes `off` itself once it observes this.
      this.expectedExit.resolve();
      return;
    }
    if (this.child !== child) return; // a child we already gave up on
    // Unexpected exit: the assertion is gone, so say so and do NOT restart it - a
    // process that dies on its own is a fact the operator needs, not one to paper over.
    this.child = null;
    this.publish({
      state: "error",
      since: null,
      error: bounded(
        `the ${this.current.provider ?? "inhibitor"} process exited unexpectedly ` +
          `(code ${code ?? "null"}, signal ${signal ?? "null"})`,
      ),
    });
  }

  private publish(patch: Partial<KeepAwakeStatus>): void {
    this.current = { ...this.current, ...patch };
    this.onStatus?.(this.current);
  }
}
