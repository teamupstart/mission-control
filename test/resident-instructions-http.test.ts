import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Registry } from "../src/server/registry.ts";
import { ReviewManager } from "../src/server/reviews.ts";
import { PersonaManager } from "../src/server/workflows/personas.ts";
import { buildApp } from "../src/server/routes.ts";
import { maintainScoutSessionCredentials } from "../src/server/scouts/session-credentials.ts";
import { sessionScoutCredentialLocator } from "../src/server/scouts/submission-auth.ts";
import { sessionScoutCredentialPath } from "../src/shared/harness-runtime.mjs";
import { ensureToken } from "../src/server/auth.ts";
import { RESIDENT_LIMITS, ResidentProfileRevisionSchema, residentLaunchInput } from "../src/shared/residents.ts";
import { RESIDENT_INSTRUCTION_CHANGE_LIMITS, type ResidentInstructionOutcome, type ResidentInstructionsView } from "../src/shared/resident-instructions.ts";
import { WORKFLOW_LIMITS } from "../src/shared/workflow.ts";
import type { ReviewItem, ServerEvent } from "../src/shared/types.ts";
import * as store from "../src/server/residents/store.ts";
import { mkTask } from "./helpers/session-fixture.ts";
import { ResidentInstructionChanges } from "../src/server/residents/instruction-changes.ts";

// A resident proposing changes to its own standing instructions, across the agent-facing routes
// and the dashboard's resolve route. What is pinned: the caller is the signed resident session
// and nothing it names; a proposal that cannot apply is refused before the operator sees it; only
// a PERSON's answer applies anything, and exactly the changes they selected, inside the answer's
// own transaction; and a proposal made against a revision that has since moved writes nothing.

const DASHBOARD = { host: "127.0.0.1:7317", "content-type": "application/json" };
const INSTRUCTIONS = "Check the backlog every hour.\nNever merge on Fridays.";
const GUIDANCE = "# Watcher\n\nWatch the queue and say what changed.";

let serial = 0;

function fixture(options: { builtin?: boolean; persona?: boolean } = {}) {
  serial += 1;
  const registry = new Registry();
  const stopCredentials = maintainScoutSessionCredentials(registry);
  const reviews = new ReviewManager(registry);
  const personas = new PersonaManager(registry);
  const events: ServerEvent[] = [];
  registry.subscribe((event) => events.push(event));
  const created = personas.create({ name: `Watcher ${serial}`, description: "", guidanceMarkdown: GUIDANCE, runner: null, model: null });
  assert.ok(created.ok);
  const personaId = options.persona === false ? "" : created.persona.id;
  const profileId = options.builtin ? `builtin:fixture-${serial}` : `profile-${serial}`;
  const settings = ResidentProfileRevisionSchema.parse({
    identity: { name: `Queue watcher ${serial}` },
    persona: { personaId },
    instructions: { markdown: INSTRUCTIONS },
  });
  store.createResidentProfile({ id: profileId, settings, at: Date.now() });
  const taskId = `resident-task-${serial}`;
  const runId = `run-${serial}`;
  store.reserveResidentRun({
    id: runId, profileId, profileRevision: 1, taskId, launchRequestId: `launch-${serial}`,
    launchInput: residentLaunchInput("/repo", ""), repoSpelling: "/repo",
    persona: personaId ? { personaId, name: created.persona.name, guidanceMarkdown: GUIDANCE } : null,
    runInstructions: "", at: Date.now(),
  });
  store.markResidentRunLaunched(runId, null);
  const resident = registry.registerSdkSession({
    id: `sdk:resident-${serial}`, agent: "claude", name: "Resident", cwd: `/repo-${serial}`,
    agentSessionId: `native-resident-${serial}`, initialState: "idle",
  });
  registry.upsertTask(mkTask({ id: taskId, kind: "resident", status: "running", sessionId: resident.id, repoRoot: "/repo" }));
  const ordinary = registry.registerSdkSession({
    id: `sdk:ordinary-${serial}`, agent: "claude", name: "Ordinary", cwd: `/other-${serial}`,
    agentSessionId: `native-ordinary-${serial}`,
  });
  const app = buildApp({ registry, reviews, tasks: {} as never, queues: {} as never, personas });
  const credential = (id: string) =>
    readFileSync(sessionScoutCredentialPath(`session:${sessionScoutCredentialLocator(id)}`), "utf8").trim();
  const agent = (path: string, body?: unknown, as = resident.id) => app.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-harness-token": ensureToken(), "x-mission-scout-credential": credential(as) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const resolve = (id: string, body: unknown) => app.request(`/api/reviews/${id}/resolve`, {
    method: "POST", headers: DASHBOARD, body: JSON.stringify(body),
  });
  const propose = async (body: unknown) => {
    const response = await agent("/mcp/residents/instructions/proposals", body);
    assert.equal(response.status, 200, await response.clone().text());
    return ((await response.json()) as { reviewId: string }).reviewId;
  };
  const outcome = async (reviewId: string) =>
    (await (await agent(`/mcp/residents/instructions/proposals/${reviewId}`)).json()) as ResidentInstructionOutcome;
  return {
    registry, reviews, personas, events, app, resident, ordinary, profileId, personaId, agent, resolve, propose, outcome,
    stop: () => stopCredentials(),
  };
}

