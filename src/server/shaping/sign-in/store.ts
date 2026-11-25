import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { stateDir } from "@shared/harness-runtime.mjs";
import { loadNativeKeychainBinding, type NativeKeychainBinding } from "./keychain-native.ts";

/**
 * Where a shaper's sign-in is kept: one record per connection, in the macOS Keychain or in
 * daemon memory, behind one asynchronous interface.
 *
 * A record is never written to a file, logged, or put in an error. The Keychain backend
 * hands it to the native addon as a call argument, which is not a process argument list:
 * no command is spawned. The store never falls back from one backend to the other in the
 * middle of a call, so a caller always knows where a record went.
 */

/**
 * The Keychain item's service. Fixed: renaming it would strand every stored sign-in, so no
 * later change may alter it.
 */
export const SIGN_IN_KEYCHAIN_SERVICE = "Mission Control shaper sign-in";

/** Selects the backend. `memory` forces memory; unset or `keychain` lets the platform decide. */
export const SIGN_IN_STORE_ENV = "SHAPER_SIGN_IN_STORE";

const NonEmpty = z.string().min(1);
const Timestamp = z.number().nonnegative();

/**
 * One connection's sign-in, and the only definition of it: the exported type is inferred from
 * this schema, so what the store validates and what callers are promised cannot drift apart.
 * `target` (the connection's URL, scope and issuer) and `clientId` (the client that obtained
 * the tokens, which every refresh uses) are not secrets; they name the sign-in after a
 * restart. A record with any other `v` reads as null.
 */
const StoredSignInSchema = z.strictObject({
  v: z.literal(1),
  target: z.strictObject({ url: NonEmpty, scope: NonEmpty, issuer: NonEmpty.nullable() }),
  issuer: NonEmpty,
  clientId: NonEmpty,
  accessToken: NonEmpty,
  refreshToken: NonEmpty.nullable(),
  expiresAt: Timestamp.nullable(),
  scope: NonEmpty.nullable(),
  obtainedAt: Timestamp,
});

/** `{ v: 1, target: { url, scope, issuer }, issuer, clientId, accessToken, refreshToken, expiresAt, scope, obtainedAt }` */
export type StoredSignIn = z.infer<typeof StoredSignInSchema>;

export type SignInStorage = "keychain" | "memory";

export interface SignInStore {
  readonly kind: SignInStorage;
  /** The record, or null when there is none or what is stored is not a valid record. */
  read(id: string): Promise<StoredSignIn | null>;
  /** Adds the record, or replaces the one stored under this id. */
  write(id: string, record: StoredSignIn): Promise<void>;
  /** Removes the record. Removing one that is not there is not an error. */
  remove(id: string): Promise<void>;
  /** Every id with a record in this state home, sorted. */
  ids(): Promise<string[]>;
}

export type SignInStoreOperation = "read" | "write" | "remove" | "ids";

/**
 * A Keychain call failed. Carries the Security framework's OSStatus when there is one, and
 * nothing else from the failure: never the record, never the addon's own text.
 */
