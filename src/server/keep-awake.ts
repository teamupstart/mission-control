import { spawn as nodeSpawn } from "node:child_process";
import type { KeepAwakeStatus } from "@shared/types.ts";
import { envVar } from "@shared/harness-runtime.mjs";

/**
 * The daemon's transient idle-sleep inhibitor: one owner for one OS child.
 *
 * On macOS the child is `/usr/bin/caffeinate -i -w <daemon PID>`. `-i` prevents
 * user-idle SYSTEM sleep and nothing else - the display still dims and locks - and
 * `-w` binds the assertion to this daemon's lifetime, so an exit that never reaches
 * `stop()` (crash, SIGKILL, power loss) still releases it. `-d`, `-u` and `-s` are
 * deliberately absent and must stay absent: they would keep the display awake,
 * impersonate user activity, or change the requested sleep semantics, each of which
 * breaks the promise the UI makes ("the screen can dim and lock normally").
 *
 * There is intentionally NOTHING durable here. Keep Awake applies only to the current
 * daemon run by an approved human decision: every new manager starts `off`, no config
 * key is written, and nothing reacquires the assertion at boot. The status this class
 * publishes is an OBSERVATION of the child, never an echo of the request - `on` is
 * reachable only after the child's `spawn` event, and an unexpected exit lands on
 * `error` without a restart, so the dashboard cannot claim an assertion the OS is not
 * holding.
 */

/** The slice of `ChildProcess` the manager touches, injectable so tests script it. */
export interface KeepAwakeChild {
  pid?: number | undefined;
  on(event: "spawn", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
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
  /** The PID `-w` binds the assertion to. Defaults to `process.pid`. */
  daemonPid?: number;
  now?: () => number;
  spawn?: (bin: string, args: string[]) => KeepAwakeChild;
  setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn?: (t: NodeJS.Timeout) => void;
  /** How long a SIGTERM gets before the SIGKILL fallback, and the fallback's own wait. */
  forceKillAfterMs?: number;
  /** Where every observed transition goes - production wires the Registry here. */
  onStatus?: (status: KeepAwakeStatus) => void;
}

/**
 * Bound external text before it reaches SSE. Spawn errors carry OS strings of arbitrary
 * length and the status rides every snapshot, so an unbounded message would tax each
 * connect for as long as the failure stands.
 */
const ERROR_MAX_CHARS = 200;
const DEFAULT_FORCE_KILL_AFTER_MS = 2000;

function bounded(text: string): string {
  return text.length > ERROR_MAX_CHARS ? `${text.slice(0, ERROR_MAX_CHARS - 1)}…` : text;
}

/**
 * Which executable this host would run, if any. The override wins everywhere; without
 * one, only Darwin has a provider and it is resolved by ABSOLUTE path - the daemon must
 * never let PATH decide what holds a power assertion.
 */
export function resolveKeepAwakeBin(
  platform: NodeJS.Platform,
  override: string | null,
): string | null {
  if (override) return override;
  if (platform === "darwin") return "/usr/bin/caffeinate";
  return null;
}

export class KeepAwakeManager {
  private readonly bin: string | null;
  private readonly daemonPid: number;
  private readonly now: () => number;
  private readonly spawnFn: (bin: string, args: string[]) => KeepAwakeChild;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimeoutFn: (t: NodeJS.Timeout) => void;
  private readonly forceKillAfterMs: number;
  private readonly onStatus: ((status: KeepAwakeStatus) => void) | undefined;

  private current: KeepAwakeStatus;
  private child: KeepAwakeChild | null = null;
  /** The child whose exit `disable()` is awaiting - what separates it from a crash. */
  private expectedExit: { child: KeepAwakeChild; resolve: () => void } | null = null;
  /**
   * The transition mutex. Every `setEnabled` chains onto it, so two dashboards clicking
   * at once cannot interleave a spawn with a kill or produce two children; each queued
   * request re-reads the observed state when its turn comes, which is what makes a
   * repeated request for the already-achieved state a no-op rather than a second child.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: KeepAwakeDeps = {}) {
    const platform = deps.platform ?? process.platform;
    const override = deps.override === undefined ? envVar("KEEP_AWAKE_BIN") ?? null : deps.override;
    this.bin = resolveKeepAwakeBin(platform, override);
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
    this.current = {
      supported: this.bin !== null,
      unavailableReason:
        this.bin !== null
          ? null
          : bounded(
              `Keep awake is unavailable on this system (${platform}) - ` +
                "only the macOS caffeinate provider ships today",
            ),
      state: "off",
      provider: this.bin !== null ? "caffeinate" : null,
      since: null,
      error: null,
    };
  }

  status(): KeepAwakeStatus {
    return this.current;
  }

  /**
   * Request a transition and resolve with the state OBSERVED once it settles - never
   * with an echo of the request. Serialized: concurrent calls run one at a time in
   * arrival order, so the last response describes the state the last caller produced.
   */
  async setEnabled(enabled: boolean): Promise<KeepAwakeStatus> {
    const run = this.queue.then(() => (enabled ? this.enable() : this.disable()));
    // Keep the chain alive whatever a transition did; the caller still sees its result.
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * The daemon-shutdown half: the disable path, and nothing more. There is no durable
   * state to write because none exists - `-w <daemon PID>` covers the exits that never
   * reach this method.
   */
  async stop(): Promise<void> {
    await this.setEnabled(false);
  }

  private async enable(): Promise<KeepAwakeStatus> {
    if (this.bin === null) return this.current;
    if (this.current.state === "on") return this.current;
    this.publish({ state: "starting", since: null, error: null });
    const child = this.spawnFn(this.bin, ["-i", "-w", String(this.daemonPid)]);
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