const THREE_CHANGES = {
  summary: "From today's steering.",
  changes: [
    { target: "profile", title: "Half-hourly checks", rationale: "You asked for it twice.", find: "every hour", replace: "every 30 minutes" },
    { target: "profile", title: "Escalate blockers", replace: "Escalate blocked work to the operator." },
    { target: "persona", title: "Name the change", replace: "Lead every status with what changed." },
  ],
};

test("only the signed resident session reads its instructions, and it reads the current text", async () => {
  const f = fixture();
  try {
    const anonymous = await f.app.request("/mcp/residents/instructions", { headers: { "x-harness-token": ensureToken() } });
    assert.equal(anonymous.status, 409);
    assert.equal((await f.agent("/mcp/residents/instructions", undefined, f.ordinary.id)).status, 409);

    const response = await f.agent("/mcp/residents/instructions");
    assert.equal(response.status, 200);
    const view = (await response.json()) as ResidentInstructionsView;
    assert.equal(view.profile.id, f.profileId);
    assert.equal(view.profile.revision, 1);
    assert.equal(view.profile.instructions, INSTRUCTIONS);
    assert.equal(view.persona?.guidance, GUIDANCE);
    assert.equal(view.runProfileRevision, 1);
    assert.deepEqual(view.refusals, { profile: null, persona: null });
  } finally { f.stop(); }
});

test("a proposal that cannot apply is refused before the operator is shown anything", async () => {
  const f = fixture();
  try {
    const missing = await f.agent("/mcp/residents/instructions/proposals", {
      changes: [{ target: "profile", title: "Typo", find: "every day", replace: "every 30 minutes" }],
    });
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /does not occur in the current text/);
    const malformed = await f.agent("/mcp/residents/instructions/proposals", { changes: [] });
    assert.equal(malformed.status, 400);
    const ordinary = await f.agent("/mcp/residents/instructions/proposals", THREE_CHANGES, f.ordinary.id);
    assert.equal(ordinary.status, 409);
    assert.equal(f.registry.pendingReviews(f.resident.id).length, 0);
  } finally { f.stop(); }
});

test("only a person's answer applies the proposal, and exactly the changes they selected", async () => {
  const f = fixture();
  try {
    const reviewId = await f.propose(THREE_CHANGES);
    const review = f.registry.getReview(reviewId)!;
    assert.equal(review.status, "pending");
    // Asked as a request_input question: the same card, title and option ids the tool produces.
    assert.equal(review.kind, "input");
    assert.match(review.title, /^Which of these changes to Queue watcher \d+'s standing/);
    assert.match(review.body, /Replace:\n    every hour\nWith:\n    every 30 minutes/);
    assert.equal(review.decisions?.[0]?.id, "q");
    assert.equal(review.decisions?.[0]?.multiSelect, true);
    assert.equal(review.decisions?.[0]?.allowOther, true);
    assert.deepEqual(review.decisions?.[0]?.options.map((option) => option.label), [
      "1. Half-hourly checks", "2. Escalate blockers", "3. Name the change",
    ]);
    assert.equal((await f.outcome(reviewId)).status, "pending");

    const answer = {
      action: "answer",
      response: "1. Half-hourly checks, 3. Name the change",
      selections: [{ decisionId: "q", selected: ["o0", "o2"], other: "Keep escalation for later." }],
    };
    // Foreman is refused, and the question stays open for the operator.
    const refused = await f.resolve(reviewId, { ...answer, by: "foreman" });
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).error, /Only the operator can approve/);
    // A controlling session's answer arrives on the same route with a `session:` actor the
    // session-control dispatcher attaches; the same rule refuses it. A dismissal is anyone's.
    const changes = new ResidentInstructionChanges({
      registry: f.registry, reviews: f.reviews, persona: () => null,
      writePersonaGuidance: () => ({ ok: false }), publishPersona: () => {},
    });
    const delegated = changes.resolution(reviewId, "answer", "session:controller", answer.selections);
    assert.ok(delegated && "refusal" in delegated && delegated.refusal.status === 403);
    const dismissal = changes.resolution(reviewId, "dismiss", "foreman", null);
    assert.ok(dismissal && !("refusal" in dismissal));
    assert.equal(f.registry.getReview(reviewId)?.status, "pending");
    assert.equal(store.getResidentProfile(f.profileId)?.revision, 1);

    const answered = await f.resolve(reviewId, answer);
    assert.equal(answered.status, 200, await answered.clone().text());
    assert.equal(((await answered.json()) as ReviewItem).status, "answered");

    const profile = store.getResidentProfile(f.profileId)!;
    assert.equal(profile.revision, 2);
    assert.equal(profile.settings.instructions.markdown, "Check the backlog every 30 minutes.\nNever merge on Fridays.");
    // Every other section rides forward unchanged.
    assert.equal(profile.settings.persona.personaId, f.personaId);
    const persona = f.personas.get(f.personaId)!;
    assert.equal(persona.revision, 2);
    assert.equal(persona.guidanceMarkdown, `${GUIDANCE}\n\nLead every status with what changed.`);
    // Announced after the commit, through the ordinary events every surface already follows.
    assert.ok(f.events.some((event) => event.type === "resident_profile_upsert" && event.profile.revision === 2));
    assert.ok(f.events.some((event) => event.type === "persona_upsert" && event.persona.id === f.personaId && event.persona.revision === 2));

    const result = await f.outcome(reviewId);
    assert.equal(result.status, "applied");
    assert.deepEqual(result.applied.map((change) => change.index), [0, 2]);
    assert.deepEqual(result.skipped.map((change) => change.index), [1]);
    assert.equal(result.profileRevision, 2);
    assert.equal(result.personaRevision, 2);
    assert.equal(result.feedback, "Keep escalation for later.");
    assert.match(result.message, /keeps the instructions it launched with until the operator chooses Restart on new profile/);

    // Settled once: a second answer neither re-applies nor rewrites the outcome.
    await f.resolve(reviewId, answer);
    assert.equal(store.getResidentProfile(f.profileId)?.revision, 2);
    assert.deepEqual(await f.outcome(reviewId), result);
    // The run still reads only the revision it pinned.
    assert.equal(((await (await f.agent("/mcp/residents/instructions")).json()) as ResidentInstructionsView).runProfileRevision, 1);
  } finally { f.stop(); }
});

