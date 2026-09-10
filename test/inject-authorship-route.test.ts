/**
 * What is at stake: the authorship record for the deliveries that caused the defect.
 *
 * `POST /api/sessions/:id/inject` is the route Foreman's recovery packets and the workflow's
 * repair packets travel. Every one of them is echoed straight back by the agent's prompt hook,
 * and the Goal path can only tell that echo from something the operator typed by asking who
 * wrote it - so if this route's bookkeeping is wrong, a completion-review packet becomes the
 * session's ask and is frozen onto the next workflow run under the heading "Original user
 * goal".
 *
 * The route used to claim authorship only after the delivery resolved. That is too late: a
 * driver can hand the turn over and the agent can submit it while the `await` is still
 * pending, so the echo reaches the daemon first and finds nothing on file. It now reserves
 * before delivering, then confirms on success or releases on positive evidence that nothing
 * landed. These pin all three branches through the real HTTP route, because the ordering is
 * the property and a unit test of the store cannot see the ordering the route chose.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-inject-authorship-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { claimInjectionEcho, forgetInjections, originOf } = await import(
  "../src/server/injections.ts"
);

type TaskManager = import("../src/server/tasks.ts").TaskManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;
type SdkSupervisor = import("../src/server/sdk/supervisor.ts").SdkSupervisor;
type SdkTurn = import("../src/server/harness/types.ts").SdkTurn;

openDb();
beforeEach(() => forgetInjections());

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

/** Foreman's completion-review packet, in the shape `ship-shepherd.ts` builds it. */
const PACKET = [
  "Foreman's completion review found blocking work that still belongs in this implementation turn:",
  "",
  "1. The spec failed under contention.",
].join("\n");

let seq = 0;

/**
 * An embedded session and an app wired to a supervisor whose one send is scripted.
 *
 * Embedded rather than pane-backed on purpose: `deliverToDriver` is the arm whose refusal is
 * positive evidence that nothing landed, which is the only state the release branch may act
 * on. A pane delivery's failures are ambiguous by construction and would make the assertion
 * about the wrong thing.
 */
function harness(send: (turn: SdkTurn) => Promise<unknown>) {
  const id = `sdk:inject-authorship-${++seq}`;
  const registry = new Registry();
  const session = registry.registerSdkSession({
    id,
    agent: "claude",
    name: "authorship",
    cwd: `/wt/${id}`,
  });
  const sent: SdkTurn[] = [];
  const supervisor = {
    send: (_id: string, turn: SdkTurn) => {
      sent.push(turn);
      return send(turn);
    },
  } as unknown as SdkSupervisor;
  const app = buildApp(
    registry,
    new ReviewManager(registry),
    {} as TaskManager,
    {} as QueueManager,
    undefined, undefined, undefined, undefined, undefined,
    supervisor,
  );
  // `app.request` is typed as sync-or-async; awaiting it here gives every caller one shape.
  const inject = async (text: string, origin: string): Promise<Response> =>
    await app.request(`/api/sessions/${session.id}/inject`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ text, origin }),
    });
  return { id, registry, session, app, inject, sent };
}

test("a delivered packet is on file before the route answers, and owes exactly one echo", async () => {
  const { id, inject, sent } = harness(async () => "started");

  const res = await inject(PACKET, "foreman");
  assert.equal(res.status, 200);
  assert.deepEqual(sent.map((turn) => turn.text), [PACKET]);

  // The label the conversation log reads.
  assert.equal(originOf(id, PACKET), "foreman");
  // And exactly one suppression, spent by the echo this delivery will produce. A second
  // would be spent silencing a later turn the operator typed - the reservation and the
  // confirmation must settle to one, not two.
  assert.equal(claimInjectionEcho(id, PACKET), "foreman");
  assert.equal(claimInjectionEcho(id, PACKET), undefined);
  // The label survives the claim being spent; only the suppression is single-use.
  assert.equal(originOf(id, PACKET), "foreman");
});

test("authorship is on file while the delivery is still in flight", async () => {
  // The ordering the reservation exists for, observed from inside the pending send. This is
  // the window in which the agent's prompt hook can report the packet back, and the only
  // vantage point where claiming before and claiming after look different.
  // A holder rather than a bare `let`: the resolver is assigned inside a callback the
  // checker cannot see running, so a plain binding narrows to `null` at every later read.
  const gate: { release: (() => void) | null; duringSend: string | undefined } = {
    release: null,
    duringSend: "unobserved",
  };
  const { id, inject } = harness(async () => {
    gate.duringSend = originOf(id, PACKET);
    await new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    return "started";
  });

  const pending = inject(PACKET, "foreman");
  while (gate.release === null) await new Promise((r) => setTimeout(r, 1));
  assert.equal(
    gate.duringSend,
    "foreman",
    "an echo arriving mid-delivery must already find the packet attributed",
  );
  gate.release();
  await pending;
});

test("a refused delivery leaves nothing on file to silence a later turn", async () => {
  // The failure branch. The driver refused, so no turn exists and no echo is coming. A
  // reservation left standing would sit there waiting to swallow whatever the operator types
  // next that matches - which, for a packet they can read on screen, is not far-fetched.
  const { id, inject } = harness(async () => {
    throw new Error("the driver refused the turn");
  });

  const res = await inject(PACKET, "foreman");
  assert.equal(res.status, 500);
  const body = (await res.json()) as { ok: boolean; pasted: boolean };
  assert.equal(body.ok, false);
  assert.equal(body.pasted, false, "a driver refusal is positive evidence nothing landed");

  assert.equal(originOf(id, PACKET), undefined, "the reservation was given back");
  assert.equal(claimInjectionEcho(id, PACKET), undefined);
});

test("a human's own turn is never claimed, whatever the route does with it", async () => {
  // The boundary the whole guard rests on. Text the operator typed must reach the Goal, so
  // the route must not attribute it - and it must not reserve one either, or a released
  // reservation would be the only thing standing between them and a lost instruction.
  const { id, inject, sent } = harness(async () => "started");

  const res = await inject("also post the Jira comment", "human");
  assert.equal(res.status, 200);
  assert.deepEqual(sent.map((turn) => turn.text), ["also post the Jira comment"]);
  assert.equal(originOf(id, "also post the Jira comment"), undefined);
  assert.equal(claimInjectionEcho(id, "also post the Jira comment"), undefined);
});

test("a workflow repair packet is recorded on the same terms as Foreman's", async () => {
  // Both non-human origins travel this route, and the repair packet is the one that quotes
  // the goal it was built from - so capturing its echo nests one round's "Original user goal:"
  // inside the next round's.
  const { id, inject } = harness(async () => "started");
  const repair = "Workflow review failed. This is a repair round;\n\nOriginal user goal:\nship it";

  assert.equal((await inject(repair, "workflow")).status, 200);
  assert.equal(originOf(id, repair), "workflow");
  assert.equal(claimInjectionEcho(id, repair), "workflow");
  assert.equal(claimInjectionEcho(id, repair), undefined);
});
