import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadNativeKeychainBinding,
  type NativeKeychainBinding,
} from "../src/server/shaping/sign-in/keychain-native.ts";
import { createSignInStore, stateHomeTag, type SignInStore, type StoredSignIn } from "../src/server/shaping/sign-in/store.ts";

/**
 * The real addon against the real login Keychain. macOS only: CI is Linux, so the phase's
 * session runs this on a Mac and registers its output.
 *
 * Fake values only. The service name carries a random suffix and is never the product's, so
 * this file can only ever see the one item it writes, and `after` removes that item and proves
 * it is gone whatever failed before it.
 */

const darwin = process.platform === "darwin";
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVICE = `Mission Control shaper sign-in test ${randomBytes(6).toString("hex")}`;
const ID = randomBytes(16).toString("hex");

let binding: NativeKeychainBinding;
let store: SignInStore;
let account: string;

/** A `size`-byte fake token: plain filler, never anything shaped like a real credential. */
function fakeToken(prefix: string, size: number): string {
  return `${prefix}-${"f".repeat(size - prefix.length - 1)}`;
}

function fakeRecord(accessToken: string): StoredSignIn {
  return {
    v: 1,
    target: { url: "https://tools.example.test/mcp", scope: "mcp:context", issuer: null },
    issuer: "https://tools.example.test",
    clientId: "fake-client-keychain-test",
    accessToken,
    refreshToken: "fake-refresh-keychain-test",
    expiresAt: 1_900_000_000_000,
    scope: "mcp:context",
    obtainedAt: 1_800_000_000_000,
  };
}

before(async () => {
  if (!darwin) return;
  try {
    binding = loadNativeKeychainBinding();
  } catch {
    // A single-file run does not go through `npm run build:native`.
    execFileSync(process.execPath, ["scripts/build-keychain-native.mjs"], { cwd: REPO_ROOT, stdio: "pipe" });
    binding = loadNativeKeychainBinding();
  }
  const stateHome = mkdtempSync(join(tmpdir(), "mission-keychain-home-"));
  store = createSignInStore({ platform: "darwin", env: {}, stateHome, service: SERVICE });
  account = `${await stateHomeTag(stateHome)}/${ID}`;
});

after(async () => {
  if (!darwin || !binding) return;
  await binding.remove(SERVICE, account);
  assert.equal(await binding.get(SERVICE, account), null, "the test item must be gone");
  assert.deepEqual(await binding.accounts(SERVICE), [], "no item may be left under the test service");
});

test("a 16 KiB fake record is written, read, replaced, listed and removed through the real addon", { skip: !darwin }, async () => {
  assert.equal(store.kind, "keychain");
  assert.equal(await store.read(ID), null);
  assert.deepEqual(await store.ids(), []);

  const first = fakeRecord(fakeToken("fake-access-first", 16 * 1024));
  assert.ok(JSON.stringify(first).length > 16 * 1024);

  // The Security call runs in Node-API async work: a callback queued before the write runs
  // while the write is still pending. On the event loop it could only run after.
  let settled = false;
  let immediateRanWhilePending: boolean | null = null;
  setImmediate(() => {
    immediateRanWhilePending = !settled;
  });
  const started = performance.now();
  const writing = store.write(ID, first).then(() => {
    settled = true;
  });
  await writing;
  const elapsed = performance.now() - started;
  assert.equal(immediateRanWhilePending, true, "a queued callback must run before the write settles");

  assert.deepEqual(await store.read(ID), first);
  assert.deepEqual(await store.ids(), [ID]);
  assert.deepEqual(await binding.accounts(SERVICE), [account], "one item, under this home's tag");

  const second = fakeRecord(fakeToken("fake-access-second", 64 * 1024));
  await store.write(ID, second);
  assert.deepEqual(await store.read(ID), second);
  assert.deepEqual(await binding.accounts(SERVICE), [account], "a replace updates the item, never adds one");

  await store.remove(ID);
  assert.equal(await store.read(ID), null);
  assert.deepEqual(await store.ids(), []);
  assert.equal(await binding.remove(SERVICE, account), false, "nothing is left to remove");

  console.log(`[keychain] first 16 KiB write settled in ${elapsed.toFixed(1)} ms off the event loop`);
});

test("the addon answers a missing item with null and false, keeps exactly 256 KiB, and refuses bad input without echoing it",{ skip: !darwin }, async () => {
  const missing = `${account}-missing`;
  assert.equal(await binding.get(SERVICE, missing), null);
  assert.equal(await binding.remove(SERVICE, missing), false);

  // The largest value the addon accepts, on this test's own account: written, read back, removed.
  const largest = fakeToken("fake-largest", 256 * 1024);
  assert.equal(Buffer.byteLength(largest), 256 * 1024);
  await binding.set(SERVICE, account, largest, SERVICE);
  assert.equal(await binding.get(SERVICE, account), largest, "a value of exactly 256 KiB is kept whole");
  assert.equal(await binding.remove(SERVICE, account), true);
  assert.equal(await binding.get(SERVICE, account), null, "the 256 KiB item is gone");

  const oversized = fakeToken("fake-oversized", 256 * 1024 + 1);
  await assert.rejects(binding.set(SERVICE, missing, oversized, SERVICE), (err: Error) => {
    assert.equal(err.message, "Keychain set value is too long");
    return true;
  });
  await assert.rejects(binding.set(SERVICE, missing, "", SERVICE), /Keychain set value must not be empty/);
  await assert.rejects(
    (binding.get as (...args: unknown[]) => Promise<unknown>)(SERVICE),
    /Keychain get requires 2 string arguments/,
  );
  await assert.rejects(
    (binding.set as (...args: unknown[]) => Promise<unknown>)(SERVICE, missing, 42, SERVICE),
    /Keychain set value must be a string/,
  );
  assert.equal(await binding.get(SERVICE, missing), null, "a refused write stores nothing");
});