test("a proposal whose profile moved on writes nothing, and a dismissal writes nothing", async () => {
  const f = fixture();
  try {
    const stale = await f.propose(THREE_CHANGES);
    const current = store.getResidentProfile(f.profileId)!;
    const moved = store.updateResidentProfile({
      id: f.profileId, expectedRevision: current.revision, at: Date.now(),
      settings: { ...current.settings, instructions: { markdown: `${INSTRUCTIONS}\nEdited by hand.` } },
    });
    assert.equal(moved.status, "ok");
    const answered = await f.resolve(stale, {
      action: "answer", response: "all",
      selections: [{ decisionId: "q", selected: ["o0", "o2"], other: null }],
    });
    assert.equal(answered.status, 200);
    const result = await f.outcome(stale);
    assert.equal(result.status, "stale");
    assert.match(result.message, /changed after this was proposed \(now revision 2\)/);
    assert.equal(store.getResidentProfile(f.profileId)?.revision, 2);
    // The Persona half was selected too, and it is not written on its own.
    assert.equal(f.personas.get(f.personaId)?.revision, 1);

    const dismissed = await f.propose({ changes: [{ target: "profile", title: "Shorter", replace: "Be brief." }] });
    assert.equal((await f.resolve(dismissed, { action: "dismiss", response: null })).status, 200);
    assert.equal((await f.outcome(dismissed)).status, "dismissed");
    assert.equal(store.getResidentProfile(f.profileId)?.revision, 2);
  } finally { f.stop(); }
});

test("a selection that would leave the resident with no role is refused whole", async () => {
  const f = fixture({ persona: false });
  try {
    const reviewId = await f.propose({
      changes: [{ target: "profile", title: "Drop everything", find: INSTRUCTIONS, replace: "" }],
    });
    await f.resolve(reviewId, {
      action: "answer", response: "1",
      selections: [{ decisionId: "q", selected: ["o0"], other: null }],
    });
    const result = await f.outcome(reviewId);
    assert.equal(result.status, "refused");
    assert.match(result.message, /no role/);
    assert.equal(store.getResidentProfile(f.profileId)?.revision, 1);
    // No Persona to edit: a Persona change is refused at proposal time.
    const persona = await f.agent("/mcp/residents/instructions/proposals", {
      changes: [{ target: "persona", title: "Tone", replace: "Be kind." }],
    });
    assert.equal(persona.status, 409);
    assert.match((await persona.json()).error, /names no Persona/);
  } finally { f.stop(); }
});

test("a built-in resident's profile is refused as an edit target", async () => {
  const f = fixture({ builtin: true });
  try {
    const view = (await (await f.agent("/mcp/residents/instructions")).json()) as ResidentInstructionsView;
    assert.match(view.refusals.profile ?? "", /built-in resident/);
    const refused = await f.agent("/mcp/residents/instructions/proposals", {
      changes: [{ target: "profile", title: "Cadence", find: "every hour", replace: "hourly" }],
    });
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /Duplicate/);
    assert.equal(f.registry.pendingReviews(f.resident.id).length, 0);
  } finally { f.stop(); }
});

