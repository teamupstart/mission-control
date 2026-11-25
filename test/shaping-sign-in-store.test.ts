import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  loadNativeKeychainBinding,
  nativeKeychainAddonPath,
  validateNativeKeychainBinding,
  type NativeKeychainBinding,
} from "../src/server/shaping/sign-in/keychain-native.ts";
import {
  SIGN_IN_KEYCHAIN_SERVICE,
  SignInStoreError,
  createKeychainSignInStore,
  createMemorySignInStore,
  createSignInStore,
  stateHomeTag,
  type SignInStore,
  type StoredSignIn,
} from "../src/server/shaping/sign-in/store.ts";

// The record's shape as `phased-plan.md` states the cross-phase contract. `StoredSignIn` is
// inferred from the store's schema; this fails typecheck if a schema edit changes the contract.
type ContractRecord = {
  v: 1;
  target: { url: string; scope: string; issuer: string | null };
  issuer: string;
  clientId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  scope: string | null;
  obtainedAt: number;
};
type Exactly<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const recordMatchesContract: Exactly<StoredSignIn, ContractRecord> = true;
void recordMatchesContract;

// Fake values only. Nothing here is, or resembles, a real credential.
const FAKE_ACCESS = "fake-access-token-7f3a91c2";
const FAKE_REFRESH = "fake-refresh-token-0b8e44d1";

function record(overrides: Partial<StoredSignIn> = {}): StoredSignIn {
  return {
    v: 1,
    target: { url: "https://tools.example.test/mcp", scope: "mcp:context", issuer: null },
    issuer: "https://tools.example.test",
    clientId: "fake-client-1",
    accessToken: FAKE_ACCESS,
    refreshToken: FAKE_REFRESH,
    expiresAt: 1_900_000_000_000,
    scope: "mcp:context",
    obtainedAt: 1_800_000_000_000,
    ...overrides,
  };
}

/** An in-process stand-in for `native/keychain/`, with the same four calls and promises. */
class FakeKeychain implements NativeKeychainBinding {
  readonly items = new Map<string, { value: string; label: string }>();
  failWith: unknown = null;
  readonly calls: string[] = [];

  private key(service: string, account: string) {
    return `${service}\u0000${account}`;
  }

  private check(call: string) {
    this.calls.push(call);
    if (this.failWith !== null) throw this.failWith;
  }

  async get(service: string, account: string) {
    this.check("get");
    return this.items.get(this.key(service, account))?.value ?? null;
  }

  async set(service: string, account: string, value: string, label: string) {
    this.check("set");
    this.items.set(this.key(service, account), { value, label });
  }

  async remove(service: string, account: string) {
    this.check("remove");
    return this.items.delete(this.key(service, account));
  }

  async accounts(service: string) {
    this.check("accounts");
    return [...this.items.keys()]
      .filter((key) => key.startsWith(`${service}\u0000`))
      .map((key) => key.slice(service.length + 1));
  }

  /** Puts a raw value under an account, as another build or a damaged item would. */
  put(service: string, account: string, value: string) {
    this.items.set(this.key(service, account), { value, label: service });
  }
}

function home(): string {
  return mkdtempSync(join(tmpdir(), "mission-sign-in-home-"));
}

function tagOf(path: string): string {
  return createHash("sha256").update(realpathSync(path)).digest("hex").slice(0, 16);
}

// --- The choice of backend ------------------------------------------------------------------

function choose(options: { platform: NodeJS.Platform; env?: NodeJS.ProcessEnv; addon?: "loads" | "fails" }) {
  let loads = 0;
  const warnings: string[] = [];
  const store = createSignInStore({
    platform: options.platform,
    env: options.env ?? {},
    stateHome: home(),
    warn: (message) => warnings.push(message),
    loadBinding: () => {
      loads++;
      if (options.addon === "fails") throw new Error("native Keychain addon could not be loaded from /fake/keychain.node");
      return new FakeKeychain();
    },
  });
  return { kind: store.kind, loads, warnings };
}

