import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session, SessionNoteSummary } from "../src/shared/types.ts";
import { ForemanNote } from "../src/web/components/ForemanNote.tsx";
import {
  approveForemanRecommendation,
  closeForemanNote,
} from "../src/web/lib/foreman.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

// Rendered rather than checked as a pure rule, because the bug WAS the render: the
// hint's condition (`mode !== "live"`) suppressed the explanation in the one state
// that most needed it. `foremanSendBlock` was never wrong - nothing asked it. A test
// below the component could not have caught this, so this one renders the component.

const REPO = "/Users/me/workspace/ai-harness";
const WORKTREE = "/Users/me/.treehouse/ai-harness-c7356c/14/ai-harness";

/**
 * ForemanNote reads id/cwd/repoRoot and the pane handles off the session; the cast keeps
 * that honest.
 *
 * The pane is not decoration. These tests are all about a `pending` draft - Foreman wrote a
 * reply and is asking for an OK - and a draft is only ever produced when there was a channel
 * to deliver it on: `planFromVerdict` escalates instead when `pickChannel` comes back empty.
 * So a pane-less draft is not the state under test here, and leaving the handles undefined
 * made the card explain the wrong absence, answering "there is nowhere to type this" over the
 * allowlist question these cases are actually asking.
 */
function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    cwd: WORKTREE,
    repoRoot: REPO,
    terminals: [mkMuxHandle({ session: "m", windowName: "w", windowIndex: 1, paneId: "%1" })],
    // Stated rather than left off the cast: an uninvited session is now its own reason,
    // and it outranks every allowlist and mode question below. Undefined would read as
    // invited by accident, which is the right answer for the wrong reason.
    foremanInvite: "dispatch",
    ...over,
  } as Session;
}

function mkNote(over: Partial<SessionNoteSummary> = {}): SessionNoteSummary {
  return {
    disposition: "pending",
    purpose: "Reaping leaked worktree leases.",
    brief: null,
    recommendation: "Yes, remove the stale lease files.",
    lastAction: "drafted a reply (awaiting you)",
    handledMarker: "await:1",
    updatedAt: 0,
    ...over,
  } as SessionNoteSummary;
}

function render(o: {
  session?: Session;
  mode: string;
  enabled: boolean;
  allowlist?: string[];
}): string {
  return renderToStaticMarkup(
    createElement(ForemanNote, {
      session: o.session ?? mkSession(),
      note: mkNote(),
      mode: o.mode,
      enabled: o.enabled,
      allowlist: o.allowlist,
      inputReviewId: null,
    }),
  );
}

/**
 * The reported bug, at the surface the human actually reads: live mode, and it's
 * STILL asking. Before the fix this rendered an Approve button and nothing else -
 * no reason given - because the hint was gated on `mode !== "live"`.
 */
test("ForemanNote: a live-mode draft says WHY it's still asking", () => {
  const html = render({ mode: "live", enabled: true, allowlist: ["/some/other/repo"] });
  assert.match(html, /fn-hint/, "renders a hint rather than the old silence");
  assert.match(html, /isn&#x27;t allowlisted for live\s+sends/, "names the real reason");
  assert.match(html, /live mode/, "acknowledges it IS in live mode, rather than contradicting it");
});

/** Says where to fix it - and names the REPO, not the throwaway worktree. */
test("ForemanNote: the allowlist suggestion names the repo, not the worktree", () => {
  const html = render({ mode: "live", enabled: true, allowlist: ["/some/other/repo"] });
  assert.match(html, new RegExp(REPO.replace(/\//g, "\\/")), "suggests the repo root");
  assert.doesNotMatch(html, /treehouse/, "never suggests the throwaway worktree path");
});

/**
 * The fix itself, end to end at the UI: a worktree of an allowlisted repo is cleared,
 * so there is no allowlist excuse to make. This is the user's exact reported state -
 * repo allowlisted, session running in a treehouse worktree of it.
 */
test("ForemanNote: a worktree of an allowlisted repo owes no allowlist excuse", () => {
  const html = render({ mode: "live", enabled: true, allowlist: [REPO] });
  assert.doesNotMatch(html, /isn&#x27;t allowlisted/, "the repo IS allowlisted - via its worktree");
});

test("ForemanNote: dry-run keeps its plain draft-only line", () => {
  const html = render({ mode: "dry-run", enabled: true, allowlist: [REPO] });
  assert.match(html, /Draft only/);
  assert.doesNotMatch(html, /allowlist/, "the mode is the reason, not the allowlist");
});

test("ForemanNote: Foreman being off outranks the mode", () => {
  const html = render({ mode: "live", enabled: false, allowlist: [REPO] });
  assert.match(html, /Foreman is off/);
});

/**
 * The state phase 2 created and this leaves explained: Foreman is on, live, and
 * allowlisted here, and it still will not touch this session - because it was never
 * invited into it. Every other sentence this card can say would send the operator to fix
 * a switch that is not what stopped it.
 */
test("ForemanNote: an uninvited session says so rather than blaming the mode or the allowlist", () => {
  const html = render({
    session: mkSession({ foremanInvite: null }),
    mode: "live",
    enabled: true,
    allowlist: [REPO],
  });
  assert.match(html, /Foreman is not in this session/);
  assert.match(html, /Invite it from the rail above/, "points at the control that fixes it");
  assert.doesNotMatch(html, /allowlist/, "the allowlist is not what stopped this");
});

test("ForemanNote: Foreman being off outranks the invite", () => {
  // Both are true, and only one of them is worth acting on first: inviting Foreman into a
  // session while Foreman is off buys nothing.
  const html = render({
    session: mkSession({ foremanInvite: null }),
    mode: "live",
    enabled: false,
    allowlist: [REPO],
  });
  assert.match(html, /Foreman is off/);
  assert.doesNotMatch(html, /not in this session/);
});

test("ForemanNote: a session with no cwd says so instead of blaming the allowlist", () => {
  const html = render({
    session: mkSession({ cwd: null, repoRoot: null }),
    mode: "live",
    enabled: true,
    allowlist: [REPO],
  });
  assert.match(html, /can&#x27;t tell which directory/);
});

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