test("an answer that arrives after the resident's tool call ended still applies, and the continuation says what it did", async () => {
  const f = fixture();
  try {
    const delivered: string[] = [];
    f.reviews.startContinuationRecovery((_review, text) => {
      delivered.push(text);
      return true;
    });
    const reviewId = await f.propose({ changes: [{ target: "profile", title: "Half-hourly checks", find: "every hour", replace: "every 30 minutes" }] });
    // The MCP host gave up on the blocking call: the bridge hands the wait off to the daemon.
    assert.ok(f.reviews.detachWait(reviewId, f.resident.id));
    assert.equal(delivered.length, 0);

    const answered = await f.resolve(reviewId, {
      action: "answer", response: "1. Half-hourly checks",
      selections: [{ decisionId: "q", selected: ["o0"], other: null }],
    });
    assert.equal(answered.status, 200);
    assert.equal(store.getResidentProfile(f.profileId)?.settings.instructions.markdown, "Check the backlog every 30 minutes.\nNever merge on Fridays.");
    assert.equal(delivered.length, 1);
    assert.match(delivered[0]!, /was answered after its MCP wait ended/);
    assert.match(delivered[0]!, /What Mission Control did with your proposed instruction changes:\noutcome=applied\n/);
    assert.match(delivered[0]!, /Applied: 1\. Half-hourly checks/);
  } finally { f.stop(); }
});

test("an answer that selects nothing, or moves the proposal to chat, writes nothing and records why", async () => {
  const f = fixture();
  try {
    const unchanged = () => {
      const profile = store.getResidentProfile(f.profileId)!;
      assert.equal(profile.revision, 1);
      assert.equal(profile.settings.instructions.markdown, INSTRUCTIONS);
      const persona = f.personas.get(f.personaId)!;
      assert.equal(persona.revision, 1);
      assert.equal(persona.guidanceMarkdown, GUIDANCE);
    };

    // Submitted with no change ticked, and guidance in Other instead.
    const empty = await f.propose(THREE_CHANGES);
    const none = await f.resolve(empty, {
      action: "answer", response: "Other: Try again with only the cadence change.",
      selections: [{ decisionId: "q", selected: [], other: "Try again with only the cadence change." }],
    });
    assert.equal(none.status, 200, await none.clone().text());
    assert.equal(f.registry.getReview(empty)?.status, "answered");
    const noneOutcome = await f.outcome(empty);
    assert.equal(noneOutcome.status, "none_selected");
    assert.deepEqual(noneOutcome.applied, []);
    assert.deepEqual(noneOutcome.skipped.map((change) => change.index), [0, 1, 2]);
    assert.equal(noneOutcome.feedback, "Try again with only the cadence change.");
    assert.match(noneOutcome.message, /applied none of the proposed changes and left guidance/);
    assert.equal(noneOutcome.profileRevision, null);
    assert.equal(noneOutcome.personaRevision, null);
    unchanged();

    // "Chat about it", in the shape the review modal sends: nothing picked, the move flagged.
    const chatted = await f.propose({ changes: [{ target: "persona", title: "Name the change", replace: "Lead with what changed." }] });
    const chat = await f.resolve(chatted, {
      action: "answer", response: "Let's discuss this in the conversation first.",
      selections: [{ decisionId: "q", selected: [], other: null, chat: true }],
    });
    assert.equal(chat.status, 200, await chat.clone().text());
    const chatOutcome = await f.outcome(chatted);
    assert.equal(chatOutcome.status, "chat");
    assert.deepEqual(chatOutcome.applied, []);
    assert.match(chatOutcome.message, /moved this proposal to the conversation, so nothing was changed/);
    unchanged();
    assert.ok(!f.events.some((event) => event.type === "resident_profile_upsert" && event.profile.id === f.profileId));
  } finally { f.stop(); }
});

test("a Persona-only selection after the Persona moved on writes nothing", async () => {
  const f = fixture();
  try {
    const reviewId = await f.propose(THREE_CHANGES);
    // Edited in the Library after the proposal was made: the Persona is now at revision 2.
    const edited = f.personas.update(f.personaId, { expectedRevision: 1, description: "Edited elsewhere." });
    assert.ok(edited.ok);
    const answered = await f.resolve(reviewId, {
      action: "answer", response: "3. Name the change",
      selections: [{ decisionId: "q", selected: ["o2"], other: null }],
    });
    assert.equal(answered.status, 200);
    const result = await f.outcome(reviewId);
    assert.equal(result.status, "stale");
    assert.match(result.message, /The Persona Watcher \d+ changed after this was proposed \(now revision 2\), so nothing was changed/);
    assert.deepEqual(result.applied, []);
    const persona = f.personas.get(f.personaId)!;
    assert.equal(persona.revision, 2);
    assert.equal(persona.guidanceMarkdown, GUIDANCE);
    assert.equal(store.getResidentProfile(f.profileId)?.revision, 1);
  } finally { f.stop(); }
});

