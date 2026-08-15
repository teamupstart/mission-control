import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkSession, mkTask } from "./helpers/session-fixture.ts";
import type { Session, Task } from "../src/shared/types.ts";

// What is at stake: whether a published scout archive tells the truth about who asked for
// what.
//
// Three separate things had to become durable for that to hold, and each one fails
// silently on its own. The transcript BOUNDARY, or a capture reads a head-and-tail window
// and quietly drops the follow-ups an operator sent in the middle of a long scout. The
// ATTRIBUTION, or a daemon restarted between a Foreman instruction and the capture
// publishes that instruction as the operator's own words. And the ACCEPTANCE point, or a
// prompt somebody typed and recalled is archived as something the agent was told.
//
// The database below is deliberately an UPGRADED one, not a fresh one: it is seeded as an
// existing install actually looks and then handed to openDb(), so every assertion here
// also proves the migration path a real operator takes.

const home = mkdtempSync(join(tmpdir(), "mission-scout-prompt-context-"));
process.env.MISSION_HOME = home;

/**
 * A database from before this feature: a task, and a capture job against it, and no
 * scout_prompt_* tables at all.
 *
 * Written out rather than trimmed to the interesting columns, because the point of the
 * fixture is that it is a database `openDb()` has to accept as it finds it.
 */
function seedPreFeatureDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS archive_capture_jobs (
      operation_key   TEXT NOT NULL PRIMARY KEY,
      task_id         TEXT NOT NULL,
      session_id      TEXT,
      episode_id      TEXT,
      kind            TEXT NOT NULL DEFAULT 'scout',
      status          TEXT NOT NULL,
      producer_id     TEXT,
      archive_id      TEXT,
      report_path     TEXT,
      summary         TEXT,
      tags_json       TEXT,
      supporting_json TEXT,
      title           TEXT,
      question        TEXT,
      origin_json     TEXT,
      repos_json      TEXT,
      relative_path   TEXT,
      capture_status  TEXT,
      error           TEXT,
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
  `);
  raw
    .prepare(
      `INSERT INTO archive_capture_jobs
         (operation_key, task_id, episode_id, kind, status, title, attempts, created_at, updated_at)
       VALUES ('t-old:e-old', 't-old', 'e-old', 'scout', 'reserved', 'An old job', 0, 1, 1)`,
    )
    .run();
  raw.close();
}

seedPreFeatureDb();

const { openDb } = await import("../src/server/db.ts");
const {
  SCOUT_PROMPT_LIMITS,
  appendScoutPromptTurn,
  clearScoutPromptContext,
  clearScoutPromptContexts,
  openScoutPromptContext,
  refreshScoutPromptContextName,
  scoutPromptContext,
  scoutPromptContextsForTask,
  scoutPromptFingerprint,
  scoutPromptTurns,
} = await import("../src/server/scouts/prompt-context.ts");
const {
  discardScoutPromptBoundary,
  freezeScoutPromptBoundary,
  journalScoutPrompt,
  refreshScoutPromptTitle,
} = await import("../src/server/scouts/prompt-journal.ts");
const { forgetInjections, observeInjections, originOf, recordInjection } = await import(
  "../src/server/injections.ts"
);

after(() => {
  observeInjections(null);
  rmSync(home, { recursive: true, force: true });
});

const db = openDb();
const reset = () => clearScoutPromptContexts(db);

function columns(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>)
    .map((c) => c.name)
    .sort();
}

/** A source that answers exactly what the seam asks, and nothing the Registry would add. */
function source(over: {
  session?: Session | null;
  task?: Task | null;
  episodeId?: string | null;
}): {
  getSession: (id: string) => Session | undefined;
  taskForSession: (sessionId: string, cwd: string | null) => Task | undefined;
  workEpisodeForSession: (sessionId: string) => { episodeId: string } | null;
} {
  const session = over.session === undefined ? mkSession() : over.session;
  const task = over.task === undefined ? mkTask({ kind: "scout" }) : over.task;
  const episodeId = over.episodeId === undefined ? "episode-1" : over.episodeId;
  return {
    getSession: () => session ?? undefined,
    taskForSession: () => task ?? undefined,
    workEpisodeForSession: () => (episodeId ? { episodeId } : null),
  };
}

const SCOUT = mkTask({ id: "task-scout", kind: "scout", title: "A very long scout request" });
const SHIP = mkTask({ id: "task-ship", kind: "ship" });

function context(over: Partial<Parameters<typeof openScoutPromptContext>[0]> = {}) {
  return openScoutPromptContext({
    taskId: SCOUT.id,
    episodeId: "episode-1",
    sessionId: "s1",
    sessionName: "Reconnect permissions",
    transcriptPath: "/tmp/t.jsonl",
    transcriptOffset: 4_096,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// Schema and migration
// ---------------------------------------------------------------------------

test("a pre-feature database still opens, and gains the prompt-context schema", () => {
  assert.deepEqual(columns("scout_prompt_contexts"), [
    "created_at",
    "episode_id",
    "session_id",
    "session_name",
    "task_id",
    "transcript_offset",
    "transcript_path",
    "truncated",
    "updated_at",
  ]);
  assert.deepEqual(columns("scout_prompt_turns"), [
    "delivered_at",
    "episode_id",
    "fingerprint",
    "id",
    "origin",
    "seq",
    "task_id",
    "text",
  ]);
});

test("a capture job written before the migration still reads", () => {
  // The tables are additive, so nothing about an existing job may change - including a job
  // that will never gain a prompt trail because its scout finished before this shipped.
  const row = db
    .prepare(`SELECT title, status FROM archive_capture_jobs WHERE operation_key = 't-old:e-old'`)
    .get() as unknown as { title: string; status: string };
  assert.equal(row.title, "An old job");
  assert.equal(row.status, "reserved");
});

test("an episode with no context reads as absent rather than as an empty one", () => {
  reset();
  assert.equal(scoutPromptContext("task-scout", "nope"), null);
  assert.deepEqual(scoutPromptTurns("task-scout", "nope"), []);
});

test("a second open of the migrated database migrates again without damage", () => {
  // `migrate` runs on EVERY open, so the second one has to find nothing to do. A child
  // process is what proves it: `openDb` caches its handle, so a second call in this process
  // would return the first connection and re-run nothing.
  const stdout = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `const { openDb } = await import("./src/server/db.ts");
       const d = openDb();
       const names = d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'scout_prompt%' ORDER BY name").all();
       const jobs = d.prepare("SELECT COUNT(*) AS n FROM archive_capture_jobs").get();
       console.log(JSON.stringify({ tables: names.map((r) => r.name), jobs: jobs.n }));`,
    ],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, MISSION_HOME: home, HARNESS_HOME: home, FLEET_HOME: undefined },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.deepEqual(JSON.parse(stdout.trim()), {
    tables: ["scout_prompt_contexts", "scout_prompt_turns"],
    jobs: 1,
  });
});

// ---------------------------------------------------------------------------
// The frozen boundary
// ---------------------------------------------------------------------------

test("a context freezes the visible name and the transcript anchor", () => {
  reset();
  const frozen = context();
  assert.equal(frozen?.sessionName, "Reconnect permissions");
  assert.equal(frozen?.transcriptOffset, 4_096);
  assert.equal(frozen?.truncated, false);
  assert.deepEqual(scoutPromptContext(SCOUT.id, "episode-1"), frozen);
});

test("a re-delivery on the same episode refreshes locators without becoming a second context", () => {
  reset();
  const first = context({ transcriptOffset: 10 });
  const second = context({ transcriptOffset: 900, sessionName: "Renamed by the model" });
  assert.equal(scoutPromptContextsForTask(SCOUT.id).length, 1, "one episode is one context");
  assert.equal(second?.transcriptOffset, 900, "the delivery that happened is the boundary");
  assert.equal(second?.sessionName, "Renamed by the model");
  assert.equal(second?.createdAt, first?.createdAt, "but it is the same row, not a new one");
});

test("a context with no name is refused rather than stored untitled", () => {
  reset();
  // An untitled context could only hand capture an empty title, which falls through to the
  // long task title this whole feature exists to stop showing.
  assert.equal(context({ sessionName: "   " }), null);
  assert.equal(scoutPromptContext(SCOUT.id, "episode-1"), null);
});

test("a rename re-freezes the stored title for every episode the session owns", () => {
  reset();
  context();
  openScoutPromptContext({
    taskId: "task-other",
    episodeId: "episode-2",
    sessionId: "s1",
    sessionName: "Reconnect permissions",
    transcriptPath: null,
    transcriptOffset: 0,
  });
  assert.equal(refreshScoutPromptContextName("s1", "Permissions after reconnect"), 2);
  assert.equal(scoutPromptContext(SCOUT.id, "episode-1")?.sessionName, "Permissions after reconnect");
  assert.equal(scoutPromptContext("task-other", "episode-2")?.sessionName, "Permissions after reconnect");
  // A blank rename is not a rename. The card never shows one, and accepting it here would
  // leave capture with nothing to title the archive with.
  assert.equal(refreshScoutPromptContextName("s1", "  "), 0);
  assert.equal(scoutPromptContext(SCOUT.id, "episode-1")?.sessionName, "Permissions after reconnect");
});

test("cleanup takes the context and its whole trail", () => {
  reset();
  context();
  appendScoutPromptTurn({
    id: "turn-1",
    taskId: SCOUT.id,
    episodeId: "episode-1",
    origin: "human",
    text: "and check pi too",
  });
  clearScoutPromptContext(SCOUT.id, "episode-1");
  assert.equal(scoutPromptContext(SCOUT.id, "episode-1"), null);
  assert.deepEqual(scoutPromptTurns(SCOUT.id, "episode-1"), []);
});

// ---------------------------------------------------------------------------
// The turn journal
// ---------------------------------------------------------------------------

test("a turn with no frozen context writes nothing", () => {
  reset();
  // Which is what keeps these tables scout-scoped without any caller having to ask: a
  // delivery into a session that is not running a recorded scout episode is a no-op.
  assert.equal(
    appendScoutPromptTurn({
      id: "turn-1",
      taskId: SCOUT.id,
      episodeId: "episode-1",
      origin: "human",
      text: "hello",
    }),
    null,
  );
  assert.deepEqual(scoutPromptTurns(SCOUT.id, "episode-1"), []);
});

test("a human turn keeps its text, trimmed; an automated one keeps only its fingerprint", () => {
  reset();
  context();
  appendScoutPromptTurn({
    id: "h1",
    taskId: SCOUT.id,
    episodeId: "episode-1",
    origin: "human",
    // Deliberately padded: what comes back is trimmed and byte-bounded, not the exact input.
    // The documentation says so in the same words, because promising byte-for-byte
    // preservation and then quietly normalizing is how a reader stops trusting the rest.
    text: "\n  Also check whether Pi behaves the same way  \n",
  });
  appendScoutPromptTurn({
    id: "f1",
    taskId: SCOUT.id,
    episodeId: "episode-1",
    origin: "foreman",
    text: "Foreman: the CI run is red, please look",
  });
  const [human, foreman] = scoutPromptTurns(SCOUT.id, "episode-1");
  assert.equal(human?.text, "Also check whether Pi behaves the same way");
  assert.equal(human?.origin, "human");
  // The payload of an automated turn is needed to EXCLUDE a transcript turn, never to
  // archive one - so it is not written to disk at all rather than written and filtered later.
  assert.equal(foreman?.text, null);
  assert.equal(foreman?.origin, "foreman");
  assert.equal(
    foreman?.fingerprint,
    scoutPromptFingerprint("Foreman: the CI run is red, please look"),
    "but enough of it survives to recognise the turn in the transcript",
  );
});

test("turns come back in delivery order, whatever their timestamps say", () => {
  reset();
  context();
  // Two turns inside one millisecond: a timestamp cannot order them and `seq` must.
  for (const id of ["a", "b", "c"]) {
    appendScoutPromptTurn(
      { id, taskId: SCOUT.id, episodeId: "episode-1", origin: "human", text: `turn ${id}` },
      1_000,
    );
  }
  assert.deepEqual(
    scoutPromptTurns(SCOUT.id, "episode-1").map((t) => t.text),
    ["turn a", "turn b", "turn c"],
  );
  assert.deepEqual(
    scoutPromptTurns(SCOUT.id, "episode-1").map((t) => t.seq),
    [0, 1, 2],
  );
});

test("the same delivery id is one prompt however many times it lands", () => {
  reset();
  context();
  // The shape this exists for: a pending turn that went out, could not be confirmed, was
  // marked uncertain, and was retried by an operator. Same `PendingTurn.id`, one prompt.
  const first = appendScoutPromptTurn({
    id: "pending-1",
    taskId: SCOUT.id,
    episodeId: "episode-1",
    origin: "human",
    text: "run it again",
  });
  const second = appendScoutPromptTurn({
    id: "pending-1",
    taskId: SCOUT.id,
    episodeId: "episode-1",
    origin: "human",
    text: "run it again",
  });
  assert.deepEqual(second, first);
  assert.equal(scoutPromptTurns(SCOUT.id, "episode-1").length, 1);
});

test("an empty or whitespace turn is not a prompt", () => {
  reset();
  context();
  assert.equal(
    appendScoutPromptTurn({
      id: "blank",
      taskId: SCOUT.id,
      episodeId: "episode-1",
      origin: "human",
      text: "   \n ",
    }),
    null,
  );
  assert.deepEqual(scoutPromptTurns(SCOUT.id, "episode-1"), []);
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

test("an oversized human turn is clipped and the context says so", () => {
  reset();
  context();
  const huge = "x".repeat(SCOUT_PROMPT_LIMITS.entryBytes + 5_000);
  const stored = appendScoutPromptTurn({
    id: "big",
    taskId: SCOUT.id,
    episodeId: "episode-1",
    origin: "human",
    text: huge,
  });
  assert.equal(stored?.text?.length, SCOUT_PROMPT_LIMITS.entryBytes);
  assert.equal(
    scoutPromptContext(SCOUT.id, "episode-1")?.truncated,
    true,
    "a trail with a clipped entry is not a complete trail, and must not read as one",
  );
});

test("a clip lands on a character boundary, not mid-codepoint", () => {
  reset();
  context();
  // The cap is a BYTE cap, and these tails are read: a cut through a multi-byte sequence
  // decodes to U+FFFD, so a prompt in any non-ASCII script would archive corrupted.
  const emoji = "🙂".repeat(SCOUT_PROMPT_LIMITS.entryBytes);
  const stored = appendScoutPromptTurn({
    id: "emoji",
    taskId: SCOUT.id,
    episodeId: "episode-1",
    origin: "human",
    text: emoji,
  });
  assert.ok(Buffer.byteLength(stored?.text ?? "", "utf8") <= SCOUT_PROMPT_LIMITS.entryBytes);
  assert.equal(stored?.text?.includes("�"), false, "no replacement character");
  assert.ok(stored?.text?.endsWith("🙂"), "and no lone surrogate at the tail");
});

test("past the entry cap the OLDEST human turn goes, not the newest", () => {
  reset();
  context();
  for (let i = 0; i < SCOUT_PROMPT_LIMITS.entries + 3; i++) {
    appendScoutPromptTurn({
      id: `h${i}`,
      taskId: SCOUT.id,
      episodeId: "episode-1",
      origin: "human",
      text: `follow-up ${i}`,
    });
  }
  const turns = scoutPromptTurns(SCOUT.id, "episode-1");
  assert.equal(turns.length, SCOUT_PROMPT_LIMITS.entries, "state stays bounded");
  // Newest-wins, because a truncated manifest keeps the newest follow-ups: dropping the
  // turn that just happened would lose the one an operator is most likely to be looking for.
  assert.equal(turns.at(-1)?.text, `follow-up ${SCOUT_PROMPT_LIMITS.entries + 2}`);
  assert.equal(turns[0]?.text, "follow-up 3");
  assert.equal(scoutPromptContext(SCOUT.id, "episode-1")?.truncated, true);
});

test("an automated turn is never refused for want of room", () => {
  reset();
  context();
  // Refusing one would be the single most damaging thing this table can do: that turn then
  // reads as a human's ever after, which is exactly the mis-attribution it exists to stop.
  // So a full episode evicts an old row and still records the new origin.
  for (let i = 0; i < SCOUT_PROMPT_LIMITS.entries + 2; i++) {
    appendScoutPromptTurn({
      id: `h${i}`,
      taskId: SCOUT.id,
      episodeId: "episode-1",
      origin: "human",
      text: `follow-up ${i}`,
    });
  }
  const automated = appendScoutPromptTurn({
    id: "late-foreman",
    taskId: SCOUT.id,
    episodeId: "episode-1",
    origin: "workflow",
    text: "Workflow: repair round 2",
  });
  assert.equal(automated?.origin, "workflow");
  assert.equal(scoutPromptTurns(SCOUT.id, "episode-1").at(-1)?.id, "late-foreman");
});

// ---------------------------------------------------------------------------
// Which deliveries belong to a scout
// ---------------------------------------------------------------------------

test("a ship task's session journals nothing", () => {
  reset();
  context();
  assert.equal(
    journalScoutPrompt(source({ task: SHIP }), "s1", "not a scout's follow-up", "human"),
    null,
  );
  assert.deepEqual(scoutPromptTurns(SCOUT.id, "episode-1"), []);
});

test("a session with no task and a session with no episode both journal nothing", () => {
  reset();
  context();
  assert.equal(journalScoutPrompt(source({ task: null }), "s1", "hello", "human"), null);
  assert.equal(
    journalScoutPrompt(source({ task: SCOUT, episodeId: null }), "s1", "hello", "human"),
    null,
  );
  assert.equal(journalScoutPrompt(source({ session: null }), "s1", "hello", "human"), null);
  assert.deepEqual(scoutPromptTurns(SCOUT.id, "episode-1"), []);
});

test("a scout's follow-up is journaled against its own episode", () => {
  reset();
  context();
  const turn = journalScoutPrompt(source({ task: SCOUT }), "s1", "and check pi", "human", "t1");
  assert.equal(turn?.taskId, SCOUT.id);
  assert.equal(turn?.episodeId, "episode-1");
  assert.equal(turn?.text, "and check pi");
});

// ---------------------------------------------------------------------------
// Restart
// ---------------------------------------------------------------------------

test("attribution survives the restart that empties the in-memory map", () => {
  reset();
  context();
  observeInjections((sessionId, text, origin) => {
    journalScoutPrompt(source({ task: SCOUT }), sessionId, text, origin, `inj-${text.length}`);
  });
  const automated = "Foreman: CI is red on your branch";
  recordInjection("s1", automated, "foreman");
  assert.equal(originOf("s1", automated), "foreman", "live attribution, as before");

  // The restart. `injections.ts` is deliberately in-memory, so this is exactly what a
  // daemon that came back between the delivery and the capture knows: nothing.
  forgetInjections();
  assert.equal(originOf("s1", automated), undefined);

  const journaled = scoutPromptTurns(SCOUT.id, "episode-1").find(
    (t) => t.fingerprint === scoutPromptFingerprint(automated),
  );
  assert.equal(
    journaled?.origin,
    "foreman",
    "but the durable journal still knows a machine typed it, which is the whole point",
  );
  observeInjections(null);
});

test("the journal fingerprints exactly as the live attribution map does", () => {
  // They have to agree or the collector cannot match a durable row against the transcript
  // turn the in-memory map may also know about.
  reset();
  context();
  const text = "  Foreman: look at the failing spec\n";
  observeInjections((sessionId, value, origin) => {
    journalScoutPrompt(source({ task: SCOUT }), sessionId, value, origin, "fp-1");
  });
  recordInjection("s1", text, "harness");
  observeInjections(null);
  const [turn] = scoutPromptTurns(SCOUT.id, "episode-1");
  assert.equal(turn?.fingerprint, scoutPromptFingerprint(text));
  // Same normalization, reached from the other side: the trimmed form hashes identically.
  assert.equal(turn?.fingerprint, scoutPromptFingerprint(text.trim()));
});

test("an observer that throws cannot break the delivery it was told about", () => {
  reset();
  observeInjections(() => {
    throw new Error("journal is unavailable");
  });
  assert.doesNotThrow(() => recordInjection("s1", "still a foreman turn", "foreman"));
  assert.equal(originOf("s1", "still a foreman turn"), "foreman", "and the live label still lands");
  observeInjections(null);
});

// ---------------------------------------------------------------------------
// The delivery seams
// ---------------------------------------------------------------------------

test("a dispatched scout anchors at the transcript's current size", () => {
  reset();
  const transcript = join(home, "live.jsonl");
  writeFileSync(
    transcript,
    `${JSON.stringify({
      type: "user",
      uuid: "u0",
      timestamp: new Date(0).toISOString(),
      message: { role: "user", content: "earlier work" },
    })}\n`,
  );
  const session = mkSession({ id: "s1", name: "Reconnect permissions", transcriptPath: transcript });
  const frozen = freezeScoutPromptBoundary(source({ session, task: SCOUT }), SCOUT, "s1", "current");
  assert.equal(frozen?.transcriptPath, transcript);
  assert.equal(
    frozen?.transcriptOffset,
    statSync(transcript).size,
    "everything already in the file is what the agent was told BEFORE this task",
  );
  assert.equal(frozen?.sessionName, "Reconnect permissions", "and the card's title is frozen with it");
});

test("a launch-time prompt anchors at zero, because the whole file is this episode's", () => {
  reset();
  // pi's positional argument and an embedded session's opening turn both travel with the
  // process, so there is no "before" to skip past.
  const session = mkSession({ id: "s1", agent: "pi", name: "Pi scout" });
  const frozen = freezeScoutPromptBoundary(source({ session, task: SCOUT }), SCOUT, "s1", "launch");
  assert.equal(frozen?.transcriptOffset, 0);
});

test("a launch anchor keeps its zero even when no transcript can be named yet", () => {
  reset();
  // An embedded session is created BY the delivery, so at freeze time there is no file to
  // locate. Zero is still the truth - the episode owns that file from its first byte - and a
  // collector that re-locates it later can page all of it. Nulling the offset for want of a
  // filename would report every embedded scout's trail as incomplete for no reason.
  const session = mkSession({ id: "s1", agentSessionId: null, transcriptPath: null, cwd: null });
  const frozen = freezeScoutPromptBoundary(source({ session, task: SCOUT }), SCOUT, "s1", "launch");
  assert.equal(frozen?.transcriptPath, null, "precondition: nothing was locatable");
  assert.equal(frozen?.transcriptOffset, 0);
});

test("a current anchor with no locatable transcript records no anchor at all", () => {
  reset();
  // The opposite case, and the reason the two are not one value with a fallback. Here the
  // session may already hold a conversation and nothing separates it from this task's turns,
  // so null is the honest answer and a collector must treat it as completeness it cannot
  // establish.
  const session = mkSession({ id: "s1", agentSessionId: null, transcriptPath: null, cwd: null });
  const frozen = freezeScoutPromptBoundary(source({ session, task: SCOUT }), SCOUT, "s1", "current");
  assert.equal(frozen?.transcriptPath, null);
  assert.equal(frozen?.transcriptOffset, null);
});

test("a ship task freezes no boundary at either seam", () => {
  reset();
  const session = mkSession({ id: "s1" });
  assert.equal(freezeScoutPromptBoundary(source({ session, task: SHIP }), SHIP, "s1", "current"), null);
  assert.equal(scoutPromptContextsForTask(SHIP.id).length, 0);
});

test("a scout with no work episode yet freezes nothing", () => {
  reset();
  // Inventing a key here would let two runs of one task share a boundary, and a follow-up
  // could not be attributed to either.
  const session = mkSession({ id: "s1" });
  assert.equal(
    freezeScoutPromptBoundary(source({ session, task: SCOUT, episodeId: null }), SCOUT, "s1", "current"),
    null,
  );
});

test("a delivery that failed leaves no boundary behind", () => {
  reset();
  const session = mkSession({ id: "s1" });
  const frozen = freezeScoutPromptBoundary(source({ session, task: SCOUT }), SCOUT, "s1", "current");
  assert.ok(frozen, "precondition: the boundary was frozen before the prompt was typed");
  // A boundary with no delivery behind it says the agent saw a task it never received, and
  // a later capture would anchor into a conversation that never started.
  discardScoutPromptBoundary(frozen);
  assert.equal(scoutPromptContext(SCOUT.id, "episode-1"), null);
});

test("both task-delivery seams freeze a boundary, not just the dispatcher", () => {
  // The twin of the contract-composition pin beside it in `scout-prompt.test.ts`, and for
  // the same reason: a dispatcher-only boundary would leave every scout ASSIGNED to a live
  // agent with no anchor, and its follow-ups would be collected from whatever that session
  // happened to be doing beforehand.
  const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  assert.match(src("src/server/dispatcher.ts"), /freezeScoutPromptBoundary\(/);
  assert.match(src("src/server/tasks.ts"), /freezeScoutPromptBoundary\(/);
  // And both undo it when the delivery they were freezing for did not happen - including
  // when the delivery THROWS rather than resolving a refusal, which is a separate arm at
  // both seams because `inject` is an injected dependency and nothing binds it to reject
  // through a value rather than an exception.
  assert.equal(src("src/server/dispatcher.ts").match(/discardScoutPromptBoundary\(/g)?.length, 1);
  // Two at the assignment seam, not three: one catch arm, and one combined refusal that
  // subsumes the plain `!r.ok` case rather than discarding twice.
  assert.equal(src("src/server/tasks.ts").match(/discardScoutPromptBoundary\(/g)?.length, 2);
  // The assignment seam additionally discards on an UNVERIFIED submit, which is wider than
  // its own success test: the task still proceeds on `ok` alone, as it always has, but a
  // boundary claims the episode was handed this prompt and an unconfirmed paste - the text
  // may still be in the composer - cannot support that claim.
  assert.match(src("src/server/tasks.ts"), /if \(!r\.ok \|\| !r\.submitVerified\) discardScoutPromptBoundary\(boundary\);/);
  for (const path of ["src/server/dispatcher.ts", "src/server/tasks.ts"]) {
    assert.match(
      src(path),
      /catch \(err\) \{\n\s+(\/\/[^\n]*\n\s+)*discardScoutPromptBoundary\(boundary\);\n\s+throw err;/,
      `${path} discards the boundary before a thrown delivery propagates`,
    );
  }
});

test("no seam here can break the operation it rides on", () => {
  // Each of these rides on something that matters more than it does: a rename that has
  // already repainted the card and still owes its siblings a rename, a dispatch that has
  // already started an agent, a delivery that already reached the runtime. A throw escaping
  // any of them trades a whole operation for a row.
  //
  // Driven by making the store genuinely unavailable rather than by stubbing the seam,
  // because the failure being guarded is a real write failing - a locked handle, a closed
  // connection, a full disk - and a test that mocked the throw would not notice the guard
  // moving to the wrong side of the call.
  reset();
  const session = mkSession({ id: "s1" });
  const src = source({ session, task: SCOUT });
  db.exec("ALTER TABLE scout_prompt_contexts RENAME TO scout_prompt_contexts_hidden");
  try {
    let frozen: unknown = "not run";
    assert.doesNotThrow(() => {
      frozen = freezeScoutPromptBoundary(src, SCOUT, "s1", "current");
    }, "a dispatch must not fail because its archive boundary could not be written");
    assert.equal(frozen, null, "and it reports the failure as no context rather than as one");

    assert.doesNotThrow(
      () => refreshScoutPromptTitle("s1", "Renamed"),
      "a rename must still reach its sibling panes and its bound tasks",
    );
    assert.doesNotThrow(
      () => journalScoutPrompt(src, "s1", "a follow-up", "human", "t1"),
      "a delivery that already landed must not be undone by its bookkeeping",
    );
    assert.doesNotThrow(
      () => discardScoutPromptBoundary({ taskId: SCOUT.id, episodeId: "episode-1" } as never),
      "and neither must the undo",
    );
  } finally {
    db.exec("ALTER TABLE scout_prompt_contexts_hidden RENAME TO scout_prompt_contexts");
  }
  // The store itself keeps reporting the truth - the swallowing belongs to the seam alone,
  // or a test could not tell a refused write from a successful one.
  assert.throws(() => db.exec("SELECT 1 FROM scout_prompt_contexts_hidden"));
});

test("the no-throw guarantee covers the lookups too, not just the write", () => {
  // The store is not the only thing here that can fail. Locating a transcript and asking the
  // Registry who owns a session are calls into other modules, and the claim has to be a
  // property of THIS function rather than of whatever its callees currently happen to do -
  // `dispatchEmbedded` leaves its call unguarded on the strength of it, and a throw there is
  // absorbed by a catch that logs nothing at all.
  reset();

  // A real throw from `sessionMessages`, not a stub: `transcriptFor` indexes `HARNESSES` by
  // agent, so an agent this build does not know dereferences undefined.
  const unknownAgent = mkSession({ id: "s1", agent: "not-a-harness" as never });
  assert.doesNotThrow(() =>
    freezeScoutPromptBoundary(source({ session: unknownAgent, task: SCOUT }), SCOUT, "s1", "current"),
  );

  // And a Registry whose lookups throw, which is the other half of the body.
  const hostile = {
    getSession: () => {
      throw new Error("registry unavailable");
    },
    taskForSession: () => {
      throw new Error("registry unavailable");
    },
    workEpisodeForSession: () => {
      throw new Error("registry unavailable");
    },
  };
  assert.equal(freezeScoutPromptBoundary(hostile, SCOUT, "s1", "current"), null);
  assert.equal(journalScoutPrompt(hostile, "s1", "a follow-up", "human", "t9"), null);
});

test("no route journals a prompt, because route behavior is a later phase's", () => {
  // This phase adds durable context and attribution and NO route behavior. Every delivery
  // it journals is reached from the runtime seams - `PendingTurnManager`'s two acceptance
  // points, and `observeInjections` for the automated paths - so `routes.ts` gains nothing.
  //
  // Stated over the whole file rather than over one handler, because the thing worth
  // catching is a journal call appearing at ANY route, whichever one grows it. The
  // immediate `/inject` seam is the one this most obviously wants and the one that has to
  // wait; `journalScoutPrompt`'s own doc carries the acceptance rule it will need.
  const routes = readFileSync(new URL("../src/server/routes.ts", import.meta.url), "utf8");
  assert.equal(routes.includes("journalScoutPrompt"), false);
  assert.equal(routes.includes("scoutPrompt"), false);
});
