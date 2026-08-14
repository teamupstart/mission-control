import assert from "node:assert/strict";
import test from "node:test";
import type { TranscriptMessage } from "../src/shared/types.ts";
import { yourMessages } from "../src/web/lib/conversation-yours.ts";
import { turnAuthor, turnWho } from "../src/web/lib/find.ts";

// The "Yours" rail's projection. One rule carries this whole surface - what counts as
// something the operator said - and getting it wrong does not look like a bug: it looks
// like a tidy list, under a tab called "Yours", of things they never typed. So the rules
// are pinned here against real message shapes rather than through a DOM.

function msg(over: Partial<TranscriptMessage> & { id: string }): TranscriptMessage {
  return { role: "user", text: "", tools: [], ts: 0, ...over };
}

test("indexes the operator's own messages, in transcript order", () => {
  const { yours, injected } = yourMessages([
    msg({ id: "m1", text: "Investigate the ensemble failure.", ts: 100 }),
    msg({ id: "m2", role: "assistant", text: "Starting with the run record.", ts: 200 }),
    msg({ id: "m3", text: "Don't run the build in that checkout.", ts: 300 }),
  ]);
  assert.deepEqual(
    yours.map((r) => ({ id: r.id, text: r.text, who: r.who })),
    [
      { id: "m1", text: "Investigate the ensemble failure.", who: null },
      { id: "m3", text: "Don't run the build in that checkout.", who: null },
    ],
  );
  assert.deepEqual(injected, []);
});

test("groups by ORIGIN, not by role - the whole point of the tab", () => {
  // Every one of these carries role "user". Only `origin` separates what the human typed
  // from what was typed on their behalf, and a rail keyed on the role would list all
  // four back to them as their own words.
  const { yours, injected } = yourMessages([
    msg({ id: "mine", text: "Re-file 3e63054f and go ahead.", ts: 100 }),
    msg({ id: "f", text: "Continue. You have approval to run the build.", origin: "foreman", ts: 200 }),
    msg({ id: "h", text: "/reload-skills", origin: "harness", ts: 300 }),
    msg({ id: "w", text: "Fix the failing stage.", origin: "workflow", ts: 400 }),
  ]);

  assert.deepEqual(yours.map((r) => r.id), ["mine"], "only the unattributed turn is the operator's");
  assert.deepEqual(
    injected.map((r) => ({ id: r.id, who: r.who })),
    [
      { id: "f", who: "foreman" },
      { id: "h", who: "mission control" },
      { id: "w", who: "workflow" },
    ],
    "and each of the others says who did type it",
  );
});

test("every injected row carries a byline, so dimming is never the only signal", () => {
  // The rail dims these AND labels them. If a row could be injected without a `who`, the
  // colour would be the sole difference between "you said this" and "this was said for
  // you" - which is exactly the confusion the tab exists to end.
  const { injected } = yourMessages([
    msg({ id: "f", text: "Ship it.", origin: "foreman", ts: 1 }),
    msg({ id: "w", text: "Retry the stage.", origin: "workflow", ts: 2 }),
  ]);
  assert.equal(injected.length, 2);
  for (const row of injected) assert.ok(row.who, `${row.id} must name its author`);
});

test("the rail's byline agrees with the transcript's, turn for turn", () => {
  // The rail sits BESIDE the log. If these two ever disagreed about a turn, one of them
  // would be lying on screen next to the other - so they read the same rule, and this is
  // the test that says so.
  const messages = [
    msg({ id: "mine", text: "do the thing", ts: 1 }),
    msg({ id: "f", text: "delivered work", origin: "foreman", ts: 2 }),
    msg({ id: "h", text: "injected", origin: "harness", ts: 3 }),
  ];
  const { yours, injected } = yourMessages(messages);
  for (const row of yours) {
    const m = messages.find((x) => x.id === row.id)!;
    assert.equal(turnWho(m, "claude"), "you");
  }
  for (const row of injected) {
    const m = messages.find((x) => x.id === row.id)!;
    assert.equal(turnWho(m, "claude"), row.who);
  }
});

test("skips the agent, and turns that carry no message to index", () => {
  const { yours, injected } = yourMessages([
    msg({ id: "a", role: "assistant", text: "Reading the store next.", ts: 1 }),
    // A tool-only turn belongs to the Activity tab beside this one - there is no message
    // here to jump to or to read back.
    msg({ id: "t", role: "assistant", text: "", tools: [{ name: "Bash", input: "{}" }], ts: 2 }),
    msg({ id: "empty", text: "", ts: 3 }),
    msg({ id: "mine", text: "ok", ts: 4 }),
  ]);
  assert.deepEqual(yours.map((r) => r.id), ["mine"]);
  assert.deepEqual(injected, []);
});

test("an unattributed turn reads as the operator's, exactly as the byline does", () => {
  // Attribution is in-memory and recorded at delivery, so a turn the daemon has
  // forgotten - anything delivered before a restart - has no origin left. It reads as
  // the operator's here BECAUSE it reads that way in the log beside it: the rail is
  // never more wrong than the transcript it indexes, and never differently wrong.
  const forgotten = msg({ id: "f", text: "Continue. You have approval.", ts: 1 });
  assert.equal(turnAuthor(forgotten), "operator");
  assert.equal(turnWho(forgotten, "claude"), "you");
  assert.deepEqual(yourMessages([forgotten]).yours.map((r) => r.id), ["f"]);
});

test("carries the message's own id, so a row can address its turn in the log", () => {
  // The id is the transcript record's uuid and the jump target: the rail queries
  // `[data-turn-id]` with it. A projection that minted its own key would produce rows
  // that select nothing.
  const { yours } = yourMessages([msg({ id: "5f0c-uuid", text: "jump here", ts: 9 })]);
  assert.deepEqual(yours, [{ id: "5f0c-uuid", ts: 9, text: "jump here", who: null }]);
});
