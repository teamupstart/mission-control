// The daemon's shaper sign-in service: it starts a sign-in, finishes it, keeps the tokens,
// refreshes them in the background one at a time per connection, signs out and reports status.
// It is the only caller of the flow (`flow.ts`) and of the store (`store.ts`), and a token exists
// only in the store and in this service's own memory.
//
// Every dependency is injected: the store, the flow, the client registrations, the clock, the
// timers and the flags. `index.ts` builds the daemon's one instance with the real ones.
//
// Three rules keep the order of things straight, per connection:
// - Store calls run one at a time, in the order they were asked for. A write and the memory
//   change that follows it are one turn.
// - Every record is numbered (`generation`). A removal clears memory at once and then removes
//   the stored record, unless a newer record was stored by the time its turn comes. A refresh
//   belongs to the record it started from: when that record was signed out, removed or replaced
//   before its result is kept, it keeps nothing and revokes the pair it received.
// - A refresh that a call asks for never starts while one is running or while a later try is
//   already set, and refreshes that refusals ask for are spaced by `BACKOFF_MS`.
//
// And one rule keeps a sign-out across a restart, whatever the store does: every removal lists
// its connection in `app_config` key `shaping.signIn` (`signedOut`) before the store is asked,
// a load never installs a listed connection's record, and the entry leaves the list only once
// the store confirmed a removal, or a write that was still wanted when it ended, with no later
// sign-out of that connection since it began. See `markSignedOut`.

import { createHash, timingSafeEqual } from "node:crypto";
import {
  SHAPING_SIGN_IN_CLIENTS, SHAPING_SIGNED_OUT_CONNECTIONS, SIGN_IN_REASONS,
  type ShapingSignInClient, type ShapingSignInConfig, type ShapingSignInView, type SignInReason, type SignInTarget,
} from "@shared/shaping.ts";
import { connectionId } from "./connection.ts";
import {
  issuersMatch,
  type BeginResult, type DiscoverResult, type FlowOptions, type RefreshOptions, type RefreshResult, type RevokeResult,
  type SignInClient, type SignInDiscovery, type SignInFailureCode, type SignInTokens, type TokensResult,
} from "./flow.ts";
import type { SignInStorage, SignInStore, StoredSignIn } from "./store.ts";

/** How long a pending sign-in's `state` and verifier are kept. */
export const PENDING_SIGN_IN_MS = 10 * 60_000;
/** The most pending sign-ins kept at once, across every connection. */
export const PENDING_SIGN_INS = 8;
/** `begin`, the wait for its turn included. */
export const BEGIN_DEADLINE_MS = 20_000;
/** Revoking the pair a sign-out or a lost refresh held. */
export const REVOKE_DEADLINE_MS = 5_000;
/** How long `stop` waits for work in flight. */
export const STOP_DEADLINE_MS = 10_000;
/**
 * The longest a timer is set for. Node fires any `setTimeout` longer than 2^31-1 ms (about 24.8
 * days) after 1 ms, so a long-lived token's timer would spin. A timer that wakes early re-plans.
 */
export const MAX_TIMER_MS = 24 * 60 * 60_000;
/** A refresh is due at this share of the access token's lifetime. */
export const REFRESH_AT = 0.75;
/** The waits between retried refreshes, and between refreshes that refusals ask for. The last repeats. */
export const BACKOFF_MS: readonly number[] = [1, 2, 4, 8, 15].map((minutes) => minutes * 60_000);

/** Why `begin` refused before any registration request. Fixed sentences. */
export const SIGN_IN_BEGIN_REFUSALS = Object.freeze({
  registration_limit: `Mission Control keeps at most ${SHAPING_SIGN_IN_CLIENTS} client registrations, and a sign-in uses each one. Sign out of one in Settings > Task shaping, then sign in again.`,
  store_unread: "Mission Control could not read its stored sign-ins, so it cannot tell which client registrations they use. Restart Mission Control, then sign in again.",
  flag_off: "Shaper sign-in is switched off. Turn on the Shaper sign-in feature flag (shaper-sign-in), then sign in at Settings > Task shaping.",
  timeout: "Starting the sign-in took longer than 20 seconds. Try again at Settings > Task shaping.",
} as const);

/** Why `complete` ended without a sign-in. Fixed sentences: never the server's own text. */
export const SIGN_IN_COMPLETE_REFUSALS = Object.freeze({
  flag_off: SIGN_IN_BEGIN_REFUSALS.flag_off,
  unknown_state: "This sign-in is not one Mission Control is waiting for, or it expired. Start it again at Settings > Task shaping.",
  denied: "The authorization server did not approve the sign-in. Start it again at Settings > Task shaping.",
  no_code: "The authorization server sent no authorization code. Start the sign-in again at Settings > Task shaping.",
  wrong_issuer: "The sign-in was answered by another authorization server than the one it was started with. Start it again at Settings > Task shaping.",
  cancelled: "The sign-in was signed out before it finished, so nothing was kept. Start it again at Settings > Task shaping.",
} as const);

/** The five steps of `flow.ts`, injected so a test can watch them. */
export interface SignInFlow {
  discover(target: SignInTarget, options?: FlowOptions): Promise<DiscoverResult>;
  begin(target: SignInTarget, discovery: SignInDiscovery, client: SignInClient | null, redirectUri: string, options?: FlowOptions): Promise<BeginResult>;
  exchange(
    target: SignInTarget, discovery: SignInDiscovery, client: SignInClient,
    grant: { code: string; codeVerifier: string; redirectUri: string; iss?: string | null }, options?: FlowOptions,
  ): Promise<TokensResult>;
  refresh(discovery: SignInDiscovery, client: SignInClient, refreshToken: string, options?: RefreshOptions): Promise<RefreshResult>;
  revoke(discovery: SignInDiscovery, client: SignInClient, token: string, options?: FlowOptions): Promise<RevokeResult>;
}

/**
 * The client registrations and the signed-out connections, `app_config` key `shaping.signIn` in
 * the daemon. Synchronous, as SQLite is. `read` answers null for a value it cannot read, never
 * the empty value, because an unreadable value may list sign-outs.
 */
