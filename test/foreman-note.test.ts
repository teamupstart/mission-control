import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approveForemanRecommendation,
  closeForemanNote,
} from "../src/web/lib/foreman.ts";

// --- closing a note: the order that keeps the record ---
//
// `setNote` nulls `recommendation` and `brief`, which is correct for a live pointer
// and destructive for evidence. Before the episode log existed that null was the end
// of the text: approving erased the very words just sent to the child. So the episode
// has to be stamped FIRST, and that ordering is invisible unless something asserts it.

/** Records the calls `closeForemanNote` makes, in order. */
function recorder(): {
  calls: string[];
  writer: Parameters<typeof closeForemanNote>[0];
  payloads: Record<string, unknown>[];
} {
  const calls: string[] = [];
  const payloads: Record<string, unknown>[] = [];
  return {
    calls,
    payloads,
    writer: {
      resolveEpisode: (_id, p) => {
        calls.push("resolveEpisode");
        payloads.push(p as unknown as Record<string, unknown>);
        return Promise.resolve(null);
      },
      setNote: (_id, n) => {
        calls.push("setNote");
        payloads.push(n as unknown as Record<string, unknown>);
        return Promise.resolve(null);
      },
    },
  };
}

test("closeForemanNote stamps the episode BEFORE the note nulls the evidence", async () => {
  const r = recorder();
  await closeForemanNote(r.writer, "s1", {
    marker: "await:1",
    disposition: "answered",
    lastAction: "approved by you",
    sentText: "Yes, remove the stale lease files.",
  });
  assert.deepEqual(r.calls, ["resolveEpisode", "setNote"], "record first, then clear");
  assert.equal(r.payloads[0]!.sentText, "Yes, remove the stale lease files.");
  assert.equal(r.payloads[1]!.recommendation, null, "the note still clears - it is current state");
  assert.equal(r.payloads[1]!.brief, null);
});

test("closeForemanNote records a dismissal as decided but unanswered", async () => {
  const r = recorder();
  await closeForemanNote(r.writer, "s1", {
    marker: "await:1",
    disposition: "skipped",
    lastAction: "dismissed by you",
    sentText: null,
  });
  assert.deepEqual(r.calls, ["resolveEpisode", "setNote"]);
  assert.equal(r.payloads[0]!.disposition, "skipped");
  assert.equal(r.payloads[0]!.sentText, null, "nothing was sent, so nothing is claimed");
});

test("a note with no marker still writes the note - the audit row never blocks you", async () => {
  // A note from before the episode log, or from a path that sets no marker. There is
  // nothing to stamp; failing the human's decision over a missing audit row would be
  // strictly worse than the gap it is complaining about.
  const r = recorder();
  await closeForemanNote(r.writer, "s1", {
    marker: null,
    disposition: "answered",
    lastAction: "approved by you",
    sentText: "ok",
  });
  assert.deepEqual(r.calls, ["setNote"]);
});

test("Foreman approval records sentText only after direct delivery is acknowledged", async () => {
  const calls: string[] = [];
  const payloads: unknown[] = [];
  let acknowledge!: (result: { ok: boolean }) => void;
  const delivered = new Promise<{ ok: boolean }>((resolve) => {
    acknowledge = resolve;
  });
  const approval = approveForemanRecommendation(
    {
      injectPrompt: (id, text, buffer) => {
        calls.push("injectPrompt");
        payloads.push({ id, text, buffer });
        return delivered;
      },
      resolveReview: async () => ({ ok: true }),
      resolveEpisode: async (_id, p) => {
        calls.push("resolveEpisode");
        payloads.push(p);
      },
      setNote: async (_id, note) => {
        calls.push("setNote");
        payloads.push(note);
      },
    },
    "s1",
    { kind: "send" },
    {
      marker: "await:1",
      recommendation: "First line.\nSecond line.",
    },
  );

  await Promise.resolve();
  assert.deepEqual(calls, ["injectPrompt"], "the audit waits for delivery acknowledgement");
  assert.deepEqual(payloads[0], {
    id: "s1",
    text: "First line.\nSecond line.",
    buffer: false,
  });

  acknowledge({ ok: true });
  assert.equal((await approval).ok, true);
  assert.deepEqual(calls, ["injectPrompt", "resolveEpisode", "setNote"]);
  assert.equal(
    (payloads[1] as { sentText: string }).sentText,
    "First line.\nSecond line.",
  );
});

test("a refused Foreman delivery does not resolve the episode or clear the note", async () => {
  const calls: string[] = [];
  const result = await approveForemanRecommendation(
    {
      injectPrompt: async () => {
        calls.push("injectPrompt");
        return { ok: false, error: "session became busy" };
      },
      resolveReview: async () => ({ ok: true }),
      resolveEpisode: async () => {
        calls.push("resolveEpisode");
      },
      setNote: async () => {
        calls.push("setNote");
      },
    },
    "s1",
    { kind: "send" },
    { marker: "await:1", recommendation: "Do not record this yet." },
  );

  assert.deepEqual(result, { ok: false, error: "session became busy" });
  assert.deepEqual(calls, ["injectPrompt"]);
});