test("a Persona write refused in a mixed selection writes neither target and records the refusal", async () => {
  const f = fixture();
  try {
    const reviewId = await f.propose(THREE_CHANGES);
    // The resolve route's own sequence, with a Persona store that refuses the compare-and-set
    // after validation passed: the write that can still lose a race once the answer arrives.
    let published = 0;
    const failing = new ResidentInstructionChanges({
      registry: f.registry,
      reviews: f.reviews,
      persona: (id) => f.personas.store.getPersona(id),
      writePersonaGuidance: () => ({ ok: false, reason: "revision_conflict" }),
      publishPersona: () => { published += 1; },
    });
    const selections = [{ decisionId: "q", selected: ["o0", "o2"], other: null }];
    const resolution = failing.resolution(reviewId, "answer", "human", selections);
    assert.ok(resolution && "persist" in resolution);
    const settled = f.reviews.resolve(reviewId, "answer", "1. Half-hourly checks, 3. Name the change", "human", selections, resolution.persist);
    resolution.publish();
    assert.equal(settled?.status, "answered");

    const result = await f.outcome(reviewId);
    assert.equal(result.status, "refused");
    assert.match(result.message, /The Persona Watcher \d+ could not be updated \(revision_conflict\), so nothing was changed/);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.skipped.map((change) => change.index), [0, 1, 2]);
    assert.equal(result.profileRevision, null);
    // The profile change was selected too, and it is not written on its own.
    const profile = store.getResidentProfile(f.profileId)!;
    assert.equal(profile.revision, 1);
    assert.equal(profile.settings.instructions.markdown, INSTRUCTIONS);
    assert.equal(f.personas.get(f.personaId)?.revision, 1);
    assert.equal(published, 0);
    assert.ok(!f.events.some((event) => event.type === "resident_profile_upsert" && event.profile.id === f.profileId));
  } finally { f.stop(); }
});

test("a selection that would empty the Persona's guidance is refused, and the Persona is unchanged", async () => {
  const f = fixture();
  try {
    const reviewId = await f.propose({
      changes: [{ target: "persona", title: "Drop the guidance", find: GUIDANCE, replace: "" }],
    });
    const answered = await f.resolve(reviewId, {
      action: "answer", response: "1. Drop the guidance",
      selections: [{ decisionId: "q", selected: ["o0"], other: null }],
    });
    assert.equal(answered.status, 200, await answered.clone().text());
    assert.equal(f.registry.getReview(reviewId)?.status, "answered");
    const result = await f.outcome(reviewId);
    assert.equal(result.status, "refused");
    assert.equal(result.message, "The selected changes would empty the Persona's guidance, so nothing was changed.");
    assert.deepEqual(result.applied, []);
    assert.equal(result.personaRevision, null);
    const persona = f.personas.get(f.personaId)!;
    assert.equal(persona.revision, 1);
    assert.equal(persona.guidanceMarkdown, GUIDANCE);
    assert.equal(store.getResidentProfile(f.profileId)?.revision, 1);
    assert.ok(!f.events.some((event) => event.type === "persona_upsert" && event.persona.id === f.personaId && event.persona.revision === 2));
  } finally { f.stop(); }
});

test("a proposal whose largest result reaches each target's size limit is asked, and one past it is refused before any review", async () => {
  const f = fixture();
  const reviews = () => f.registry.pendingReviews(f.resident.id).length;
  try {
    // Profile instructions are bounded in characters. An append joins with a blank line, so the
    // largest result is the current text, two newlines and the appended passage.
    const profileRoom = RESIDENT_LIMITS.instructionsLength - INSTRUCTIONS.length - 2;
    const overProfile = await f.agent("/mcp/residents/instructions/proposals", {
      changes: [{ target: "profile", title: "One character too long", replace: "x".repeat(profileRoom + 1) }],
    });
    assert.equal(overProfile.status, 400);
    assert.match((await overProfile.json()).error, new RegExp(`past ${RESIDENT_LIMITS.instructionsLength} characters`));
    assert.equal(reviews(), 0);
    await f.propose({ changes: [{ target: "profile", title: "Exactly at the limit", replace: "x".repeat(profileRoom) }] });
    assert.equal(reviews(), 1);

    // Persona guidance is bounded in UTF-8 BYTES, not characters: four appends of three-byte
    // characters plus one ASCII append reach exactly the byte limit at well under 100,000 characters.
    const wide = "€".repeat(RESIDENT_INSTRUCTION_CHANGE_LIMITS.passage);
    const wideBytes = Buffer.byteLength(wide);
    const used = Buffer.byteLength(GUIDANCE) + 4 * (2 + wideBytes);
    const asciiRoom = WORKFLOW_LIMITS.personaGuidanceBytes - used - 2;
    assert.ok(asciiRoom > 0 && asciiRoom < RESIDENT_INSTRUCTION_CHANGE_LIMITS.passage);
    const personaChanges = (ascii: number) => ({
      changes: [
        ...[1, 2, 3, 4].map((n) => ({ target: "persona", title: `Wide passage ${n}`, replace: wide })),
        { target: "persona", title: "ASCII passage", replace: "y".repeat(ascii) },
      ],
    });
    const overPersona = await f.agent("/mcp/residents/instructions/proposals", personaChanges(asciiRoom + 1));
    assert.equal(overPersona.status, 400);
    assert.match((await overPersona.json()).error, new RegExp(`past ${WORKFLOW_LIMITS.personaGuidanceBytes} UTF-8 bytes`));
    assert.equal(reviews(), 1);
    await f.propose(personaChanges(asciiRoom));
    assert.equal(reviews(), 2);
  } finally { f.stop(); }
});