test("macOS with a loading addon and no switch keeps sign-ins in the Keychain", () => {
  assert.deepEqual(choose({ platform: "darwin" }), { kind: "keychain", loads: 1, warnings: [] });
  assert.equal(choose({ platform: "darwin", env: { MISSION_SHAPER_SIGN_IN_STORE: "keychain" } }).kind, "keychain");
  assert.equal(choose({ platform: "darwin", env: { MISSION_SHAPER_SIGN_IN_STORE: "  " } }).kind, "keychain");
});

test("the memory switch wins on macOS and never loads the addon", () => {
  assert.deepEqual(choose({ platform: "darwin", env: { MISSION_SHAPER_SIGN_IN_STORE: "memory" } }), {
    kind: "memory",
    loads: 0,
    warnings: [],
  });
  assert.equal(choose({ platform: "darwin", env: { MISSION_SHAPER_SIGN_IN_STORE: "Memory" } }).kind, "memory");
  assert.equal(choose({ platform: "darwin", env: { FLEET_SHAPER_SIGN_IN_STORE: "memory" } }).kind, "memory");
  assert.equal(choose({ platform: "darwin", env: { HARNESS_SHAPER_SIGN_IN_STORE: "memory" } }).kind, "memory");
  assert.equal(
    choose({ platform: "darwin", env: { MISSION_SHAPER_SIGN_IN_STORE: "keychain", FLEET_SHAPER_SIGN_IN_STORE: "memory" } }).kind,
    "keychain",
    "MISSION_ wins over the older prefixes",
  );
});

test("an unrecognised switch value is read as memory, the choice that persists nothing", () => {
  assert.deepEqual(choose({ platform: "darwin", env: { MISSION_SHAPER_SIGN_IN_STORE: "memroy" } }), {
    kind: "memory",
    loads: 0,
    warnings: [],
  });
});

test("off macOS the store is memory, whatever the switch says, and the addon is never loaded", () => {
  for (const platform of ["linux", "win32", "freebsd"] as const) {
    assert.deepEqual(choose({ platform }), { kind: "memory", loads: 0, warnings: [] });
    assert.equal(choose({ platform, env: { MISSION_SHAPER_SIGN_IN_STORE: "keychain" } }).kind, "memory");
  }
});

test("an addon that does not load leaves the store in memory and says why", () => {
  const chosen = choose({ platform: "darwin", addon: "fails" });
  assert.equal(chosen.kind, "memory");
  assert.equal(chosen.loads, 1);
  assert.equal(chosen.warnings.length, 1);
  assert.match(chosen.warnings[0]!, /kept in memory only: native Keychain addon could not be loaded/);
});

// --- The Keychain backend -------------------------------------------------------------------

test("each record is one item under the fixed service, its account the home's tag and the id", async () => {
  const keychain = new FakeKeychain();
  const stateHome = home();
  const store = createKeychainSignInStore({ binding: keychain, stateHome });
  await store.write("a1b2c3", record());

  assert.equal(SIGN_IN_KEYCHAIN_SERVICE, "Mission Control shaper sign-in");
  const [key, item] = [...keychain.items.entries()][0]!;
  const [service, account] = key.split("\u0000");
  assert.equal(service, "Mission Control shaper sign-in");
  assert.match(account!, /^[0-9a-f]{16}\/a1b2c3$/);
  assert.equal(account, `${tagOf(stateHome)}/a1b2c3`);
  assert.equal(item.label, "Mission Control shaper sign-in - tools.example.test");
  assert.deepEqual(JSON.parse(item.value), record());
});

