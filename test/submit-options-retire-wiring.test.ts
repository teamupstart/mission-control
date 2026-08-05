import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeTui } from "../src/server/harness/claude/tui.ts";
import { parsePaneDialog } from "../src/server/discovery/pane-dialog.ts";
import { bindSession } from "../src/server/terminal/registry.ts";
import { stubRun, type RunResult } from "../src/server/util/exec.ts";
import type { TerminalExec } from "../src/server/terminal/exec.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";
import { MULTI_SELECT, REVIEW_UNANSWERED } from "./fixtures/claude-panes.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { PaneDeps } from "../src/server/actions.ts";

// Does `/submit-options` retire the operator's Foreman note on a pane form that sent the
// child NOTHING?
//
// `test/foreman-note-retire.test.ts` pins `formDelivered` in isolation, and that is not the
// same claim. The bug was in the WIRING: the route gated the retire on `r.ok`, and a pane
// form reports `ok` on two states that delivered nothing - so on the first screen of a
// multi-question `AskUserQuestion` the note was retired while the agent was still blocked on
// the very ask it named. A predicate tested alone cannot catch a call site that stops asking
// it, and every other test of this route seeds an SDK session and posts the driver `answers`
// shape, which takes the `answerDriverRequest` branch and never reaches `submitPaneForm`.
//
// So this drives the pane branch for real: the actual route, the actual submit walk, and a
// fake tmux underneath it. `buildApp`'s `paneDeps` seam exists for this - the outcomes below
// need a screen that advances mid-walk, which no real tmux on a test machine will produce on
// demand.
//
// Both screens are VERBATIM captures from `fixtures/claude-panes.ts` rather than hand-written
// approximations, for the reason that file gives: a fixture invented by the same author as
// the parser agrees with the parser and not with the TUI.

const home = mkdtempSync(join(tmpdir(), "mission-submit-retire-"));
process.env.HARNESS_HOME = home;
const { buildApp } = await import("../src/server/routes.ts");
const { Registry } = await import("../src/server/registry.ts");
const { dialogMarker } = await import("../src/server/foreman/pending.ts");

after(() => rmSync(home, { recursive: true, force: true }));

type Registry_ = InstanceType<typeof Registry>;
type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type TaskManager = import("../src/server/tasks.ts").TaskManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };
const ok = (stdout: string): RunResult => stubRun({ stdout, stderr: "", code: 0 });

/** The dialog the operator was shown: question one of a two-question form. */
const QUESTION_ONE = parsePaneDialog(MULTI_SELECT, claudeTui.dialog!)!;

/**
 * A SECOND question, made from the same verbatim capture with a different prompt.
 *
 * Different prompt means a different `dialogIdentity`, which is what `awaitDialogChange`
 * waits for, and the capture carries no submit row (asserted below) - which is exactly what
 * makes `submitFormLocked` report `next-question` rather than walking on to send.
 */
const QUESTION_TWO_SCREEN = MULTI_SELECT.replace(
  "Which features would you like to enable?",
  "Which environments should it apply to?",
);

const SUGGESTION = "Tick Alpha and Beta only.";

/**
 * A fake tmux that answers the mode probe and serves `screens` in order.
 *
 * The screen advances when a `Right` key is sent, because that is the keystroke the walk uses
 * to step from a question to whatever follows it. Driving the swap off the real keystroke
 * rather than off a call counter keeps the fixture honest: a walk that never pressed `→`
 * would keep reading question one and could not reach the outcome under test.
 */
function fakePane(afterRight: string): { deps: PaneDeps; keys: string[] } {
  const keys: string[] = [];
  let stepped = false;
  const exec: TerminalExec = async (bin, args) => {
    const line = [bin, ...args].join(" ");
    // `0` is "not in copy-mode"; a pane that swallows keys would refuse every write.
    if (args.includes("display-message")) return ok("0 ");
    keys.push(line);
    if (line.includes("Right")) stepped = true;
    return ok("");
  };
  return {
    keys,
    deps: {
      pane: (s) => bindSession(s, exec),
      capture: async () => (stepped ? afterRight : MULTI_SELECT),
    },
  };
}