test("a proposal's outcome is refused to another resident's signed session", async () => {
  const f = fixture();
  try {
    // A second live resident in the same daemon, with its own signed session.
    const otherProfile = `other-profile-${serial}`;
    store.createResidentProfile({
      id: otherProfile,
      settings: ResidentProfileRevisionSchema.parse({ identity: { name: `Other watcher ${serial}` }, instructions: { markdown: "Watch something else." } }),
      at: Date.now(),
    });
    store.reserveResidentRun({
      id: `other-run-${serial}`, profileId: otherProfile, profileRevision: 1, taskId: `other-task-${serial}`,
      launchRequestId: `other-launch-${serial}`, launchInput: residentLaunchInput("/repo", ""), repoSpelling: "/repo",
      persona: null, runInstructions: "", at: Date.now(),
    });
    store.markResidentRunLaunched(`other-run-${serial}`, null);
    const other = f.registry.registerSdkSession({
      id: `sdk:other-resident-${serial}`, agent: "claude", name: "Other resident", cwd: `/other-resident-${serial}`,
      agentSessionId: `native-other-resident-${serial}`, initialState: "idle",
    });
    f.registry.upsertTask(mkTask({ id: `other-task-${serial}`, kind: "resident", status: "running", sessionId: other.id, repoRoot: "/repo" }));
    // It is a signed resident caller in its own right: it reads its own instructions.
    const own = await f.agent("/mcp/residents/instructions", undefined, other.id);
    assert.equal(own.status, 200);
    assert.equal(((await own.json()) as ResidentInstructionsView).profile.id, otherProfile);

    const reviewId = await f.propose(THREE_CHANGES);
    const path = `/mcp/residents/instructions/proposals/${reviewId}`;
    const refused = await f.agent(path, undefined, other.id);
    assert.equal(refused.status, 404);
    assert.deepEqual(await refused.json(), { error: "No proposal by that review id belongs to this session." });
    // Settled or not, the outcome stays the proposing session's alone.
    await f.resolve(reviewId, { action: "answer", response: "1", selections: [{ decisionId: "q", selected: ["o0"], other: null }] });
    assert.equal((await f.agent(path, undefined, other.id)).status, 404);
    const mine = await f.agent(path);
    assert.equal(mine.status, 200);
    assert.equal(((await mine.json()) as ResidentInstructionOutcome).status, "applied");
  } finally { f.stop(); }
});

test("a same-length Persona replacement that grows its UTF-8 bytes past the limit is refused before any review", async () => {
  const f = fixture();
  const reviews = () => f.registry.pendingReviews(f.resident.id).length;
  try {
    // Guidance ending in a unique 8,000-character ASCII passage. Replacing it with 8,000
    // three-byte characters keeps the character count and adds 16,000 bytes.
    const passage = "z".repeat(RESIDENT_INSTRUCTION_CHANGE_LIMITS.passage);
    const wide = "€".repeat(RESIDENT_INSTRUCTION_CHANGE_LIMITS.passage);
    const growth = Buffer.byteLength(wide) - Buffer.byteLength(passage);
    const guidanceWithFiller = (filler: number) => `${GUIDANCE}\n\n${"a".repeat(filler)}\n\n${passage}`;
    const fillerAtLimit = WORKFLOW_LIMITS.personaGuidanceBytes - growth - Buffer.byteLength(guidanceWithFiller(0));
    const setGuidance = (guidanceMarkdown: string) => {
      const current = f.personas.get(f.personaId)!;
      assert.ok(f.personas.update(f.personaId, { expectedRevision: current.revision, guidanceMarkdown }).ok);
    };
    const swap = { changes: [{ target: "persona", title: "Widen the passage", find: passage, replace: wide }] };

    // One byte past the limit once replaced, though the guidance is well under it now.
    setGuidance(guidanceWithFiller(fillerAtLimit + 1));
    assert.ok(Buffer.byteLength(f.personas.get(f.personaId)!.guidanceMarkdown) < WORKFLOW_LIMITS.personaGuidanceBytes);
    const over = await f.agent("/mcp/residents/instructions/proposals", swap);
    assert.equal(over.status, 400);
    assert.match((await over.json()).error, new RegExp(`past ${WORKFLOW_LIMITS.personaGuidanceBytes} UTF-8 bytes`));
    assert.equal(reviews(), 0);

    // Exactly at the limit once replaced: asked, and the answer applies what it showed.
    setGuidance(guidanceWithFiller(fillerAtLimit));
    const reviewId = await f.propose(swap);
    assert.equal(reviews(), 1);
    await f.resolve(reviewId, { action: "answer", response: "1", selections: [{ decisionId: "q", selected: ["o0"], other: null }] });
    assert.equal((await f.outcome(reviewId)).status, "applied");
    assert.equal(Buffer.byteLength(f.personas.get(f.personaId)!.guidanceMarkdown), WORKFLOW_LIMITS.personaGuidanceBytes);
  } finally { f.stop(); }
});