test("the tag is taken from the home's real path, so a symlinked spelling names the same items", async () => {
  const real = home();
  const link = join(home(), "linked-home");
  symlinkSync(real, link);
  assert.equal(await stateHomeTag(link), await stateHomeTag(real));
  assert.equal(await stateHomeTag(real), tagOf(real));

  const keychain = new FakeKeychain();
  await createKeychainSignInStore({ binding: keychain, stateHome: real }).write("conn", record());
  assert.deepEqual(await createKeychainSignInStore({ binding: keychain, stateHome: link }).ids(), ["conn"]);
});

test("two state homes never see each other's records", async () => {
  const keychain = new FakeKeychain();
  const checkout = createKeychainSignInStore({ binding: keychain, stateHome: home() });
  const app = createKeychainSignInStore({ binding: keychain, stateHome: home() });

  await checkout.write("shared-id", record({ clientId: "fake-client-checkout" }));
  await app.write("app-only", record({ clientId: "fake-client-app" }));

  assert.deepEqual(await checkout.ids(), ["shared-id"]);
  assert.deepEqual(await app.ids(), ["app-only"]);
  assert.equal(await app.read("shared-id"), null);
  assert.equal((await checkout.read("shared-id"))?.clientId, "fake-client-checkout");

  await app.remove("shared-id");
  assert.equal((await checkout.read("shared-id"))?.clientId, "fake-client-checkout", "a remove never crosses homes");
});

test("ids() skips this service's accounts that are not this home's or not well formed", async () => {
  const keychain = new FakeKeychain();
  const stateHome = home();
  const tag = tagOf(stateHome);
  keychain.put(SIGN_IN_KEYCHAIN_SERVICE, `${tag}/good`, JSON.stringify(record()));
  keychain.put(SIGN_IN_KEYCHAIN_SERVICE, `${tag}/`, "{}");
  keychain.put(SIGN_IN_KEYCHAIN_SERVICE, `${tag}/has/slash`, "{}");
  keychain.put(SIGN_IN_KEYCHAIN_SERVICE, "0000000000000000/other", "{}");
  keychain.put(SIGN_IN_KEYCHAIN_SERVICE, "no-tag", "{}");
  keychain.put("Some other service", `${tag}/foreign`, "{}");
  assert.deepEqual(await createKeychainSignInStore({ binding: keychain, stateHome }).ids(), ["good"]);
});

test("a test service name keeps its items apart from the product's", async () => {
  const keychain = new FakeKeychain();
  const stateHome = home();
  const product = createKeychainSignInStore({ binding: keychain, stateHome });
  const isolated = createKeychainSignInStore({ binding: keychain, stateHome, service: "Mission Control shaper sign-in test 1234" });
  await isolated.write("only-here", record());
  assert.deepEqual(await product.ids(), []);
  assert.deepEqual(await isolated.ids(), ["only-here"]);
});

// --- Both backends: the interface -----------------------------------------------------------

const backends: Array<[string, () => SignInStore]> = [
  ["keychain", () => createKeychainSignInStore({ binding: new FakeKeychain(), stateHome: home() })],
  ["memory", () => createMemorySignInStore()],
];

