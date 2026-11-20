import assert from "node:assert/strict";
import { after, test } from "node:test";
import { registerHooks } from "node:module";
import { Hono } from "hono";
import type { FeatureFlagId, FeatureFlagIntent } from "../src/shared/feature-flags.ts";

// The preload supplies this worker's disposable database. Replace the registry before
// importing any production flag reader; resolution, storage and middleware stay real.
const registryUrl = new URL("../src/shared/feature-flag-registry.ts", import.meta.url).href;
const fixtureUrl = new URL("./fixtures/feature-flag-registry.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    return resolved.url === registryUrl ? { ...resolved, url: fixtureUrl } : resolved;
  },
});
const flags = await import("../src/server/feature-flags/index.ts");
const { closeDb } = await import("../src/server/db.ts");
after(() => { closeDb(); hooks.deregister(); });

test("declared preview flag changes both the daemon answer and route access after choices", async () => {
  // Runtime imports above see the fixture registry instead of the shipped ids.
  const id = "fixture-preview" as FeatureFlagId;
  let handlerCalls = 0;
  const app = new Hono();
  app.get("/preview", flags.requireFeature(id), (c) => {
    handlerCalls++;
    return c.text("preview is available");
  });
  const expectAccess = async (enabled: boolean) => {
    assert.equal(flags.featureEnabled(id), enabled);
    const before = handlerCalls;
    const response = await app.request("/preview");
    assert.equal(response.status, enabled ? 200 : 404);
    assert.equal(handlerCalls, before + Number(enabled), "disabled routes must not call the handler");
    if (enabled) assert.equal(await response.text(), "preview is available");
    else assert.deepEqual(await response.json(), { error: "This feature is disabled.", feature: id });
  };
  const choose = (intent: FeatureFlagIntent) => {
    // No definitions parameter: the daemon must read its declared registry itself.
    assert.equal(flags.applyFeatureFlagIntent(intent).ok, true);
  };

  await expectAccess(false);
  choose({ kind: "flag", id, enabled: true });
  await expectAccess(true);
  choose({ kind: "flag", id, enabled: false });
  await expectAccess(false);
  choose({ kind: "master", enabled: true });
  await expectAccess(false); // An explicit off survives the master choice.
  choose({ kind: "master", enabled: true, enableDisabled: true });
  await expectAccess(true);
  choose({ kind: "master", enabled: false });
  await expectAccess(false);
});