test("a Persona selection is stale once the profile names a different Persona, or none", async () => {
  for (const next of ["other", "none"] as const) {
    const f = fixture();
    try {
      const reviewId = await f.propose({ changes: [{ target: "persona", title: "Name the change", replace: "Lead with what changed." }] });
      // After the proposal opened, the profile switches away from the Persona it was made for.
      const other = f.personas.create({ name: `Other persona ${serial}`, description: "", guidanceMarkdown: "# Other\n\nBe other.", runner: null, model: null });
      assert.ok(other.ok);
      const current = store.getResidentProfile(f.profileId)!;
      assert.equal(store.updateResidentProfile({
        id: f.profileId, expectedRevision: current.revision, at: Date.now(),
        settings: { ...current.settings, persona: { personaId: next === "other" ? other.persona.id : "" } },
      }).status, "ok");

      const answered = await f.resolve(reviewId, {
        action: "answer", response: "1. Name the change",
        selections: [{ decisionId: "q", selected: ["o0"], other: null }],
      });
      assert.equal(answered.status, 200);
      const result = await f.outcome(reviewId);
      assert.equal(result.status, "stale", next);
      assert.match(result.message, /no longer names the Persona this was proposed for, so nothing was changed/);
      assert.deepEqual(result.applied, []);
      // Neither the Persona it was proposed for nor the one the profile names now is written.
      const original = f.personas.get(f.personaId)!;
      assert.equal(original.revision, 1);
      assert.equal(original.guidanceMarkdown, GUIDANCE);
      const switched = f.personas.get(other.persona.id)!;
      assert.equal(switched.revision, 1);
      assert.equal(switched.guidanceMarkdown, "# Other\n\nBe other.");
      assert.equal(store.getResidentProfile(f.profileId)?.revision, 2);
    } finally { f.stop(); }
  }
});

test("a built-in Persona is refused as an edit target, and nothing opens or changes", async () => {
  const f = fixture();
  try {
    const shipped = f.personas.list().find((persona) => persona.builtin)!;
    assert.ok(shipped, "this build ships at least one built-in Persona");
    const current = store.getResidentProfile(f.profileId)!;
    assert.equal(store.updateResidentProfile({
      id: f.profileId, expectedRevision: current.revision, at: Date.now(),
      settings: { ...current.settings, persona: { personaId: shipped.id } },
    }).status, "ok");
    const before = { profile: store.getResidentProfile(f.profileId)!, persona: f.personas.get(shipped.id)! };

    const view = (await (await f.agent("/mcp/residents/instructions")).json()) as ResidentInstructionsView;
    assert.equal(view.persona?.id, shipped.id);
    assert.equal(view.persona?.builtin, true);
    assert.match(view.refusals.persona ?? "", /ships with Mission Control and cannot be edited/);

    const refused = await f.agent("/mcp/residents/instructions/proposals", {
      changes: [{ target: "persona", title: "Tone", replace: "Be brief." }],
    });
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, new RegExp(`The Persona ${shipped.name} ships with Mission Control and cannot be edited`));
    assert.equal(f.registry.pendingReviews(f.resident.id).length, 0);
    const after = { profile: store.getResidentProfile(f.profileId)!, persona: f.personas.get(shipped.id)! };
    assert.equal(after.persona.revision, before.persona.revision);
    assert.equal(after.persona.guidanceMarkdown, before.persona.guidanceMarkdown);
    assert.equal(after.profile.revision, before.profile.revision);
    assert.equal(after.profile.settings.instructions.markdown, INSTRUCTIONS);
  } finally { f.stop(); }
});

test("an archived Persona is refused as an edit target, and nothing opens or changes", async () => {
  const f = fixture();
  try {
    assert.ok(f.personas.archive(f.personaId, 1).ok);
    const before = f.personas.get(f.personaId)!;
    assert.notEqual(before.archivedAt, null);

    const view = (await (await f.agent("/mcp/residents/instructions")).json()) as ResidentInstructionsView;
    assert.match(view.refusals.persona ?? "", /is archived/);

    const refused = await f.agent("/mcp/residents/instructions/proposals", {
      changes: [{ target: "persona", title: "Tone", replace: "Be brief." }],
    });
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, new RegExp(`The Persona Watcher \\d+ is archived\\.`));
    assert.equal(f.registry.pendingReviews(f.resident.id).length, 0);
    const after = f.personas.get(f.personaId)!;
    assert.equal(after.revision, before.revision);
    assert.equal(after.archivedAt, before.archivedAt);
    assert.equal(after.guidanceMarkdown, GUIDANCE);
    assert.equal(store.getResidentProfile(f.profileId)?.revision, 1);
  } finally { f.stop(); }
});

