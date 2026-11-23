import { voiceQuestionInstructions } from "../src/server/voice/decide-prompt.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { LlmRunnerId } from "../src/shared/llm.ts";
import type { AgentType } from "../src/shared/types.ts";
import type { VoiceDecisionProvider, VoiceState } from "../src/shared/voice.ts";
import {
  effectiveDecisionProvider,
  type VoiceDecisionResult,
  type VoiceKeyProvider,
  type VoiceQuestion,
} from "../src/shared/voice-decide.ts";
import type { SpokenName } from "../src/shared/voice-names.ts";
import { VoiceUtteranceSchema, type VoiceCard } from "../src/shared/voice-routing.ts";
import { createVoiceDecider, voiceRoutingRunner, VOICE_ROUTING_JOB_RUNGS, type VoiceDecider } from "../src/server/voice/decide.ts";
import { DECISION_PROVIDERS, JEV_MODEL, OPENAI_DECISIONS_MODEL } from "../src/server/voice/decision-providers.ts";
import { VoiceRouter } from "../src/server/voice/router.ts";

// The model step (contract E) with fake rungs: both real adapters over a fake `fetch` answering
// in each provider's documented reply shape, and a scripted job. No test reaches a provider or
// spawns a model.

const recorded = JSON.parse(readFileSync(new URL("./fixtures/voice-decision-providers.json", import.meta.url), "utf8"));

const steve = { id: "task:steve", label: "Steve", detail: "build engineer" };
const alice = { id: "task:alice", label: "Alice", detail: "code reviewer" };
const SPLIT: VoiceQuestion = { kind: "split", text: "Steve, check the build, and Alice, review the PR", first: steve, second: alice };
const OPENAI_ENV = "sk-env-openai-0000";
const JEV_ENV = "ts-env-jev-0000";

interface Call { url: string; auth: string | null; body: Record<string, unknown> }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function rig(options: {
  decisionProvider?: VoiceDecisionProvider | null;
  saved?: Partial<Record<VoiceKeyProvider, string>>;
  env?: NodeJS.ProcessEnv;
  reply?: (call: Call, signal: AbortSignal) => Response | Promise<Response>;
  job?: (runner: LlmRunnerId, timeoutMs: number) => Promise<{ choice: string | null; confidence: number }[]>;
  jobRunner?: LlmRunnerId;
  rungs?: typeof VOICE_ROUTING_JOB_RUNGS;
  deadlineMs?: number;
  providerTimeoutMs?: number;
  now?: () => number;
}) {
  const calls: Call[] = [];
  const jobs: { runner: LlmRunnerId; timeoutMs: number }[] = [];
  const decider = createVoiceDecider({
    config: () => ({ decisionProvider: options.decisionProvider ?? null }),
    savedKeys: () => options.saved ?? {},
    env: () => options.env ?? {},
    providers: DECISION_PROVIDERS,
    fetch: (async (url: string, init: RequestInit) => {
      const call: Call = {
        url,
        auth: new Headers(init.headers).get("authorization"),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      };
      calls.push(call);
      return options.reply ? options.reply(call, init.signal!) : json(url.endsWith("/v1/decisions") ? recorded.openai.split : recorded.jev.mention);
    }) as typeof fetch,
    job: async (_questions, run) => {
      jobs.push(run);
      return options.job ? options.job(run.runner, run.timeoutMs) : [{ choice: "mention", confidence: 1 }];
    },
    jobRunner: () => options.jobRunner ?? "claude",
    rungs: options.rungs ?? { ...VOICE_ROUTING_JOB_RUNGS, claude: { enabled: true, floor: 0.9, why: "" } },
    deadlineMs: options.deadlineMs,
    now: options.now,
    providerTimeoutMs: options.providerTimeoutMs,
  });
  return { decider, calls, jobs, ask: (agents: AgentType[] = ["claude"], questions = [SPLIT]) => decider.ask(questions, { agents }) };
}

