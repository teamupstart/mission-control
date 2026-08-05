// Types for the parts of `launch.mjs` other modules import: `seed.mjs` at runtime, and
// `test/demo-seed.test.ts` under `noImplicitAny`. Same convention as
// `scripts/db-shell.d.mts`. The launcher itself stays plain JavaScript - it runs with no
// build step, which is the point.

export const DEFAULT_PORT: number;
export const DEMO_ROOT_NAME: string;
export const DEMO_CHECK_ROOT_NAME: string;

/** Guarantees a cleanup runs exactly once, whichever caller claims the stop first. */
export function createShutdownGate(onStop: (reason: string) => Promise<void> | void): {
  isStopping: () => boolean;
  /** True for the FIRST caller only; every later one gets false and must not act. */
  stop: (reason: string) => Promise<boolean>;
};

/**
 * Wire SIGINT/SIGTERM to `stop`; the returned function unwires them again.
 *
 * Release matters as much as hold - a stale listener would stop a daemon that had already
 * been replaced. Safe to call more than once.
 */
export function holdSignals(stop: () => Promise<void> | void): () => void;

export function parseArgs(argv: string[]): {
  fresh: boolean;
  noForeman: boolean;
  noSeed: boolean;
  noOpen: boolean;
  check: boolean;
  port: number;
};

/** Exit with guidance if `dist/` is missing - this launcher runs the BUILT daemon. */
export function ensureBuilt(): void;

/**
 * Refuse to act on anything but the demo's own state roots. `~/.mission-control` is live
 * operator state and must never be written by demo tooling. Throws otherwise; returns the
 * resolved path.
 */
export function assertDemoRoot(root: string): string;

/** Seeded workspace repos, installed players, and scenario tables. Idempotent. */
export function prepareStateRoot(root: string): {
  workspace: string;
  repos: string[];
  bins: { claude: string; codex: string; pi: string };
  scenarios: string;
};

/** The daemon env: the fake bins, the demo HOME, and the two non-negotiable sweep zeroes. */
export function buildDaemonEnv(
  root: string,
  port: number,
  bins: { claude: string; codex: string; pi: string },
): Record<string, string>;

export interface DemoDaemon {
  child: { pid?: number };
  baseURL: string;
  readLog: () => string;
  /** SIGTERM, then WAIT for the exit - the shutdown is what writes `suspended`. */
  stop: (graceMs?: number) => Promise<void>;
}

/** Boot the built daemon and prove it is ours: pid identity, and a db under the state root. */
export function bootDaemon(
  root: string,
  port: number,
  env: Record<string, string>,
): Promise<DemoDaemon>;