for (const [name, make] of backends) {
  test(`${name}: write, read, replace, remove and ids, with target and clientId read back unchanged`, async () => {
    const store = make();
    assert.equal(store.kind, name);
    assert.equal(await store.read("conn-1"), null);
    assert.deepEqual(await store.ids(), []);

    const first = record({ target: { url: "https://tools.example.test/mcp", scope: "mcp:context", issuer: "https://login.example.test" } });
    await store.write("conn-1", first);
    await store.write("conn-0", record({ refreshToken: null, expiresAt: null, scope: null }));
    const read = await store.read("conn-1");
    assert.deepEqual(read, first);
    assert.deepEqual(read?.target, { url: "https://tools.example.test/mcp", scope: "mcp:context", issuer: "https://login.example.test" });
    assert.equal(read?.clientId, "fake-client-1");
    assert.deepEqual(await store.ids(), ["conn-0", "conn-1"]);

    const replaced = record({ accessToken: "fake-access-token-second", clientId: "fake-client-2", obtainedAt: 1_800_000_000_500 });
    await store.write("conn-1", replaced);
    assert.deepEqual(await store.read("conn-1"), replaced);
    assert.deepEqual(await store.ids(), ["conn-0", "conn-1"]);

    await store.remove("conn-1");
    assert.equal(await store.read("conn-1"), null);
    assert.deepEqual(await store.ids(), ["conn-0"]);
    await store.remove("conn-1"); // removing what is not there is not an error
    assert.deepEqual((await store.read("conn-0"))?.refreshToken, null);
  });

  test(`${name}: a read is a copy, so changing it does not change what is stored`, async () => {
    const store = make();
    await store.write("conn", record());
    const read = await store.read("conn");
    read!.accessToken = "fake-mutated";
    read!.target.scope = "mutated";
    assert.deepEqual(await store.read("conn"), record());
  });

  test(`${name}: an invalid record or id is refused with fixed text that quotes no value`, async () => {
    const store = make();
    const invalid = { ...record(), v: 2 } as unknown as StoredSignIn;
    await assert.rejects(store.write("conn", invalid), (err: Error) => {
      assert.ok(err instanceof TypeError);
      assert.equal(err.message, "not a valid shaper sign-in record");
      assert.ok(!err.message.includes(FAKE_ACCESS));
      return true;
    });
    const missing = { ...record(), clientId: "" } as StoredSignIn;
    await assert.rejects(store.write("conn", missing), TypeError);
    const extra = { ...record(), password: FAKE_ACCESS } as StoredSignIn;
    await assert.rejects(store.write("conn", extra), TypeError);
    for (const id of ["", "a/b", "a b", "x".repeat(129)]) {
      await assert.rejects(store.read(id), TypeError);
      await assert.rejects(store.write(id, record()), TypeError);
    }
    assert.deepEqual(await store.ids(), []);
  });
}

// --- What a stored value can be -------------------------------------------------------------

test("a corrupt value, an unknown v and a malformed record each read as null", async () => {
  const keychain = new FakeKeychain();
  const stateHome = home();
  const store = createKeychainSignInStore({ binding: keychain, stateHome });
  const account = (id: string) => `${tagOf(stateHome)}/${id}`;

  keychain.put(SIGN_IN_KEYCHAIN_SERVICE, account("corrupt"), "{not json");
  keychain.put(SIGN_IN_KEYCHAIN_SERVICE, account("later"), JSON.stringify({ ...record(), v: 2, newField: true }));
  keychain.put(SIGN_IN_KEYCHAIN_SERVICE, account("wrong-type"), JSON.stringify({ ...record(), expiresAt: "soon" }));
  keychain.put(SIGN_IN_KEYCHAIN_SERVICE, account("not-object"), JSON.stringify([FAKE_ACCESS]));
  keychain.put(SIGN_IN_KEYCHAIN_SERVICE, account("no-target"), JSON.stringify({ ...record(), target: undefined }));

  for (const id of ["corrupt", "later", "wrong-type", "not-object", "no-target"]) {
    assert.equal(await store.read(id), null, id);
  }
  assert.equal((await store.ids()).length, 5, "unreadable items are still listed, so they can be removed");
});

// --- Failures -------------------------------------------------------------------------------