test("automatic follows one order: saved OpenAI, saved Jev, OPENAI_API_KEY, TYPESAFE_API_KEY; off and a missing chosen key are none", () => {
  const keys = (saved: VoiceKeyProvider[], env: VoiceKeyProvider[]) => ({
    saved: { openai: saved.includes("openai"), jev: saved.includes("jev") },
    environment: { openai: env.includes("openai"), jev: env.includes("jev") },
  });
  const auto = { decisionProvider: null };
  assert.equal(effectiveDecisionProvider(auto, keys([], [])), null);
  assert.equal(effectiveDecisionProvider(auto, keys([], ["openai"])), "openai");
  assert.equal(effectiveDecisionProvider(auto, keys([], ["jev"])), "jev");
  assert.equal(effectiveDecisionProvider(auto, keys([], ["openai", "jev"])), "openai");
  assert.equal(effectiveDecisionProvider(auto, keys(["openai", "jev"], [])), "openai");
  assert.equal(effectiveDecisionProvider(auto, keys(["jev"], ["openai"])), "jev");
  assert.equal(effectiveDecisionProvider({ decisionProvider: "jev" }, keys(["openai", "jev"], [])), "jev");
  assert.equal(effectiveDecisionProvider({ decisionProvider: "jev" }, keys([], ["openai"])), null);
  assert.equal(effectiveDecisionProvider({ decisionProvider: "off" }, keys(["openai"], ["openai", "jev"])), null);
});

test("no key: the job answers and no HTTPS request is made", async () => {
  const { ask, calls, jobs } = rig({});
  const result = await ask(["codex"]);
  assert.equal(calls.length, 0);
  assert.deepEqual(jobs.map((j) => j.runner), ["codex"]);
  assert.equal(result.rung, "job");
  assert.deepEqual(result.answers, [{ choice: "mention", confidence: 1 }]);
});

test("OPENAI_API_KEY alone switches OpenAI Decisions on, with the pinned model and every question as a typed choice", async () => {
  const { ask, calls, jobs } = rig({ env: { OPENAI_API_KEY: OPENAI_ENV } });
  const result = await ask();
  assert.equal(calls.length, 1);
  assert.equal(jobs.length, 0);
  assert.equal(calls[0]!.url, "https://api.openai.com/v1/decisions");
  assert.equal(calls[0]!.auth, `Bearer ${OPENAI_ENV}`);
  assert.equal(calls[0]!.body.model, OPENAI_DECISIONS_MODEL);
  const [question] = calls[0]!.body.questions as { type: string; name: string; instructions: string; choices: { value: string }[] }[];
  assert.equal(question!.type, "choice");
  assert.equal(question!.name, "q1");
  assert.deepEqual(question!.choices.map((c) => c.value), ["split", "mention", "not sure"]);
  assert.match(question!.instructions, /Steve, check the build, and Alice, review the PR/);
  assert.deepEqual(result, { rung: "openai", answers: [{ choice: "split", confidence: 0.99 }], detail: "OpenAI Decisions answered" });
});