test("an archived profile is refused as an edit target, a mixed proposal is refused whole, and nothing opens or changes", async () => {
  const f = fixture();
  try {
    assert.equal(store.archiveResidentProfile({ id: f.profileId, expectedRevision: 1, at: Date.now() }).status, "ok");
    const before = store.getResidentProfile(f.profileId)!;
    assert.notEqual(before.archivedAt, null);

    const view = (await (await f.agent("/mcp/residents/instructions")).json()) as ResidentInstructionsView;
    assert.match(view.refusals.profile ?? "", /is archived/);

    for (const changes of [
      [{ target: "profile", title: "Half-hourly checks", find: "every hour", replace: "every 30 minutes" }],
      // A Persona change beside it does not let the profile change through.
      [
        { target: "persona", title: "Tone", replace: "Be brief." },
        { target: "profile", title: "Half-hourly checks", find: "every hour", replace: "every 30 minutes" },
      ],
    ]) {
      const refused = await f.agent("/mcp/residents/instructions/proposals", { changes });
      assert.equal(refused.status, 409);
      assert.match((await refused.json()).error, new RegExp(`edits the profile: The profile Queue watcher \\d+ is archived\\.`));
    }
    assert.equal(f.registry.pendingReviews(f.resident.id).length, 0);
    const after = store.getResidentProfile(f.profileId)!;
    assert.equal(after.revision, before.revision);
    assert.equal(after.archivedAt, before.archivedAt);
    assert.equal(after.settings.instructions.markdown, INSTRUCTIONS);
    const persona = f.personas.get(f.personaId)!;
    assert.equal(persona.revision, 1);
    assert.equal(persona.guidanceMarkdown, GUIDANCE);
  } finally { f.stop(); }
});

test("a profile archived while its proposals are open refuses their answers, and nothing is written to either target", async () => {
  const f = fixture();
  try {
    // Two proposals open before the archive: one answered with a profile change alone, one with a
    // Persona change beside a profile change.
    const profileOnly = await f.propose(THREE_CHANGES);
    const mixed = await f.propose({ changes: [
      { target: "persona", title: "Name the change", replace: "Lead with what changed." },
      { target: "profile", title: "Half-hourly checks", find: "every hour", replace: "every 30 minutes" },
    ] });
    assert.equal(f.registry.pendingReviews(f.resident.id).length, 2);
    assert.equal(store.archiveResidentProfile({ id: f.profileId, expectedRevision: 1, at: Date.now() }).status, "ok");
    const archived = store.getResidentProfile(f.profileId)!;

    for (const [reviewId, selected] of [[profileOnly, ["o0"]], [mixed, ["o0", "o1"]]] as const) {
      const answered = await f.resolve(reviewId, {
        action: "answer", response: "selected", selections: [{ decisionId: "q", selected: [...selected], other: null }],
      });
      assert.equal(answered.status, 200, await answered.clone().text());
      assert.equal(f.registry.getReview(reviewId)?.status, "answered");
      const result = await f.outcome(reviewId);
      assert.equal(result.status, "refused");
      assert.match(result.message, /^The profile Queue watcher \d+ can no longer be edited, so nothing was changed\.$/);
      assert.deepEqual(result.applied, []);
      assert.equal(result.profileRevision, null);
      assert.equal(result.personaRevision, null);
    }
    const after = store.getResidentProfile(f.profileId)!;
    assert.equal(after.revision, archived.revision);
    assert.equal(after.archivedAt, archived.archivedAt);
    assert.equal(after.settings.instructions.markdown, INSTRUCTIONS);
    // The mixed answer's Persona change was not written on its own.
    const persona = f.personas.get(f.personaId)!;
    assert.equal(persona.revision, 1);
    assert.equal(persona.guidanceMarkdown, GUIDANCE);
    assert.ok(!f.events.some((event) => event.type === "persona_upsert" && event.persona.id === f.personaId && event.persona.revision > 1));
  } finally { f.stop(); }
});

test("a Persona archived while its proposals are open refuses their answers, and a mixed answer writes no profile change", async () => {
  const f = fixture();
  try {
    const personaOnly = await f.propose({ changes: [{ target: "persona", title: "Name the change", replace: "Lead with what changed." }] });
    const mixed = await f.propose(THREE_CHANGES);
    assert.equal(f.registry.pendingReviews(f.resident.id).length, 2);
    assert.ok(f.personas.archive(f.personaId, 1).ok);
    const archived = f.personas.get(f.personaId)!;
    assert.notEqual(archived.archivedAt, null);

    for (const [reviewId, selected] of [[personaOnly, ["o0"]], [mixed, ["o0", "o2"]]] as const) {
      const answered = await f.resolve(reviewId, {
        action: "answer", response: "selected", selections: [{ decisionId: "q", selected: [...selected], other: null }],
      });
      assert.equal(answered.status, 200, await answered.clone().text());
      assert.equal(f.registry.getReview(reviewId)?.status, "answered");
      const result = await f.outcome(reviewId);
      assert.equal(result.status, "refused");
      assert.equal(result.message, "The Persona can no longer be edited, so nothing was changed.");
      assert.deepEqual(result.applied, []);
      assert.equal(result.profileRevision, null);
      assert.equal(result.personaRevision, null);
    }
    const persona = f.personas.get(f.personaId)!;
    assert.equal(persona.revision, archived.revision);
    assert.equal(persona.archivedAt, archived.archivedAt);
    assert.equal(persona.guidanceMarkdown, GUIDANCE);
    // The mixed answer's profile change passed its own checks and was still not written.
    const profile = store.getResidentProfile(f.profileId)!;
    assert.equal(profile.revision, 1);
    assert.equal(profile.settings.instructions.markdown, INSTRUCTIONS);
    assert.ok(!f.events.some((event) => event.type === "resident_profile_upsert" && event.profile.id === f.profileId));
  } finally { f.stop(); }
});
