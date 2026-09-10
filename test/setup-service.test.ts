import assert from "node:assert/strict";
import test from "node:test";

import { SETUP_SERVICE_IDS, HERDR_SERVER_REMEDY } from "../src/shared/setup-catalog.ts";
import { SetupServiceStartSchema } from "../src/shared/protocol.ts";
import {
  DEFAULT_SETUP_SERVICE_STARTERS,
  startSetupService,
  type SetupServiceStarters,
} from "../src/server/setup/service.ts";

const unused = async () => {
  throw new Error("this case starts one named service and must not reach another");
};

function starters(result: Awaited<ReturnType<SetupServiceStarters["herdr-server"]>>): SetupServiceStarters {
  return { "herdr-server": async () => result, "cmux-app": unused, "cmux-socket-control": unused };
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

test("a repair that starts no process never reports one running", async () => {
  // `The ${label} is running.` is true of a server and false of a file edit, and it reached
  // an operator as "The cmux socket control is running." about a config value.
  const response = await startSetupService("cmux-socket-control", {
    "herdr-server": unused,
    "cmux-app": unused,
    "cmux-socket-control": async () => ({ ok: true, outcomeUnknown: false }),
  });
  assert.equal(response.status, 200);
  assert.equal(
    response.body.detail,
    "cmux socket control is set to allowAll. cmux applies it without a restart.",
  );
  assert.doesNotMatch(response.body.detail, /is running/);
});

test("a failure with nothing to say falls back to the service's own refusal", async () => {
  // Not every starter has a sentence to offer - `cmuxAppStart` can only report that the
  // socket never answered - so the catalog carries one per service rather than one built
  // around the label.
  const response = await startSetupService("cmux-app", {
    "herdr-server": unused,
    "cmux-app": async () => ({ ok: false, outcomeUnknown: false }),
    "cmux-socket-control": unused,
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.detail, "cmux could not be opened.");
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