test("TYPESAFE_API_KEY alone asks Jev, pinned to a version, with named questions and a criteria map", async () => {
  const { ask, calls } = rig({ env: { TYPESAFE_API_KEY: JEV_ENV } });
  const result = await ask();
  assert.equal(calls[0]!.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(calls[0]!.auth, `Bearer ${JEV_ENV}`);
  assert.equal(calls[0]!.body.model, JEV_MODEL);
  const questions = calls[0]!.body.questions as Record<string, { type: string; criteria: Record<string, string> }>;
  assert.deepEqual(Object.keys(questions), ["q1"]);
  assert.equal(questions.q1!.type, "choice");
  assert.deepEqual(Object.keys(questions.q1!.criteria), ["split", "mention", "not sure"]);
  assert.deepEqual(result.answers, [{ choice: "mention", confidence: 0.99 }]);
  assert.equal(result.rung, "jev");
});

test("with both variables set, automatic asks OpenAI Decisions", async () => {
  const { ask, calls } = rig({ env: { OPENAI_API_KEY: OPENAI_ENV, TYPESAFE_API_KEY: JEV_ENV } });
  await ask();
  assert.deepEqual(calls.map((c) => c.url), ["https://api.openai.com/v1/decisions"]);
});

test("saved keys come first: both saved asks OpenAI with its saved key; a saved Jev key beats OPENAI_API_KEY; Jev chosen asks Jev", async () => {
  const both = rig({ saved: { openai: "sk-saved-openai", jev: "ts-saved-jev" }, env: { OPENAI_API_KEY: OPENAI_ENV } });
  await both.ask();
  assert.deepEqual(both.calls.map((c) => [c.url, c.auth]), [["https://api.openai.com/v1/decisions", "Bearer sk-saved-openai"]]);

  const jevSaved = rig({ saved: { jev: "ts-saved-jev" }, env: { OPENAI_API_KEY: OPENAI_ENV } });
  await jevSaved.ask();
  assert.deepEqual(jevSaved.calls.map((c) => [c.url, c.auth]), [["https://api.typesafe.ai/v1/systemone", "Bearer ts-saved-jev"]]);

  const chosen = rig({ decisionProvider: "jev", saved: { openai: "sk-saved-openai", jev: "ts-saved-jev" } });
  await chosen.ask();
  assert.deepEqual(chosen.calls.map((c) => c.url), ["https://api.typesafe.ai/v1/systemone"]);
});

test("Off with a key in the environment makes no HTTPS request and the job answers", async () => {
  const { ask, calls, jobs } = rig({ decisionProvider: "off", env: { OPENAI_API_KEY: OPENAI_ENV, TYPESAFE_API_KEY: JEV_ENV } });
  const result = await ask();
  assert.equal(calls.length, 0);
  assert.equal(jobs.length, 1);
  assert.equal(result.rung, "job");
});

test("Jev chosen with only OPENAI_API_KEY makes no HTTPS request, so that key never reaches Jev", async () => {
  const { ask, calls, jobs } = rig({ decisionProvider: "jev", env: { OPENAI_API_KEY: OPENAI_ENV } });
  const result = await ask();
  assert.equal(calls.length, 0);
  assert.equal(jobs.length, 1);
  assert.equal(result.rung, "job");
});

test("a provider error falls to the job, and its detail never carries the key", async () => {
  const { ask, jobs } = rig({
    env: { OPENAI_API_KEY: OPENAI_ENV },
    reply: () => json({ error: { message: `Incorrect API key provided: ${OPENAI_ENV}` } }, 401),
  });
  const result = await ask();
  assert.equal(jobs.length, 1);
  assert.equal(result.rung, "job");
  assert.match(result.detail, /OpenAI Decisions request failed|OpenAI Decisions HTTP 401/);
  assert.ok(!result.detail.includes(OPENAI_ENV));

  const jev = rig({ env: { TYPESAFE_API_KEY: JEV_ENV }, reply: () => json(recorded.jev.validation, 422) });
  assert.equal((await jev.ask()).rung, "job");
});

test("a provider that hangs times out and the job gets only what is left of the budget", async () => {
  const { ask, jobs } = rig({
    env: { OPENAI_API_KEY: OPENAI_ENV },
    deadlineMs: 600,
    providerTimeoutMs: 150,
    reply: (_call, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
  });
  const result = await ask();
  assert.equal(result.rung, "job");
  assert.match(result.detail, /OpenAI Decisions request failed: timed out; job on claude answered/);
  assert.equal(jobs.length, 1);
  assert.ok(jobs[0]!.timeoutMs <= 450 && jobs[0]!.timeoutMs > 300, `job budget ${jobs[0]!.timeoutMs}`);
});

test("a job past the deadline is not sure, and its late answer is never used", async () => {
  const { ask } = rig({
    deadlineMs: 100,
    job: () => new Promise((resolve) => setTimeout(() => resolve([{ choice: "split", confidence: 1 }]), 300)),
  });
  const result = await ask();
  assert.equal(result.rung, "none");
  assert.deepEqual(result.answers, [{ choice: null, confidence: 0 }]);
  assert.match(result.detail, /job on claude timed out/);
});

test("an answer that settles after the absolute deadline is discarded even before the timeout callback runs", async () => {
  let now = 0;
  const { decider } = rig({
    now: () => now,
    job: async () => {
      now = 5_000;
      return [{ choice: "split", confidence: 1 }];
    },
  });
  const result = await decider.ask([SPLIT]);
  assert.equal(result.rung, "none");
  assert.equal(result.answers[0]?.choice, null);
});

test("below the floor is not sure, a choice that is not one of the question's is not sure even at 1.0, and a refusal is not sure", async () => {
  const low = rig({ env: { OPENAI_API_KEY: OPENAI_ENV }, reply: () => json({ ...recorded.openai.split, answers: [{ ...recorded.openai.split.answers[0], confidence: 0.9 }] }) });
  assert.deepEqual((await low.ask()).answers, [{ choice: null, confidence: 0.9 }]);

  const invalid = rig({ job: async () => [{ choice: "split", confidence: 2 }] });
  assert.equal((await invalid.ask()).answers[0]?.choice, null);

  const option: VoiceQuestion = { kind: "option", text: "neither of these", prompt: "Which database?",
    options: [{ id: "pg", label: "Postgres", detail: "server" }, { id: "lite", label: "SQLite", detail: "file" }] };
  const outside = rig({ env: { OPENAI_API_KEY: OPENAI_ENV }, reply: () => json({ ...recorded.openai.split,
    answers: [{ type: "choice", name: "q1", choice: "neither of these", confidence: 1, probabilities: [] }] }) });
  assert.deepEqual((await outside.ask(["claude"], [option])).answers, [{ choice: null, confidence: 1 }]);

  const job = rig({ job: async () => [{ choice: "Atlas", confidence: 1 }] });
  const who: VoiceQuestion = { kind: "who", text: "Stevie, run it", candidates: [steve, alice] };
  assert.deepEqual((await job.ask(["codex"], [who])).answers, [{ choice: null, confidence: 1 }]);

  const refusal = rig({ env: { OPENAI_API_KEY: OPENAI_ENV }, reply: () => json(recorded.openai.refusal) });
  const refused = await refusal.ask();
  assert.equal(refused.rung, "openai");
  assert.deepEqual(refused.answers, [{ choice: null, confidence: 0 }]);
});

test("an option answer maps back to the option's id", async () => {
  const option: VoiceQuestion = { kind: "option", text: "the embedded one", prompt: "Which database?",
    options: [{ id: "pg", label: "Postgres", detail: "server" }, { id: "lite", label: "SQLite", detail: "file" }] };
  const { ask } = rig({ env: { TYPESAFE_API_KEY: JEV_ENV }, reply: () => json({ model: JEV_MODEL, usage: {},
    answers: { q1: { type: "choice", choice: "SQLite", confidence: 0.99, probabilities: {} } } }) });
  assert.deepEqual((await ask(["claude"], [option])).answers, [{ choice: "lite", confidence: 0.99 }]);
});

test("the job runs on the candidates' provider, or the background-job provider for a mixed roster; a disabled rung is not run", async () => {
  assert.equal(voiceRoutingRunner(["claude", "claude"], "codex"), "claude");
  assert.equal(voiceRoutingRunner(["codex"], "claude"), "codex");
  assert.equal(voiceRoutingRunner(["claude", "codex"], "codex"), "codex");
  assert.equal(voiceRoutingRunner(["pi"], "claude"), "claude");

  const shipped = rig({ rungs: VOICE_ROUTING_JOB_RUNGS });
  const claude = await shipped.ask(["claude"]);
  const codex = await shipped.ask(["codex"]);
  assert.deepEqual(shipped.jobs.map((j) => j.runner), VOICE_ROUTING_JOB_RUNGS.claude.enabled ? ["claude", "codex"] : ["codex"]);
  assert.equal(codex.rung, "job");
  if (!VOICE_ROUTING_JOB_RUNGS.claude.enabled) {
    assert.equal(claude.rung, "none");
    assert.deepEqual(claude.answers, [{ choice: null, confidence: 0 }]);
  }
});

// ---- the router over the model step ----

function name(spoken: string, agent: AgentType = "claude"): SpokenName {
  return { key: `task:${spoken}`, name: spoken, kind: "session", taskId: spoken, sessionId: `s:${spoken}`, role: `${spoken}'s role`,
    colorId: null, agent, state: "running" };
}

function routerRig(answer: (questions: readonly VoiceQuestion[]) => Promise<VoiceDecisionResult> | VoiceDecisionResult,
  roster = ["Steve", "Alice", "Will"].map((n) => name(n))) {
  const cards: VoiceCard[] = [];
  const delivered: [string, string, string][] = [];
  const asked: VoiceQuestion[][] = [];
  const decider: VoiceDecider = { ask: async (questions) => { asked.push([...questions]); return answer(questions); } };
  const router = new VoiceRouter(
    () => ({ mode: "listening", roster } as unknown as VoiceState),
    () => ({ enabled: true, seconds: 4 }),
    { deliver: async (target, text, id) => { delivered.push([target.name, text, id]); return "queued"; } },
    (card) => cards.push(structuredClone(card)),
    decider,
  );
  const say = async (text: string, id = text) => {
    await router.accept(VoiceUtteranceSchema.parse({ id, text, capturedAt: Date.now(), backend: "fluidaudio" }));
    await router.resolution(id);
  };
  return { router, cards, delivered, asked, say };
}

const answered = (...choices: (string | null)[]): VoiceDecisionResult => ({
  rung: "job", answers: choices.map((choice) => ({ choice, confidence: choice ? 1 : 0 })), detail: "job on claude answered",
});

test("a split is one pending card with two parts, delivered to each in order, and one cancel stops both", async () => {
  const { router, cards, delivered, asked, say } = routerRig(() => answered("split"));
  await say("Steve, check the build, and Alice, review the PR", "split");
  assert.deepEqual(asked[0]!.map((q) => q.kind), ["split"]);
  const card = cards.at(-1)!;
  assert.equal(card.state, "pending");
  assert.equal(card.reason, "split");
  assert.deepEqual(card.parts.map((p) => [p.target?.name, p.text]), [["Steve", "check the build"], ["Alice", "review the PR"]]);
  assert.deepEqual(router.pendingVoiceActions.map((a) => a.id), ["split"]);
  assert.equal(await router.sendNow("split"), true);
  assert.deepEqual(delivered, [["Steve", "check the build", "split"], ["Alice", "review the PR", "split#2"]]);
  assert.equal(cards.at(-1)!.state, "queued");

  await say("Steve, check the build, and Alice, review the PR", "cancel-me");
  router.pendingVoiceActions.at(-1)!.cancel();
  assert.equal(cards.at(-1)!.state, "cancelled");
  assert.equal(await router.sendNow("cancel-me"), false);
  assert.equal(delivered.length, 2);
  router.reset();
});

const REPEATED_NAME = "Steve, ask Alice to check the build, and Alice, review the PR";

test("each repeated name gets its own split question and only the later command reaches Alice", async (t) => {
  const { router, asked, delivered, say } = routerRig(() => answered("mention", "split"));
  t.after(() => router.reset());
  await say(REPEATED_NAME, "repeat");
  assert.deepEqual(asked[0]?.map(q => q.kind === "split" && q.second.label), ["Alice", "Alice"]);
  assert.equal(new Set(asked[0]?.map(voiceQuestionInstructions)).size, 2);
  assert.equal(await router.sendNow("repeat"), true);
  assert.deepEqual(delivered, [["Steve", "ask Alice to check the build", "repeat"], ["Alice", "review the PR", "repeat#2"]]);
});

test("picking a repeated name requires choosing its split point", async (t) => {
  const { router, cards, delivered, say } = routerRig(() => answered(null, null));
  t.after(() => router.reset());
  await say(REPEATED_NAME, "pick-repeat");
  const options = cards.at(-1)!.candidates.filter(candidate => candidate.title === "Alice");
  assert.equal(options.length, 2);
  assert.notEqual(options[0]!.id, options[1]!.id);
  await say("Alice");
  assert.equal(await router.sendNow("pick-repeat"), false);
  assert.equal(await router.pick("pick-repeat", "task:Alice"), false);
  assert.deepEqual(delivered, []);
  assert.match(options[1]!.detail, /review the PR/);
  assert.equal(await router.pick("pick-repeat", options[1]!.id), true);
  await router.sendNow("pick-repeat");
  assert.deepEqual(delivered, [["Steve", "ask Alice to check the build", "pick-repeat"], ["Alice", "review the PR", "pick-repeat#2"]]);
});

test("a repeated first addressee has distinct picks for the whole message and the split", async (t) => {
  const { router, cards, delivered, say } = routerRig(() => answered(null));
  t.after(() => router.reset());
  const body = "check the build, and Alice, review the PR";

  async function choices(id: string) {
    await say(`Alice, ${body}`, id);
    const card = cards.at(-1)!;
    assert.equal(card.state, "unsure");
    assert.deepEqual(card.candidates.map(row => row.title), ["Alice", "Alice"]);
    const whole = card.candidates.find(row => row.detail.includes("Keep the whole message"))!;
    const split = card.candidates.find(row => row.detail.includes("Split here: review the PR"))!;
    assert.notEqual(whole.id, split.id);
    return { whole, split };
  }

  const { whole } = await choices("keep");
  assert.equal(await router.pick("keep", whole.id), true);
  assert.equal(await router.sendNow("keep"), true);
  assert.deepEqual(delivered, [["Alice", body, "keep"]]);

  const { split } = await choices("divide");
  assert.equal(await router.pick("divide", split.id), true);
  assert.equal(await router.sendNow("divide"), true);
  assert.deepEqual(delivered.slice(1), [["Alice", "check the build", "divide"], ["Alice", "review the PR", "divide#2"]]);
});

test("a split after three mentioned agents still reaches its addressee", async (t) => {
  const roster = ["Steve", "Alice", "Will", "Ruby", "Ezra"].map(n => name(n));
  const { router, asked, delivered, say } = routerRig(() => answered("mention", "mention", "mention", "split"), roster);
  t.after(() => router.reset());
  await say("Steve, ask Alice and Will about Ruby today, then Ezra, review the PR", "four");
  assert.deepEqual(asked[0]?.map(q => q.kind === "split" && q.second.label), ["Alice", "Will", "Ruby", "Ezra"]);
  assert.equal(await router.sendNow("four"), true);
  assert.deepEqual(delivered, [["Steve", "ask Alice and Will about Ruby today", "four"], ["Ezra", "review the PR", "four#2"]]);
});

test("a roster pick after an uncertain mention never redirects Steve's whole message to Alice", async (t) => {
  const { router, delivered, say } = routerRig(() => answered(null));
  t.after(() => router.reset());
  await say("Steve, ask Alice about the build", "one");
  assert.equal(await router.pick("one", "task:Steve"), true);
  await router.sendNow("one");
  assert.deepEqual(delivered, [["Steve", "ask Alice about the build", "one"]]);
  await say("Steve, ask Alice about the build", "two");
  await say("Alice");
  assert.equal(await router.sendNow("two"), true);
  assert.deepEqual(delivered.slice(1), [["Steve", "ask", "two"], ["Alice", "about the build", "two#2"]]);
});

const TWO_LATER_NAMES = "Steve, ask Will about the build, and Alice, review the PR";

test("a mention followed by a split delivers the mention to the first agent and the second instruction to its addressee", async (t) => {
  const { router, cards, delivered, asked, say } = routerRig(() => answered("mention", "split"));
  t.after(() => router.reset());
  await say(TWO_LATER_NAMES, "multi");
  assert.deepEqual(asked.map((batch) => batch.map((q) => q.kind === "split" && [q.first.label, q.second.label])),
    [[["Steve", "Will"], ["Steve", "Alice"]]]);
  const card = cards.at(-1)!;
  assert.deepEqual([card.state, card.reason], ["pending", "split"]);
  assert.deepEqual(card.parts.map((part) => [part.target?.name, part.text]),
    [["Steve", "ask Will about the build"], ["Alice", "review the PR"]]);
  assert.equal(await router.sendNow("multi"), true);
  assert.deepEqual(delivered, [["Steve", "ask Will about the build", "multi"], ["Alice", "review the PR", "multi#2"]]);
});

test("an uncertain first later name prevents a subsequent split from sending", async (t) => {
  const { router, cards, delivered, say } = routerRig(() => answered(null, "split"));
  t.after(() => router.reset());
  await say(TWO_LATER_NAMES, "unsure-multi");
  const card = cards.at(-1)!;
  assert.equal(card.state, "unsure");
  assert.equal(card.deadline, null);
  assert.deepEqual(card.candidates.map((candidate) => candidate.title), ["Steve", "Will", "Alice"]);
  assert.equal(await router.sendNow("unsure-multi"), false);
  assert.deepEqual(delivered, []);
});

test("a mention sends the whole text to the first target, and the model is never asked who that is", async () => {
  const { router, cards, asked, delivered, say } = routerRig(() => answered("mention"));
  await say("Steve, ask Alice about the build", "mention");
  assert.equal(asked[0]![0]!.kind, "split");
  assert.equal((asked[0]![0] as Extract<VoiceQuestion, { kind: "split" }>).first.id, "task:Steve");
  const card = cards.at(-1)!;
  assert.deepEqual([card.state, card.reason], ["pending", "mention"]);
  assert.deepEqual(card.parts.map((p) => [p.target?.name, p.text]), [["Steve", "ask Alice about the build"]]);
  await router.sendNow("mention");
  assert.deepEqual(delivered.map(([to, text]) => [to, text]), [["Steve", "ask Alice about the build"]]);
  assert.equal(router.heard.list()[0]!.detail, "job on claude answered: mention");
  router.reset();
});

test("not sure, or no rung at all, opens the roster rows and is never an error", async () => {
  const { router, cards, say } = routerRig(() => ({ rung: "none", answers: [{ choice: null, confidence: 0 }], detail: "job on claude not run" }));
  await say("Steve, check the build, and Alice, review the PR", "unsure");
  const card = cards.at(-1)!;
  assert.equal(card.state, "unsure");
  assert.deepEqual(card.candidates.map((c) => c.title), ["Steve", "Alice"]);
  assert.equal(await router.pick("unsure", "task:Alice"), true);
  assert.deepEqual(cards.at(-1)!.parts.map(part => part.target?.name), ["Steve", "Alice"]);
  router.reset();

  const thrown = routerRig(() => { throw new Error("boom"); });
  await thrown.say("Steve, ask Alice about the build", "thrown");
  assert.equal(thrown.cards.at(-1)!.state, "unsure");
  thrown.router.reset();
});

test("identical spoken names at the start or a possible split show the candidates without asking a model", async () => {
  const alice = name("Alice");
  const roster = [name("Steve"), alice, { ...alice, key: "another-alice" }];
  const { router, cards, asked, say } = routerRig(() => answered("split"), roster);
  for (const text of ["Alice, check the build", "Steve, check the build, and Alice, review the PR"]) {
    await say(text);
    assert.equal(cards.at(-1)?.state, "unsure");
    assert.equal(cards.at(-1)?.candidates.filter((candidate) => candidate.title === "Alice").length, 2);
  }
  assert.equal(asked.length, 0);
  router.reset();
});

test("a doubtful first name asks who, and the answer is the target", async () => {
  const roster = ["Steve", "Stevie"].map((n) => name(n, "codex"));
  const cards: VoiceCard[] = [];
  const router = new VoiceRouter(() => ({ mode: "listening", roster } as unknown as VoiceState), () => ({ enabled: true, seconds: 4 }),
    { deliver: async () => "sent" }, (card) => cards.push(structuredClone(card)),
    { ask: async (questions, options) => {
      assert.deepEqual(options?.agents, ["codex", "codex"]);
      assert.equal(questions[0]!.kind, "who");
      return answered("task:Stevie");
    } });
  await router.accept(VoiceUtteranceSchema.parse({ id: "who", text: "Steven, go", capturedAt: 1, backend: "fluidaudio" }));
  await router.resolution("who");
  assert.deepEqual([cards.at(-1)!.state, cards.at(-1)!.reason, cards.at(-1)!.parts[0]!.target?.name, cards.at(-1)!.parts[0]!.text],
    ["pending", "model", "Stevie", "go"]);
  router.reset();
});

test("a slow step shows resolving after a second, and a cancel then drops the late answer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release!: (result: VoiceDecisionResult) => void;
  const { router, cards, delivered } = routerRig(() => new Promise((resolve) => { release = resolve; }));
  await router.accept(VoiceUtteranceSchema.parse({ id: "slow", text: "Steve, check the build, and Alice, review the PR", capturedAt: 1, backend: "fluidaudio" }));
  t.mock.timers.tick(999);
  assert.equal(cards.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(cards.map((c) => c.state), ["resolving"]);
  assert.deepEqual(router.pendingVoiceActions.map((a) => a.id), ["slow"]);
  router.pendingVoiceActions.at(-1)!.cancel();
  release(answered("split"));
  await router.resolution("slow");
  assert.deepEqual(cards.map((c) => c.state), ["resolving", "cancelled"]);
  assert.equal(delivered.length, 0);
  router.reset();
});

test("a quick step publishes no resolving card", async () => {
  const { router, cards, say } = routerRig(() => answered("mention"));
  await say("Steve, ask Alice about the build", "quick");
  assert.deepEqual(cards.map((c) => c.state), ["pending"]);
  router.reset();
});