export interface SignInRegistrations {
  read(): ShapingSignInConfig | null;
  write(value: ShapingSignInConfig): void;
}

export interface TimerHandle {
  unref?(): void;
}

export interface ShaperSignInServiceDeps {
  /** Builds the store, once, the first time the service needs it: never while either flag is off. */
  store: () => SignInStore;
  flow: SignInFlow;
  registrations: SignInRegistrations;
  /** `http://127.0.0.1:<PORT>/api/shaping/sign-in/callback`. */
  redirectUri: string;
  /** Whether `task-shaping` and `shaper-sign-in` are both on. */
  enabled: () => boolean;
  /** Subscribes to flag changes; returns the unsubscribe. */
  onEnabledChanged: (listener: () => void) => () => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  /** Per flow request. The flow's own 10 seconds unless a test shortens it. */
  flowTimeoutMs?: number;
  /** Told what failed. Never given a token, a code, a `state` or a verifier. */
  warn?: (message: string) => void;
}

export type AccessTokenAnswer = { ok: true; token: string } | { ok: false; reason: SignInReason };

export type BeginFailureCode = keyof typeof SIGN_IN_BEGIN_REFUSALS | SignInFailureCode;
export type BeginAnswer =
  | { ok: true; connection: string; authorizationUrl: string; expiresAt: number }
  | { ok: false; code: BeginFailureCode; reason: string };

export type CompleteFailureCode = keyof typeof SIGN_IN_COMPLETE_REFUSALS | SignInFailureCode;
export type CompleteAnswer = { ok: true; connection: string } | { ok: false; code: CompleteFailureCode; reason: string };

/** What a browser's redirect carried to the callback. */
export interface SignInCallback {
  state: string | null | undefined;
  code: string | null | undefined;
  error: string | null | undefined;
  iss: string | null | undefined;
}

/** One connection the known shapers name, with the ids of the shapers that name it. */
export interface SignInUse {
  target: SignInTarget;
  shapers: readonly string[];
}

export interface ShaperSignInService {
  /** Follows the flags from now on: while both are on, loads every stored record and schedules its refresh. */
  start(): void;
  /** Stops following the flags, clears every timer, and waits for work in flight. */
  stop(): Promise<void>;
  /** Synchronous, from memory only. Never waits on the network or the store. */
  accessToken(target: SignInTarget): AccessTokenAnswer;
  /**
   * A server refused `accessToken`. Ignored unless it is the token the connection holds now, so
   * a late refusal of a token a refresh or a new sign-in already replaced does not withhold or
   * remove the new one.
   */
  noteRefused(target: SignInTarget, accessToken: string): void;
  begin(target: SignInTarget): Promise<BeginAnswer>;
  complete(callback: SignInCallback): Promise<CompleteAnswer>;
  /** Drops a pending sign-in, removes the record and revokes it. False for an unknown id or with a flag off. */
  signOut(id: string): Promise<boolean>;
  setInUse(list: readonly SignInUse[]): void;
  /** Every connection, sorted. Empty while either flag is off. */
  view(): ShapingSignInView[];
  /** Called with the new view, only when it changed. */
  onChanged(listener: (view: ShapingSignInView[]) => void): () => void;
  /** Resolves when no store call, refresh, revocation, load or `begin` is left in flight. */
  idle(): Promise<void>;
}

interface Pending {
  state: string;
  codeVerifier: string;
  client: SignInClient;
  discovery: SignInDiscovery;
  createdAt: number;
  expiresAt: number;
  timer: TimerHandle | null;
}

type RefreshTrigger = "due" | "expired" | "refusal" | "retry";

interface Connection {
  readonly id: string;
  readonly target: SignInTarget;
  record: StoredSignIn | null;
  /** Numbers the connection's records: changes whenever the record in memory is set or removed. */
  generation: number;
  /** Where the record is kept, or null to read the store's own kind. */
  storage: SignInStorage | null;
  reason: SignInReason | null;
  /** The generation a server refused, until a refresh replaces that record. */
  refusedGeneration: number | null;
  pending: Pending | null;
  /**
   * The completion whose code exchange is running, once its pending sign-in was taken. A
   * sign-out or a rejected client clears it, and the completion then keeps nothing.
   */
  completing: { client: SignInClient } | null;
  /** The last removal of the stored record, queued in its turn. */
  removing: Promise<void> | null;
  /** Server metadata, held until the daemon stops. */
  discovery: SignInDiscovery | null;
  refreshing: Promise<void> | null;
  /** When the next refresh is due, or null. */
  nextAt: number | null;
  /** What set `nextAt` when it is a later try that calls may not bring forward. */
  held: "retry" | "refusal" | null;
  timer: TimerHandle | null;
  retries: number;
  /** Refreshes refusals asked for since the count last started again, and when the last ran. */
  refusals: number;
  lastRefusalRefreshAt: number | null;
}

const defaultSetTimer = (callback: () => void, delayMs: number): TimerHandle => setTimeout(callback, delayMs);
const defaultClearTimer = (handle: TimerHandle): void => clearTimeout(handle as ReturnType<typeof setTimeout>);

function backoff(count: number): number {
  return BACKOFF_MS[Math.min(Math.max(count, 1), BACKOFF_MS.length) - 1]!;
}

/** When a record's refresh is due: 75% of its lifetime, its expiry when it has no refresh token, or never. */
function refreshDue(record: StoredSignIn): number | null {
  if (record.expiresAt === null) return null;
  if (record.refreshToken === null) return record.expiresAt;
  return record.obtainedAt + REFRESH_AT * (record.expiresAt - record.obtainedAt);
}

