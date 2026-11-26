// Signs the daemon's own sign-in service (`shaperSignIns`) in against the Phase 1 loopback mock
// authorization server, for the transport and dry-run tests. Fake values only: the fixture's
// `/authorize` approves at once, and every token is its `fake-access-...`.
//
// A test file that uses this sets `MISSION_SHAPER_SIGN_IN_STORE=memory` before the service first
// switches on, so no Keychain item is read or written: the store is chosen when it is first needed.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { SHAPER_SIGN_IN_FLAG_ID } from "../../src/shared/feature-flag-registry.ts";
import type { SignInTarget } from "../../src/shared/shaping.ts";
import { applyFeatureFlagIntent } from "../../src/server/feature-flags/index.ts";
import { shaperSignIns } from "../../src/server/shaping/sign-in/index.ts";
import { startFakeOAuthServer, type FakeOAuthServer } from "../fixtures/fake-oauth-server.mjs";

/** Both flags sign-in needs, `task-shaping` and `shaper-sign-in`, and the service settled after the change. */
export async function setSignInFlags(enabled: boolean): Promise<void> {
  assert.equal(process.env.MISSION_SHAPER_SIGN_IN_STORE, "memory", "the memory store, so no Keychain item is touched");
  for (const id of ["task-shaping", SHAPER_SIGN_IN_FLAG_ID]) {
    assert.equal(applyFeatureFlagIntent({ kind: "flag", id, enabled }).ok, true, `${id} ${enabled ? "on" : "off"}`);
  }
  await shaperSignIns.idle();
}

/** A pending sign-in: begun, never completed. The authorization URL is not followed. */
export async function beginSignIn(target: SignInTarget): Promise<string> {
  const begun = await shaperSignIns.begin(target);
  assert.ok(begun.ok, `begin failed: ${JSON.stringify(begun)}`);
  return begun.connection;
}

/**
 * A fresh fixture with both flags on, undone however the test ends, in order: every connection
 * in `made` is signed out while the flags are still on, which frees the registration it names,
 * then the flags go off, then the fixture closes.
 */
export async function signInFixture(t: TestContext): Promise<{ fake: FakeOAuthServer; made: string[] }> {
  const fake = await startFakeOAuthServer();
  const made: string[] = [];
  t.after(async () => {
    for (const id of made) await shaperSignIns.signOut(id);
    await shaperSignIns.idle();
    await setSignInFlags(false);
    await fake.close();
  });
  await setSignInFlags(true);
  return { fake, made };
}

export interface HeldSignIn {
  /** The connection id. */
  id: string;
  /** The fake access token the service holds now. */
  token: string;
}

/** A whole sign-in: begin, the fixture's redirect read as a browser would, complete. */
export async function signIn(target: SignInTarget): Promise<HeldSignIn> {
  const begun = await shaperSignIns.begin(target);
  assert.ok(begun.ok, `begin failed: ${JSON.stringify(begun)}`);
  const response = await fetch(begun.authorizationUrl, { redirect: "manual" });
  assert.equal(response.status, 302, "the fixture approves at once");
  const back = new URL(response.headers.get("location")!).searchParams;
  const done = await shaperSignIns.complete({ state: back.get("state"), code: back.get("code"), error: back.get("error"), iss: back.get("iss") });
  assert.ok(done.ok, `complete failed: ${JSON.stringify(done)}`);
  await shaperSignIns.idle();
  const held = shaperSignIns.accessToken(target);
  assert.ok(held.ok, `not signed in: ${JSON.stringify(held)}`);
  assert.match(held.token, /^fake-access-\d+$/, "a fixture token");
  return { id: begun.connection, token: held.token };
}