export class SignInStoreError extends Error {
  constructor(
    readonly operation: SignInStoreOperation,
    readonly status: number | null,
  ) {
    super(
      `the Keychain could not ${operation === "ids" ? "list" : operation} a shaper sign-in` +
        (status === null ? "" : ` (status ${status})`),
    );
    this.name = "SignInStoreError";
  }
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

function checkId(id: string): void {
  if (typeof id !== "string" || !ID.test(id)) {
    throw new TypeError("a shaper sign-in id must be 1 to 128 letters, digits, '-' or '_'");
  }
}

/** The record as stored, or a fixed TypeError that quotes none of it. */
function serialize(record: StoredSignIn): string {
  const parsed = StoredSignInSchema.safeParse(record);
  if (!parsed.success) throw new TypeError("not a valid shaper sign-in record");
  return JSON.stringify(parsed.data);
}

function deserialize(value: string | null): StoredSignIn | null {
  if (value === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    return null;
  }
  const parsed = StoredSignInSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** A daemon-lifetime map. Gone when the daemon stops. */
export function createMemorySignInStore(): SignInStore {
  const records = new Map<string, string>();
  return {
    kind: "memory",
    async read(id) {
      checkId(id);
      return deserialize(records.get(id) ?? null);
    },
    async write(id, record) {
      checkId(id);
      records.set(id, serialize(record));
    },
    async remove(id) {
      checkId(id);
      records.delete(id);
    },
    async ids() {
      return [...records.keys()].sort();
    },
  };
}

/**
 * The state home's tag: the first 16 hex characters of the SHA-256 of its real path. A daemon
 * run from a checkout and the packaged app use different homes, so neither sees the other's
 * items. A home that cannot be resolved yet is tagged by its absolute path as written.
 */
export async function stateHomeTag(stateHome: string): Promise<string> {
  let path: string;
  try {
    path = await realpath(stateHome);
  } catch {
    path = resolve(stateHome);
  }
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

/** The Keychain account for one record: `<state home tag>/<id>`. */
export function signInAccount(tag: string, id: string): string {
  return `${tag}/${id}`;
}

function statusOf(err: unknown): number | null {
  if (typeof err !== "object" || err === null || !("status" in err)) return null;
  return typeof err.status === "number" && Number.isInteger(err.status) ? err.status : null;
}

/** Runs one addon call, turning any failure into a `SignInStoreError` that carries no text of its own. */
async function keychainCall<T>(operation: SignInStoreOperation, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw new SignInStoreError(operation, statusOf(err));
  }
}

function itemLabel(service: string, record: StoredSignIn): string {
  try {
    return `${service} - ${new URL(record.target.url).host}`;
  } catch {
    return service;
  }
}

export interface KeychainSignInStoreDeps {
  binding: NativeKeychainBinding;
  stateHome: string;
  service?: string;
}

/** One generic password per record, in the login Keychain, never synced to iCloud. */
export function createKeychainSignInStore(deps: KeychainSignInStoreDeps): SignInStore {
  const { binding, stateHome } = deps;
  const service = deps.service ?? SIGN_IN_KEYCHAIN_SERVICE;
  let tag: Promise<string> | null = null;
  const homeTag = () => (tag ??= stateHomeTag(stateHome));

  return {
    kind: "keychain",
    async read(id) {
      checkId(id);
      const account = signInAccount(await homeTag(), id);
      return deserialize(await keychainCall("read", () => binding.get(service, account)));
    },
    async write(id, record) {
      checkId(id);
      const value = serialize(record);
      const account = signInAccount(await homeTag(), id);
      await keychainCall("write", () => binding.set(service, account, value, itemLabel(service, record)));
    },
    async remove(id) {
      checkId(id);
      const account = signInAccount(await homeTag(), id);
      await keychainCall("remove", () => binding.remove(service, account));
    },
    async ids() {
      const prefix = `${await homeTag()}/`;
      const accounts = await keychainCall("ids", () => binding.accounts(service));
      return accounts
        .filter((account) => account.startsWith(prefix))
        .map((account) => account.slice(prefix.length))
        .filter((id) => ID.test(id))
        .sort();
    },
  };
}

export interface SignInStoreDeps {
  /** Host platform. Defaults to `process.platform`; only `darwin` has a Keychain. */
  platform?: NodeJS.Platform;
  /** Environment holding the switch. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Loads the native addon. Defaults to `loadNativeKeychainBinding`. */
  loadBinding?: () => NativeKeychainBinding;
  /** The daemon's state home. Defaults to `stateDir()`. */
  stateHome?: string;
  /** The Keychain service. Tests only: production always uses `SIGN_IN_KEYCHAIN_SERVICE`. */
  service?: string;
  /** Told why the Keychain could not be used when the addon does not load. Never given a record. */
  warn?: (message: string) => void;
}

/** The switch, through the usual `MISSION_` / `FLEET_` / `HARNESS_` chain. */
function storeSwitch(env: NodeJS.ProcessEnv): string | undefined {
  const value =
    env[`MISSION_${SIGN_IN_STORE_ENV}`] ?? env[`FLEET_${SIGN_IN_STORE_ENV}`] ?? env[`HARNESS_${SIGN_IN_STORE_ENV}`];
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

/**
 * Picks the backend once. `memory` when the switch says `memory` (or anything but `keychain`),
 * when the platform is not macOS, or when the addon does not load; otherwise `keychain`.
 */
export function createSignInStore(deps: SignInStoreDeps = {}): SignInStore {
  const platform = deps.platform ?? process.platform;
  const requested = storeSwitch(deps.env ?? process.env);
  if (requested !== undefined && requested !== "keychain") return createMemorySignInStore();
  if (platform !== "darwin") return createMemorySignInStore();

  let binding: NativeKeychainBinding;
  try {
    binding = (deps.loadBinding ?? loadNativeKeychainBinding)();
  } catch (err) {
    deps.warn?.(
      `shaper sign-ins are kept in memory only: ${err instanceof Error ? err.message : String(err)}`,
    );
    return createMemorySignInStore();
  }
  return createKeychainSignInStore({
    binding,
    stateHome: deps.stateHome ?? stateDir(),
    ...(deps.service === undefined ? {} : { service: deps.service }),
  });
}