test("an addon failure rejects with SignInStoreError carrying the status and no value", async () => {
  const keychain = new FakeKeychain();
  const store = createKeychainSignInStore({ binding: keychain, stateHome: home() });
  await store.write("conn", record());

  // The fake's error text holds the token on purpose: the store must not pass it on.
  const failure = Object.assign(new Error(`Keychain set failed for ${FAKE_ACCESS}`), { status: -25308 });
  keychain.failWith = failure;

  const operations: Array<[string, () => Promise<unknown>]> = [
    ["read", () => store.read("conn")],
    ["write", () => store.write("conn", record())],
    ["remove", () => store.remove("conn")],
    ["ids", () => store.ids()],
  ];
  for (const [operation, call] of operations) {
    await assert.rejects(call(), (err: unknown) => {
      assert.ok(err instanceof SignInStoreError, operation);
      assert.equal(err.operation, operation);
      assert.equal(err.status, -25308);
      assert.equal(err.cause, undefined, "the addon's error, and its text, is not attached");
      const visible = `${err.message} ${err.stack ?? ""} ${JSON.stringify(err)}`;
      assert.ok(!visible.includes(FAKE_ACCESS), `${operation}: the access token must not appear`);
      assert.ok(!visible.includes(FAKE_REFRESH), `${operation}: the refresh token must not appear`);
      assert.match(err.message, /status -25308/);
      return true;
    });
  }

  keychain.failWith = new Error("no status at all");
  await assert.rejects(store.read("conn"), (err: unknown) => err instanceof SignInStoreError && err.status === null);
  keychain.failWith = "not an error";
  await assert.rejects(store.read("conn"), (err: unknown) => err instanceof SignInStoreError && err.status === null);

  keychain.failWith = null;
  assert.deepEqual(await store.read("conn"), record(), "a failed call leaves what was stored alone");
});

test("a failing Keychain never falls back to memory in the middle of a call", async () => {
  const keychain = new FakeKeychain();
  const store = createKeychainSignInStore({ binding: keychain, stateHome: home() });
  keychain.failWith = Object.assign(new Error("fail"), { status: -25293 });
  await assert.rejects(store.write("conn", record()), SignInStoreError);
  keychain.failWith = null;
  assert.equal(store.kind, "keychain");
  assert.equal(await store.read("conn"), null, "the record was not kept anywhere else");
});

// --- The loader -----------------------------------------------------------------------------

test("the addon path is dist/native/keychain.node from source and from the server bundle", () => {
  const root = join(tmpdir(), "mission-root");
  assert.equal(
    nativeKeychainAddonPath(pathToFileURL(join(root, "src/server/shaping/sign-in/keychain-native.ts")).href),
    join(root, "dist/native/keychain.node"),
  );
  assert.equal(
    nativeKeychainAddonPath(pathToFileURL(join(root, "dist/server/index.mjs")).href),
    join(root, "dist/native/keychain.node"),
  );
  assert.equal(
    nativeKeychainAddonPath(pathToFileURL(join("/Applications/Mission Control.app/Contents/Resources/app", "dist/server/index.mjs")).href),
    "/Applications/Mission Control.app/Contents/Resources/app/dist/native/keychain.node",
  );
  assert.throws(() => nativeKeychainAddonPath(pathToFileURL(join(root, "elsewhere/index.mjs")).href), /src\/server or dist\/server/);
});

test("the loader refuses an addon missing any of its four functions", () => {
  const complete = { get() {}, set() {}, remove() {}, accounts() {} };
  assert.equal(validateNativeKeychainBinding(complete), complete);
  for (const name of ["get", "set", "remove", "accounts"]) {
    const partial: Record<string, unknown> = { ...complete };
    delete partial[name];
    assert.throws(() => validateNativeKeychainBinding(partial), /must export get, set, remove and accounts/);
    assert.throws(() => validateNativeKeychainBinding({ ...complete, [name]: "not a function" }), /must export/);
  }
  assert.throws(() => validateNativeKeychainBinding(null), /must export/);
  assert.throws(
    () => loadNativeKeychainBinding(() => ({ get() {} })),
    /must export get, set, remove and accounts/,
  );
});

test("an addon that cannot be loaded fails with a clear error naming its path", () => {
  assert.throws(
    () =>
      loadNativeKeychainBinding(() => {
        throw new Error("dlopen failed: image not found");
      }),
    (err: Error) => {
      assert.match(err.message, /native Keychain addon could not be loaded from .*dist\/native\/keychain\.node: dlopen failed/);
      return true;
    },
  );
});