function mkDiscovered(id: string): DiscoveredSession {
  return {
    syntheticId: id,
    agent: "claude",
    name: "Enable the features",
    nameSource: "process",
    cwd: `/wt/${id}`,
    gitBranch: null,
    gitRoot: null,
    repoRoot: null,
    pid: 1,
    tty: "ttys015",
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: "%1" })],
    startedAt: 0,
    // The ask on screen, carried the way discovery carries it - this is what
    // `retireForemanNoteForDialog` reads to rebuild the marker.
    paneDialog: QUESTION_ONE,
  } as DiscoveredSession;
}

/** A terminal session showing question one, with Foreman's escalation pinned on it. */
function seed(id: string, deps: PaneDeps): { registry: Registry_; app: ReturnType<typeof buildApp> } {
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered(id)]);
  registry.upsertNote(
    id,
    {
      purpose: "Which features this repo should turn on.",
      recommendation: SUGGESTION,
      disposition: "escalated",
      lastAction: "escalated for your decision",
      handledMarker: dialogMarker(QUESTION_ONE),
    },
    1000,
  );
  const app = buildApp(
    registry,
    {} as unknown as ReviewManager,
    {} as unknown as TaskManager,
    {} as unknown as QueueManager,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    deps,
  );
  return { registry, app };
}

/** Submit question one leaving every box as it already is, so nothing is typed at it. */
const BOXES_AS_FOUND = [
  { number: 1, label: "Alpha", checked: true },
  { number: 2, label: "Beta", checked: true },
];

async function submit(app: ReturnType<typeof buildApp>, id: string): Promise<Response> {
  return app.request(`/api/sessions/${encodeURIComponent(id)}/submit-options`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ options: BOXES_AS_FOUND }),
  });
}

test("the fixtures still describe the states these cases depend on", () => {
  // Guards the two facts the cases below are built on, so a recaptured fixture that changed
  // either fails HERE with the reason rather than making the outcome assertions mysterious.
  assert.equal(QUESTION_ONE.multiSelect, true, "question one is a checkbox form");
  assert.equal(QUESTION_ONE.highlighted, 1, "the cursor starts on row 1, so no walk is needed");
  const two = parsePaneDialog(QUESTION_TWO_SCREEN, claudeTui.dialog!)!;
  assert.notEqual(
    JSON.stringify(two.options.map((o) => o.label)) + two.prompt,
    JSON.stringify(QUESTION_ONE.options.map((o) => o.label)) + QUESTION_ONE.prompt,
    "the second screen is a different question, so the walk can detect the step",
  );
});

test("a form that advanced to the next question does NOT retire the note", async () => {
  const { deps } = fakePane(QUESTION_TWO_SCREEN);
  const { registry, app } = seed("pane-next", deps);

  const res = await submit(app, "pane-next");
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()) as { ok: boolean; outcome?: string };
  assert.equal(body.ok, true, "the walk succeeded, which is exactly the trap");
  assert.equal(body.outcome, "next-question");

  // The whole point. A form's answers reach the agent only when its Submit tab is confirmed,
  // so at this moment the child has received nothing and the decision is still owed.
  const note = registry.getNote("pane-next")!;
  assert.equal(note.disposition, "escalated", "still yours to decide");
  assert.equal(note.recommendation, SUGGESTION, "and Foreman's answer is still on offer");
});

test("a form the review tab called half-filled does NOT retire the note either", async () => {
  // The other `ok`-but-undelivered outcome: Claude's review tab reports a gap and the walk
  // steps back to the same question. Same ask, nothing sent.
  const { deps } = fakePane(REVIEW_UNANSWERED);
  const { registry, app } = seed("pane-unanswered", deps);

  const res = await submit(app, "pane-unanswered");
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()) as { ok: boolean; outcome?: string };
  assert.equal(body.ok, true);
  assert.equal(body.outcome, "unanswered");

  const note = registry.getNote("pane-unanswered")!;
  assert.equal(note.disposition, "escalated");
  assert.equal(note.recommendation, SUGGESTION);
});
