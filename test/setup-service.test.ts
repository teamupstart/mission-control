import assert from "node:assert/strict";
import test from "node:test";

import { SETUP_SERVICE_IDS, HERDR_SERVER_REMEDY } from "../src/shared/setup-catalog.ts";
import { SetupServiceStartSchema } from "../src/shared/protocol.ts";
import {
  DEFAULT_SETUP_SERVICE_STARTERS,
  startSetupService,
  type SetupServiceStarters,
} from "../src/server/setup/service.ts";

function starters(result: Awaited<ReturnType<SetupServiceStarters["herdr-server"]>>): SetupServiceStarters {
  return { "herdr-server": async () => result };
}

test("every service id has exactly one daemon-owned starter", () => {
  assert.deepEqual(Object.keys(DEFAULT_SETUP_SERVICE_STARTERS).sort(), [...SETUP_SERVICE_IDS].sort());
  assert.equal(HERDR_SERVER_REMEDY.kind === "service" ? HERDR_SERVER_REMEDY.service : null, "herdr-server");
});

test("a started service answers 200 and names itself", async () => {
  const response = await startSetupService(
    "herdr-server",
    starters({ ok: true, outcomeUnknown: false }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    ok: true,
    service: "herdr-server",
    outcome: "started",
    label: "Herdr server",
    detail: "The Herdr server is running.",
  });
});

test("a refusal carries the transport's own sentence rather than a generic one", async () => {
  const response = await startSetupService(
    "herdr-server",
    starters({ ok: false, outcomeUnknown: false, error: "Herdr server did not become ready." }),
  );
  assert.equal(response.status, 409);
  assert.equal(response.body.outcome, "refused");
  assert.equal(response.body.detail, "Herdr server did not become ready.");
});

// An unconfirmed start is not a refusal: reporting it as one invites a second start against
// a server that may already be up, and the row is re-read either way.
test("an unconfirmed start keeps its own outcome and a 504", async () => {
  const response = await startSetupService(
    "herdr-server",
    starters({ ok: false, outcomeUnknown: true, error: "Herdr socket operation timed out." }),
  );
  assert.equal(response.status, 504);
  assert.equal(response.body.outcome, "unknown");
  assert.equal(response.body.ok, false);
});

test("the wire schema admits only a known service id and no second field", () => {
  assert.equal(SetupServiceStartSchema.safeParse({ service: "herdr-server" }).success, true);
  for (const body of [
    {},
    { service: "" },
    { service: "postgres" },
    { service: "herdr-server", argv: ["herdr", "server"] },
    { service: "herdr-server", backend: "cmux" },
  ]) {
    assert.equal(SetupServiceStartSchema.safeParse(body).success, false, JSON.stringify(body));
  }
});