/** Two secrets, a `state` or a token, compared in constant time whatever their lengths. */
function sameSecret(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

function compareViews(a: ShapingSignInView, b: ShapingSignInView): number {
  for (const [x, y] of [[a.url, b.url], [a.scope, b.scope], [a.issuer ?? "", b.issuer ?? ""], [a.id, b.id]] as const) {
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function createShaperSignInService(deps: ShaperSignInServiceDeps): ShaperSignInService {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? defaultSetTimer;
  const clearTimer = deps.clearTimer ?? defaultClearTimer;
  const warn = deps.warn ?? ((message: string) => console.warn(`[shaping] sign-in: ${message}`));
  const flowOptions = (bound?: number): FlowOptions => {
    const timeoutMs = bound === undefined ? deps.flowTimeoutMs : Math.min(bound, deps.flowTimeoutMs ?? bound);
    return { now, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
  };

  const connections = new Map<string, Connection>();
  /** The connections the known shapers name, as last told. */
  let inUse = new Map<string, { target: SignInTarget; shapers: Set<string> }>();
  /** Connections a token was asked for: in use too. */
  const asked = new Set<string>();
  const listeners = new Set<(view: ShapingSignInView[]) => void>();
  const inflight = new Set<Promise<unknown>>();

  let store: SignInStore | null = null;
  const getStore = (): SignInStore => (store ??= deps.store());

  let started = false;
  let stopped = false;
  let active = false;
  /** Counts the times both flags turned on; a load reads only while its own activation lasts. */
  let activation = 0;
  let stopFlags: (() => void) | null = null;
  let loading: Promise<void> = Promise.resolve();
  /** The last load could not read the whole store, so its records may name clients this service cannot see. */
  let loadIncomplete = false;
  /**
   * Loads reading the store. A flag turned off and on can start a second before the first ends,
   * so this is a count, not a flag: a sign-out while any is reading decides its connection, and
   * every load skips it.
   */
  let loadsActive = 0;

  let beginTail: Promise<unknown> = Promise.resolve();

  let lastView = "[]";
  let flushQueued = false;

  const track = <T>(promise: Promise<T>): Promise<T> => {
    inflight.add(promise);
    void promise.then(() => inflight.delete(promise), () => inflight.delete(promise));
    return promise;
  };

  // ---- view and change reports ----

  const isInUse = (id: string): boolean => inUse.has(id) || asked.has(id);

  const livePending = (conn: Connection): Pending | null =>
    conn.pending && conn.pending.expiresAt > now() ? conn.pending : null;

  const refused = (conn: Connection): boolean => conn.record !== null && conn.refusedGeneration === conn.generation;

  const viewOf = (conn: Connection): ShapingSignInView => {
    const record = conn.record;
    const expired = record?.expiresAt != null && record.expiresAt <= now();
    const state = livePending(conn) ? "pending" : !record ? "signed_out" : refused(conn) || expired ? "renewing" : "signed_in";
    const reason = refused(conn) ? SIGN_IN_REASONS.refused : conn.reason ? SIGN_IN_REASONS[conn.reason] : null;
    return {
      id: conn.id,
      url: conn.target.url,
      scope: conn.target.scope,
      issuer: conn.target.issuer,
      state,
      storage: conn.storage ?? getStore().kind,
      expiresAt: record?.expiresAt ?? null,
      reason,
      shapers: [...(inUse.get(conn.id)?.shapers ?? [])].sort(),
    };
  };

  const view = (): ShapingSignInView[] => {
    if (!active) return [];
    return [...connections.values()]
      .filter((conn) => conn.record !== null || livePending(conn) !== null || inUse.has(conn.id))
      .map(viewOf)
      .sort(compareViews);
  };

  /** Reports the view after the current turn, once however many changes it made, and only when it changed. */
  const notify = (): void => {
    if (flushQueued) return;
    flushQueued = true;
    queueMicrotask(() => {
      flushQueued = false;
      const next = view();
      const serialized = JSON.stringify(next);
      if (serialized === lastView) return;
      lastView = serialized;
      for (const listener of listeners) {
        try { listener(next); } catch (error) { warn(`a change listener failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
    });
  };

  // ---- timers ----

  const clearConnTimer = (conn: Connection): void => {
    if (conn.timer) clearTimer(conn.timer);
    conn.timer = null;
  };

  /**
   * Sets the connection's one timer: for its next refresh while it is in use, for the removal of
   * a record with no refresh token when it expires, and to report the expiry itself.
   */
  const plan = (conn: Connection): void => {
    clearConnTimer(conn);
    const record = conn.record;
    if (!active || !record) return;
    const at = now();
    const removal = record.refreshToken === null;
    let wake = conn.nextAt !== null && (removal || isInUse(conn.id)) ? conn.nextAt : Infinity;
    if (record.expiresAt !== null && record.expiresAt > at) wake = Math.min(wake, record.expiresAt);
    if (wake === Infinity) return;
    conn.timer = setTimer(() => fire(conn), Math.min(Math.max(0, wake - at), MAX_TIMER_MS));
    conn.timer.unref?.();
  };

  const fire = (conn: Connection): void => {
    conn.timer = null;
    const record = conn.record;
    if (!active || !record) return;
    notify();
    if (conn.nextAt === null || now() < conn.nextAt) {
      plan(conn);
      return;
    }
    if (record.refreshToken === null) {
      remove(conn, "signInAgain");
      return;
    }
    // Not refreshed while no shaper uses it; still woken to report its expiry.
    if (!isInUse(conn.id)) {
      plan(conn);
      return;
    }
    runRefresh(conn, conn.held ?? "due");
  };

  const planPending = (conn: Connection): void => {
    const pending = conn.pending;
    if (!pending) return;
    if (pending.timer) clearTimer(pending.timer);
    pending.timer = null;
    if (!active) return;
    pending.timer = setTimer(() => {
      pending.timer = null;
      if (conn.pending === pending) dropPending(conn);
      notify();
    }, Math.max(0, pending.expiresAt - now()));
    pending.timer.unref?.();
  };

  const dropPending = (conn: Connection): void => {
    if (conn.pending?.timer) clearTimer(conn.pending.timer);
    conn.pending = null;
  };

  // ---- connections, the store queue, storing and removing ----

  const ensure = (id: string, target: SignInTarget): Connection => {
    let conn = connections.get(id);
    if (!conn) {
      conn = {
        id, target: { url: target.url, scope: target.scope, issuer: target.issuer },
        record: null, generation: 0, storage: null, reason: null, refusedGeneration: null, pending: null, completing: null, removing: null, discovery: null,
        refreshing: null, nextAt: null, held: null, timer: null, retries: 0, refusals: 0, lastRefusalRefreshAt: null,
      };
      connections.set(id, conn);
    }
    return conn;
  };

  /**
   * Each connection's store calls, by id: a connection only the signed-out list names, with no
   * target known, still has its removal ordered with every other store call for that id.
   */
  const queues = new Map<string, Promise<void>>();

  /** Runs `op` after every store call asked for before it on this connection. */
  const enqueue = <T>(id: string, op: () => Promise<T>): Promise<T> => {
    const run = (queues.get(id) ?? Promise.resolve()).then(op);
    const tail = run.then(() => undefined, () => undefined);
    queues.set(id, tail);
    void track(tail).then(() => { if (queues.get(id) === tail) queues.delete(id); });
    return run;
  };

  // ---- the signed-out list ----

  /**
   * Counts the sign-outs marked for each connection since the daemon started, and across every
   * connection. An entry is cleared only by a store call that began after the last mark, so a
   * removal or a write that a later sign-out overtook never clears that sign-out's entry. Counts,
   * not times: no clock is compared.
   */
  const marks = new Map<string, number>();
  let marksTotal = 0;

  const emptyConfig = (): ShapingSignInConfig => ({ clients: [], signedOut: [], signedOutOverflow: false });

  /** `shaping.signIn`, or null when it cannot be read: an unparseable value is unreadable, never empty. */
  const readConfig = (): ShapingSignInConfig | null => {
    try {
      return deps.registrations.read();
    } catch (error) {
      warn(`the sign-in settings could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  /**
   * Sign-outs whose entry `app_config` refused to save. Every later write of the key carries
   * them, and each one's store-call turn tries again before asking the store, so the entry is
   * saved as soon as the key takes a write. The store is still asked meanwhile: a confirmed
   * removal is the other way the sign-out holds, and not asking would leave the record certain
   * to load.
   */
  const unsaved = new Set<string>();

  /** Adds every unsaved sign-out to `value`, setting the overflow mark when the list is full. */
  const withUnsaved = (value: ShapingSignInConfig): ShapingSignInConfig => {
    let { signedOut, signedOutOverflow } = value;
    for (const id of unsaved) {
      if (signedOut.includes(id)) continue;
      if (signedOut.length < SHAPING_SIGNED_OUT_CONNECTIONS) signedOut = [...signedOut, id];
      else signedOutOverflow = true;
    }
    return { ...value, signedOut, signedOutOverflow };
  };

  const writeConfig = (value: ShapingSignInConfig): boolean => {
    try {
      deps.registrations.write(withUnsaved(value));
      unsaved.clear();
      return true;
    } catch (error) {
      warn(`the sign-in settings could not be saved: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  /**
   * What fails closed puts in place of a value that cannot be read: no registration, which only
   * costs reuse, and the overflow mark, so no stored record loads until a start removes them all.
   */
  const failClosed = (): ShapingSignInConfig => ({ ...emptyConfig(), signedOutOverflow: true });

  /**
   * Lists the connection as signed out, before the store is asked to remove its record, so a
   * restart never loads that record whatever the store answers. A full list sets the overflow
   * mark instead: no entry is ever dropped to make room.
   */
  const markSignedOut = (id: string): void => {
    marks.set(id, (marks.get(id) ?? 0) + 1);
    marksTotal += 1;
    const value = readConfig() ?? failClosed();
    if (value.signedOut.includes(id) && unsaved.size === 0) return;
    unsaved.add(id);
    saveUnsaved(value);
  };

  /** Writes the unsaved sign-outs into the key. While it refuses, only a confirmed removal keeps a restart from loading them. */
  const saveUnsaved = (value: ShapingSignInConfig | null = readConfig() ?? failClosed()): void => {
    if (unsaved.size === 0 || !value) return;
    if (!writeConfig(value)) warn("a sign-out could not be saved yet: it is tried again before each store call, and until then only a confirmed removal keeps a restart from loading it");
  };

  /** Clears the connection's entry after a confirmed store call that began at mark count `since`. */
  const clearSignedOut = (id: string, since: number | undefined): void => {
    if (marks.get(id) !== since) return;
    // The store confirmed it: an entry not saved yet no longer needs saving.
    unsaved.delete(id);
    const value = readConfig();
    if (!value?.signedOut.includes(id)) return;
    writeConfig({ ...value, signedOut: value.signedOut.filter((entry) => entry !== id) });
  };

  /** Asks the store to remove the record, and on its confirmation clears the entry. Throws what the store throws. */
  const storeRemove = async (id: string): Promise<void> => {
    const since = marks.get(id);
    // Saved before the store is asked, if `app_config` refused it the first time.
    if (unsaved.has(id)) saveUnsaved();
    await getStore().remove(id);
    clearSignedOut(id, since);
  };

  const removalRefused = (error: unknown): void => {
    warn(`a stored sign-in could not be removed, so it stays signed out until a removal succeeds: ${error instanceof Error ? error.message : String(error)}`);
  };

  /**
   * Removes the stored record in its turn, unless a newer record was stored by then. The
   * connection is listed as signed out first, so a removal the store refuses still keeps the
   * record from loading after a restart, and a later start tries the removal again.
   */
  const removeStored = (conn: Connection): Promise<void> => {
    const decidedFor = conn.generation;
    markSignedOut(conn.id);
    const removing = enqueue(conn.id, async () => {
      // A newer record was stored since: this removal was for the one before it.
      if (conn.generation !== decidedFor) return;
      try {
        await storeRemove(conn.id);
      } catch (error) {
        removalRefused(error);
      }
    });
    conn.removing = removing;
    return removing;
  };

  /** `work`, or nothing once `ms` have passed. */
  const within = (work: Promise<unknown>, ms: number): Promise<void> => {
    let timer: TimerHandle | null = null;
    const deadline = new Promise<void>((done) => {
      timer = setTimer(done, ms);
      timer.unref?.();
    });
    return Promise.race([work.then(() => undefined, () => undefined), deadline]).finally(() => { if (timer) clearTimer(timer); });
  };

  /**
   * Writes `record` and then puts it in memory, in one turn. `stillWanted` is asked when the
   * turn comes and again when the write is done: a refresh asks whether the record it started
   * from is still the connection's, a completion whether it was signed out meanwhile. When it
   * answers no, nothing more is written or kept and the answer is false. A record written and
   * then not kept is undone in the same turn: the store is put back to what memory holds, so a
   * later write for the connection, which runs after this turn, still stands.
   */
  const commit = (conn: Connection, record: StoredSignIn, stillWanted: () => boolean, newSignIn: boolean): Promise<boolean> =>
    enqueue(conn.id, async () => {
      if (!stillWanted()) return false;
      let storage: SignInStorage = getStore().kind;
      let reason: SignInReason | null = null;
      let written = false;
      const since = marks.get(conn.id);
      try {
        await getStore().write(conn.id, record);
        written = true;
      } catch (error) {
        storage = "memory";
        reason = "memoryOnly";
        warn(`a sign-in is kept in memory only: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!stillWanted()) {
        // Signed out, superseded or replaced meanwhile: what this turn wrote is not left behind.
        if (written) await restoreStored(conn);
        return false;
      }
      // A wanted write replaced whatever was stored: a sign-out listed before it began is done.
      if (written) clearSignedOut(conn.id, since);
      conn.record = record;
      conn.generation += 1;
      conn.storage = storage;
      conn.reason = reason;
      conn.refusedGeneration = null;
      conn.held = null;
      conn.retries = 0;
      conn.nextAt = refreshDue(record);
      if (newSignIn) {
        conn.refusals = 0;
        conn.lastRefusalRefreshAt = null;
      }
      plan(conn);
      notify();
      return true;
    });

  /** Puts the store back to what memory holds for the connection: its record, or none. */
  const restoreStored = async (conn: Connection): Promise<void> => {
    try {
      if (conn.record) await getStore().write(conn.id, conn.record);
      else {
        markSignedOut(conn.id);
        await storeRemove(conn.id);
      }
    } catch (error) {
      warn(`a stored sign-in could not be put back: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** Clears the record from memory at once, then removes the stored one in its turn. */
  const remove = (conn: Connection, reason: SignInReason | null): StoredSignIn | null => {
    const record = conn.record;
    if (!record) return null;
    conn.record = null;
    conn.generation += 1;
    conn.storage = null;
    conn.reason = reason;
    conn.refusedGeneration = null;
    conn.nextAt = null;
    conn.held = null;
    conn.retries = 0;
    clearConnTimer(conn);
    void removeStored(conn);
    notify();
    return record;
  };

  /** The client a record names, read from the record itself, so a key that lost it does not matter. */
  const clientOf = (record: Pick<StoredSignIn, "issuer" | "clientId" | "target">): SignInClient => ({
    issuer: record.issuer,
    clientId: record.clientId,
    redirectUri: deps.redirectUri,
    scope: record.target.scope,
    registeredAt: 0,
  });

  const discoveryFor = async (conn: Connection, bound?: number): Promise<SignInDiscovery | null> => {
    if (conn.discovery) return conn.discovery;
    const found = await deps.flow.discover(conn.target, flowOptions(bound));
    if (!found.ok) {
      warn(found.reason);
      return null;
    }
    return (conn.discovery = found.discovery);
  };

  /** Revokes a pair, best effort, within `REVOKE_DEADLINE_MS`. */
  const revokePair = (conn: Connection, record: Pick<StoredSignIn, "issuer" | "clientId" | "accessToken" | "refreshToken" | "target">): Promise<void> => {
    let timer: TimerHandle | null = null;
    const work = (async () => {
      const discovery = await discoveryFor(conn, REVOKE_DEADLINE_MS);
      if (!discovery) return;
      const client = clientOf(record);
      for (const token of [record.refreshToken, record.accessToken]) {
        if (!token) continue;
        const result = await deps.flow.revoke(discovery, client, token, flowOptions(REVOKE_DEADLINE_MS));
        if (!result.ok) warn(result.reason);
      }
    })().catch((error) => warn(`revoking a sign-in failed: ${error instanceof Error ? error.message : String(error)}`));
    const deadline = new Promise<void>((done) => {
      timer = setTimer(done, REVOKE_DEADLINE_MS);
      timer.unref?.();
    });
    // The work is tracked until it settles, so `idle()` waits for every revoke; the bound is only for the caller.
    void track(work);
    return Promise.race([work, deadline]).finally(() => { if (timer) clearTimer(timer); });
  };

  // ---- refresh ----

  /** Every record and pending sign-in that names this client, and its registration, are removed. */
  const rejectClient = (issuer: string, clientId: string): void => {
    const names = (client: { issuer: string; clientId: string }) => client.clientId === clientId && issuersMatch(client.issuer, issuer);
    for (const conn of connections.values()) {
      if (conn.record && names(conn.record)) remove(conn, "signInAgain");
      if (conn.pending && names(conn.pending.client)) dropPending(conn);
      if (conn.completing && names(conn.completing.client)) conn.completing = null;
    }
    const value = readConfig();
    const kept = value?.clients.filter((client) => !names(client));
    if (!value || !kept) warn("a rejected client registration could not be removed: the sign-in settings could not be read");
    else if (kept.length !== value.clients.length) writeConfig({ ...value, clients: kept });
    notify();
  };

  const runRefresh = (conn: Connection, trigger: RefreshTrigger): void => {
    const record = conn.record;
    if (!active || conn.refreshing || !record?.refreshToken) return;
    const refreshToken = record.refreshToken;
    const generation = conn.generation;
    conn.held = null;
    conn.nextAt = null;
    clearConnTimer(conn);
    if (trigger === "refusal") {
      conn.refusals += 1;
      conn.lastRefusalRefreshAt = now();
    }
    const run = (async () => {
      const discovery = await discoveryFor(conn);
      const result: RefreshResult = discovery
        ? await deps.flow.refresh(discovery, clientOf(record), refreshToken, { ...flowOptions(), grantedScope: record.scope ?? record.target.scope })
        : { ok: false, code: "retry", reason: "The server's sign-in metadata could not be read." };
      if (!result.ok) {
        // The record it was for is gone or replaced: whatever the answer, there is nothing to end.
        if (conn.generation !== generation) return;
        if (result.code === "retry") {
          warn(result.reason);
          conn.retries += 1;
          conn.held = "retry";
          conn.nextAt = now() + backoff(conn.retries);
          plan(conn);
          notify();
        } else if (result.code === "client_rejected") {
          rejectClient(record.issuer, record.clientId);
        } else {
          remove(conn, "signInAgain");
        }
        return;
      }
      const tokens: SignInTokens = result.tokens;
      const next: StoredSignIn = {
        ...record,
        accessToken: tokens.accessToken,
        // RFC 6749 section 6: a reply with no refresh token leaves the one held valid.
        refreshToken: tokens.refreshToken ?? refreshToken,
        expiresAt: tokens.expiresAt,
        scope: tokens.scope,
        obtainedAt: tokens.obtainedAt,
      };
      const kept = await commit(conn, next, () => conn.generation === generation, false);
      if (!kept) {
        // Signed out, removed or replaced meanwhile: keep nothing, and revoke what was received.
        await revokePair(conn, next);
        return;
      }
      if (trigger === "due") {
        conn.refusals = 0;
        conn.lastRefusalRefreshAt = null;
      }
    })().catch((error) => {
      warn(`a refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      conn.refreshing = null;
      // A refresh that fell due while this one ran was not started: plan it now.
      plan(conn);
    });
    conn.refreshing = track(run);
  };

  /** A call asks for a refresh: started only when none runs and no later try is set. */
  const askRefresh = (conn: Connection, why: "expired" | "refusal"): void => {
    if (!active || !conn.record?.refreshToken || conn.refreshing || conn.held) return;
    if (why === "expired") {
      runRefresh(conn, "expired");
      return;
    }
    const wait = conn.refusals === 0 ? 0 : backoff(conn.refusals);
    const earliest = conn.lastRefusalRefreshAt === null ? -Infinity : conn.lastRefusalRefreshAt + wait;
    if (now() >= earliest) {
      runRefresh(conn, "refusal");
      return;
    }
    conn.held = "refusal";
    conn.nextAt = earliest;
    plan(conn);
  };

  // ---- the flags and the load ----

  const load = async (): Promise<void> => {
    loadsActive += 1;
    try {
      await loadStore();
    } finally {
      loadsActive -= 1;
    }
  };

  /**
   * Removes a listed connection's stored record in its turn, while it is still listed. A record
   * memory holds from a write the store took is kept: only the overflow mark lists it then.
   */
  const resolveSignedOut = (id: string): Promise<boolean> => enqueue(id, async () => {
    const value = readConfig();
    if (value && !value.signedOut.includes(id) && !value.signedOutOverflow && !unsaved.has(id)) return true;
    const conn = connections.get(id);
    if (conn?.record && conn.reason !== "memoryOnly") return true;
    try {
      await storeRemove(id);
      return true;
    } catch (error) {
      removalRefused(error);
      return false;
    }
  });

  const loadStore = async (): Promise<void> => {
    const source = getStore();
    const own = activation;
    // Switched off, or switched on again with a load of its own: this one reads and publishes nothing more.
    const over = () => !active || activation !== own;
    const marksAtStart = marksTotal;
    // Read before the store is: an id listed as signed out is never installed, whenever it was written.
    let config = readConfig();
    if (!config) {
      // Unreadable is not empty: it may list sign-outs. Fail closed, and say so in the key.
      config = failClosed();
      warn("the sign-in settings could not be read, so no stored sign-in is loaded and every one is removed");
      writeConfig(config);
    }
    // Sign-outs `app_config` refused earlier in this daemon's life count as listed, and are saved now if it takes the write.
    saveUnsaved(config);
    const signedOut = new Set([...config.signedOut, ...unsaved]);
    const overflow = config.signedOutOverflow;
    let incomplete = false;
    let listed = true;
    let ids: string[] = [];
    try {
      ids = await source.ids();
    } catch (error) {
      incomplete = true;
      listed = false;
      warn(`the stored sign-ins could not be listed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (over()) return;
    // Every listed connection, and with the overflow mark every stored one, is removed in its turn.
    const resolving = [...new Set([...signedOut, ...(overflow ? ids : [])])].map(resolveSignedOut);
    if (overflow) {
      // The mark clears once a full listing's records were all removed, with no sign-out since this load began.
      void track(Promise.all(resolving).then((done) => {
        if (!listed || !done.every(Boolean) || marksTotal !== marksAtStart) return;
        const value = readConfig();
        if (value?.signedOutOverflow) writeConfig({ ...value, signedOutOverflow: false });
      }));
    }
    for (const id of ids) {
      if (over()) return;
      if (overflow || signedOut.has(id)) continue;
      let record: StoredSignIn | null;
      try {
        record = await source.read(id);
      } catch (error) {
        incomplete = true;
        warn(`a stored sign-in could not be read: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (over()) return;
      if (!record || connectionId(record.target) !== id) continue;
      const conn = ensure(id, record.target);
      // Memory already decided this connection's record since the daemon started: it wins.
      if (conn.generation > 0) continue;
      conn.record = record;
      conn.generation = 1;
      conn.storage = source.kind;
      conn.nextAt = refreshDue(record);
    }
    if (over()) return;
    loadIncomplete = incomplete;
  };

  /** Until the load that is current when it ends has ended, so a load stopped by a flag reset is never taken for the one after it. */
  const loaded = async (): Promise<void> => {
    for (;;) {
      const current = loading;
      await current;
      if (current === loading) return;
    }
  };

  const reconcile = (): void => {
    const on = started && !stopped && deps.enabled();
    if (on === active) return;
    active = on;
    if (on) {
      activation += 1;
      for (const conn of connections.values()) {
        conn.refusals = 0;
        conn.lastRefusalRefreshAt = null;
      }
      loading = track(load().catch((error) => {
        loadIncomplete = true;
        warn(`loading the stored sign-ins failed: ${error instanceof Error ? error.message : String(error)}`);
      }).then(() => {
        if (!active) return;
        for (const conn of connections.values()) {
          plan(conn);
          planPending(conn);
        }
        notify();
      }));
    } else {
      for (const conn of connections.values()) {
        clearConnTimer(conn);
        if (conn.pending?.timer) clearTimer(conn.pending.timer);
        if (conn.pending) conn.pending.timer = null;
      }
    }
    notify();
  };

  // ---- begin and complete ----

  /** The registrations a held record or a live pending sign-in names. */
  const named = (client: ShapingSignInClient): boolean => {
    const names = (other: { issuer: string; clientId: string }) => other.clientId === client.clientId && issuersMatch(other.issuer, client.issuer);
    for (const conn of connections.values()) {
      if (conn.record && names(conn.record)) return true;
      const pending = livePending(conn);
      if (pending && names(pending.client)) return true;
    }
    return false;
  };

  const oldestUnnamed = (clients: readonly ShapingSignInClient[]): ShapingSignInClient | null =>
    clients.filter((client) => !named(client)).sort((a, b) => a.registeredAt - b.registeredAt)[0] ?? null;

  const refusal = (code: keyof typeof SIGN_IN_BEGIN_REFUSALS): BeginAnswer => ({ ok: false, code, reason: SIGN_IN_BEGIN_REFUSALS[code] });

  const setPending = (conn: Connection, pending: Pending): void => {
    dropPending(conn);
    const held = [...connections.values()].filter((other) => other.pending).sort((a, b) => a.pending!.createdAt - b.pending!.createdAt);
    for (const other of held.slice(0, Math.max(0, held.length - (PENDING_SIGN_INS - 1)))) dropPending(other);
    conn.pending = pending;
    planPending(conn);
  };

  const beginNow = async (target: SignInTarget, abandoned: () => boolean): Promise<BeginAnswer> => {
    // Timed out while waiting its turn: no request at all.
    if (abandoned()) return refusal("timeout");
    if (!active) return refusal("flag_off");
    // Bound to this activation: a flag reset since means another load decides what is named.
    const own = activation;
    const reset = () => !active || activation !== own;
    const found = await deps.flow.discover(target, flowOptions());
    if (!found.ok) return { ok: false, code: found.code, reason: found.reason };
    if (reset()) return refusal("flag_off");
    const discovery = found.discovery;
    const conn = ensure(connectionId(target), target);
    conn.discovery = discovery;
    const matches = (client: ShapingSignInClient) =>
      issuersMatch(client.issuer, discovery.authorizationServer) && client.redirectUri === deps.redirectUri && client.scope === target.scope;
    const config = readConfig();
    // Unreadable: which registrations a held record names, and which sign-outs it lists, are unknown.
    if (!config) return refusal("store_unread");
    const clients = config.clients;
    const reuse = clients.find(matches) ?? null;
    // Timed out while discovering: no registration request, and nothing saved.
    if (abandoned()) return refusal("timeout");
    let result: BeginResult;
    if (reuse) {
      result = await deps.flow.begin(target, discovery, { ...reuse }, deps.redirectUri, flowOptions());
    } else {
      if (clients.length >= SHAPING_SIGN_IN_CLIENTS) {
        if (loadIncomplete) return refusal("store_unread");
        if (!oldestUnnamed(clients)) return refusal("registration_limit");
      }
      result = await deps.flow.begin(target, discovery, null, deps.redirectUri, flowOptions());
      if (result.ok && abandoned()) return refusal("timeout");
      if (result.ok && reset()) return refusal("flag_off");
      if (result.ok) {
        // In one write: room made from what is held now, and the new registration saved. The
        // signed-out list is written back as it was read, in the same synchronous step.
        const current = readConfig();
        if (!current) return refusal("store_unread");
        let kept = current.clients;
        if (kept.length >= SHAPING_SIGN_IN_CLIENTS) {
          const drop = loadIncomplete ? null : oldestUnnamed(kept);
          if (!drop) return refusal(loadIncomplete ? "store_unread" : "registration_limit");
          kept = kept.filter((client) => client !== drop);
        }
        if (!writeConfig({ ...current, clients: [...kept, { ...result.client }] })) return refusal("store_unread");
      }
    }
    if (!result.ok) return { ok: false, code: result.code, reason: result.reason };
    if (abandoned()) return refusal("timeout");
    if (!active) return refusal("flag_off");
    const at = now();
    setPending(conn, {
      state: result.state, codeVerifier: result.codeVerifier, client: result.client, discovery,
      createdAt: at, expiresAt: at + PENDING_SIGN_IN_MS, timer: null,
    });
    notify();
    return { ok: true, connection: conn.id, authorizationUrl: result.authorizationUrl, expiresAt: at + PENDING_SIGN_IN_MS };
  };

  const begin = (target: SignInTarget): Promise<BeginAnswer> => {
    if (!active) return Promise.resolve(refusal("flag_off"));
    let gaveUp = false;
    // One at a time, after the load: two sign-ins started together cannot register twice for
    // the same issuer, redirect URI and scope, or both take the last place.
    const work = beginTail.then(loaded).then(() => beginNow(target, () => gaveUp));
    beginTail = work.catch(() => undefined);
    void track(beginTail);
    let timer: TimerHandle | null = null;
    const deadline = new Promise<BeginAnswer>((done) => {
      timer = setTimer(() => {
        gaveUp = true;
        done(refusal("timeout"));
      }, BEGIN_DEADLINE_MS);
      timer.unref?.();
    });
    return Promise.race([work, deadline]).finally(() => { if (timer) clearTimer(timer); });
  };

  const completeRefusal = (code: keyof typeof SIGN_IN_COMPLETE_REFUSALS): CompleteAnswer =>
    ({ ok: false, code, reason: SIGN_IN_COMPLETE_REFUSALS[code] });

  // Work in flight, so `idle()` and the bounded wait in `stop()` let an exchange store or revoke what it receives.
  const complete = (callback: SignInCallback): Promise<CompleteAnswer> => track(completeNow(callback));

  const completeNow = async (callback: SignInCallback): Promise<CompleteAnswer> => {
    if (!active) return completeRefusal("flag_off");
    const state = typeof callback.state === "string" ? callback.state : "";
    let conn: Connection | null = null;
    // Every pending `state` is compared, so the time taken does not say which one matched.
    for (const candidate of connections.values()) {
      if (candidate.pending && sameSecret(candidate.pending.state, state) && state !== "") conn = candidate;
    }
    const pending = conn?.pending ?? null;
    // Removed before anything else, so a `state` works once.
    if (conn) dropPending(conn);
    notify();
    if (!conn || !pending || pending.expiresAt <= now()) return completeRefusal("unknown_state");
    if (callback.error) return completeRefusal("denied");
    if (!callback.code) return completeRefusal("no_code");
    if (callback.iss != null && !issuersMatch(callback.iss, pending.discovery.metadata.issuer)) return completeRefusal("wrong_issuer");
    const target = conn;
    // From here until it is kept, a sign-out or a rejected client cancels this completion.
    const marker = { client: pending.client };
    target.completing = marker;
    const wanted = () => target.completing === marker;
    try {
      const result = await deps.flow.exchange(target.target, pending.discovery, pending.client, {
        code: callback.code, codeVerifier: pending.codeVerifier, redirectUri: pending.client.redirectUri, iss: callback.iss ?? null,
      }, flowOptions());
      if (!result.ok) {
        if (result.code === "client_rejected") rejectClient(pending.client.issuer, pending.client.clientId);
        return { ok: false, code: result.code, reason: result.reason };
      }
      const tokens = result.tokens;
      const record: StoredSignIn = {
        v: 1,
        target: target.target,
        issuer: pending.client.issuer,
        clientId: pending.client.clientId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scope: tokens.scope,
        obtainedAt: tokens.obtainedAt,
      };
      if (!wanted() || !(await commit(target, record, wanted, true))) {
        // Signed out while the code was exchanged or stored: keep nothing, and revoke what was received.
        await revokePair(target, record);
        return completeRefusal("cancelled");
      }
      return { ok: true, connection: target.id };
    } finally {
      if (target.completing === marker) target.completing = null;
    }
  };

  // ---- the rest of the surface ----

  const accessToken = (target: SignInTarget): AccessTokenAnswer => {
    if (!active) return { ok: false, reason: "flagOff" };
    const id = connectionId(target);
    const conn = connections.get(id);
    if (!asked.has(id)) {
      asked.add(id);
      if (conn) plan(conn);
    }
    if (!conn?.record || livePending(conn)) return { ok: false, reason: "signedOut" };
    if (refused(conn)) return { ok: false, reason: "renewing" };
    const record = conn.record;
    if (record.expiresAt === null || record.expiresAt > now()) return { ok: true, token: record.accessToken };
    if (record.refreshToken !== null) {
      queueMicrotask(() => askRefresh(conn, "expired"));
      notify();
      return { ok: false, reason: "renewing" };
    }
    remove(conn, "signInAgain");
    return { ok: false, reason: "signedOut" };
  };

  const noteRefused = (target: SignInTarget, refusedToken: string): void => {
    if (!active) return;
    const id = connectionId(target);
    asked.add(id);
    const conn = connections.get(id);
    if (!conn?.record) return;
    // A refusal of a token already replaced says nothing about the one held now.
    if (!sameSecret(refusedToken, conn.record.accessToken)) return;
    if (conn.record.refreshToken === null) {
      remove(conn, "signInAgain");
      return;
    }
    conn.refusedGeneration = conn.generation;
    notify();
    queueMicrotask(() => askRefresh(conn, "refusal"));
  };

  const signOut = async (id: string): Promise<boolean> => {
    if (!active) return false;
    const conn = connections.get(id);
    if (!conn) return false;
    const hadPending = conn.pending !== null;
    const hadCompletion = conn.completing !== null;
    dropPending(conn);
    // A completion still exchanging its code keeps nothing now.
    conn.completing = null;
    // A load still reading the store may hold this connection's record and not have installed
    // it yet: decided now, as any change in memory is, so the load skips it.
    const duringLoad = loadsActive > 0 && conn.record === null;
    if (duringLoad) conn.generation += 1;
    const record = remove(conn, null);
    let removal: Promise<void> | null = record ? conn.removing : null;
    // A completion may already be writing its record, or the load may have read one: the removal
    // queued behind clears it.
    if (!record && (hadCompletion || duringLoad)) removal = removeStored(conn);
    notify();
    // The store's removal, and the revocation, within their bound.
    await within(Promise.all([removal, record ? revokePair(conn, record) : undefined]), REVOKE_DEADLINE_MS);
    return record !== null || hadPending || hadCompletion || duringLoad;
  };

  const setInUse = (list: readonly SignInUse[]): void => {
    const next = new Map<string, { target: SignInTarget; shapers: Set<string> }>();
    for (const use of list) {
      const id = connectionId(use.target);
      const entry = next.get(id) ?? { target: use.target, shapers: new Set<string>() };
      for (const shaper of use.shapers) entry.shapers.add(shaper);
      next.set(id, entry);
      ensure(id, use.target);
    }
    inUse = next;
    for (const conn of connections.values()) plan(conn);
    notify();
  };

  const idle = async (): Promise<void> => {
    for (;;) {
      const waiting = [...inflight];
      if (waiting.length === 0) return;
      await Promise.allSettled(waiting);
      // Let the turns that just settled report and queue what follows them.
      await new Promise<void>((done) => setImmediate(done));
    }
  };

  return {
    start() {
      if (started || stopped) return;
      started = true;
      stopFlags = deps.onEnabledChanged(reconcile);
      reconcile();
    },
    async stop() {
      stopped = true;
      // The daemon is going away: windows are not told its sign-ins are gone.
      listeners.clear();
      stopFlags?.();
      stopFlags = null;
      reconcile();
      // A refresh in flight is let finish, so its rotated pair is stored, within a bound.
      let timer: TimerHandle | null = null;
      await Promise.race([idle(), new Promise<void>((done) => {
        timer = setTimer(done, STOP_DEADLINE_MS);
        timer.unref?.();
      })]);
      if (timer) clearTimer(timer);
    },
    accessToken,
    noteRefused,
    begin,
    complete,
    signOut,
    setInUse,
    view,
    onChanged(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    idle,
  };
}
