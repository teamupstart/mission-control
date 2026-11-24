import { buildVoiceRoutingPrompt, parseVoiceRoutingReply, voiceChoiceValues, voiceQuestionInstructions } from "../src/server/voice/decide-prompt.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { LlmRunnerId } from "../src/shared/llm.ts";
import type { AgentType } from "../src/shared/types.ts";
import type { VoiceDecisionProvider } from "../src/shared/voice.ts";
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

interface Call { url: string; auth: string | null; body: Record<string, unknown>; redirect?: RequestRedirect }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function rig(options: {
  decisionProvider?: VoiceDecisionProvider | null;
  saved?: Partial<Record<VoiceKeyProvider, string>>;
  env?: NodeJS.ProcessEnv;
  reply?: (call: Call, signal: AbortSignal) => Response | Promise<Response>;
  job?: (runner: LlmRunnerId, timeoutMs: number, signal?: AbortSignal) => Promise<{ choice: string | null; confidence: number }[]>;
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
        redirect: init.redirect,
        auth: new Headers(init.headers).get("authorization"),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      };
      calls.push(call);
      return options.reply ? options.reply(call, init.signal!) : json(url.endsWith("/v1/decisions") ? recorded.openai.split : recorded.jev.mention);
    }) as typeof fetch,
    job: async (_questions, run) => {
      jobs.push(run);
      return options.job ? options.job(run.runner, run.timeoutMs, run.signal) : [{ choice: "mention", confidence: 1 }];
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
  const speech = "Steve, archive the release notes, and Alice, check the spelling";
  const result = await ask(["claude"], [{ ...SPLIT, text: speech }]);
  assert.equal(calls.length, 1);
  assert.equal(jobs.length, 0);
  assert.equal(calls[0]!.url, "https://api.openai.com/v1/decisions");
  assert.equal(calls[0]!.auth, `Bearer ${OPENAI_ENV}`);
  assert.equal(calls[0]!.body.model, OPENAI_DECISIONS_MODEL);
  const [question] = calls[0]!.body.questions as { type: string; name: string; instructions: string; choices: { value: string }[] }[];
  assert.equal(question!.type, "choice");
  assert.equal(question!.name, "q1");
  assert.deepEqual(question!.choices.map((c) => c.value), ["split", "mention", "not sure"]);
  assert.ok(String(calls[0]!.body.input).includes(speech));
  assert.ok(!question!.instructions.includes(speech));
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

test("a provider that hangs times out and the job gets only what is left of the budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let onProviderStart!: (signal: AbortSignal) => void;
  const started = new Promise<AbortSignal>(resolve => { onProviderStart = resolve; });
  const { ask, jobs } = rig({
    env: { OPENAI_API_KEY: OPENAI_ENV },
    deadlineMs: 600,
    providerTimeoutMs: 150,
    now: Date.now,
    reply: (_call, signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
      onProviderStart(signal);
    }),
  });
  const pending = ask();
  const signal = await started;
  t.mock.timers.tick(149);
  assert.equal(signal.aborted, false);
  assert.equal(jobs.length, 0);
  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(signal.aborted, true);
  assert.equal(result.rung, "job");
  assert.match(result.detail, /OpenAI Decisions (?:request failed: )?timed out; job on claude answered/);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.timeoutMs, 450);
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
  const outside = rig({ job: async () => [{ choice: "lite", confidence: 0.99 }], env: { OPENAI_API_KEY: OPENAI_ENV }, reply: () => json({ ...recorded.openai.split,
    answers: [{ type: "choice", name: "q1", choice: "neither of these", confidence: 1, probabilities: [] }] }) });
  const recovered = await outside.ask(["codex"], [option]);
  assert.equal(recovered.rung, "job");
  assert.deepEqual(outside.jobs.map(j => j.runner), ["codex"]);
  assert.deepEqual(recovered.answers, [{ choice: "lite", confidence: 0.99 }]);

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

test("an internal ID is accepted only when its value was offered to the model", async () => {
  const who: VoiceQuestion = { kind: "who", text: "Stevie, run it", candidates: [steve, alice] };
  const option: VoiceQuestion = { kind: "option", text: "the embedded one", prompt: "Which database?",
    options: [{ id: "lite", label: "SQLite", detail: "embedded" }] };
  for (const [question, id, label] of [[who, steve.id, steve.label], [option, "lite", "SQLite"]] as const) {
    for (const choice of [id, label]) {
      const answer = { type: "choice", choice, confidence: 1 };
      const expected = choice === label ? [{ choice: id, confidence: 1 }] : null;
      for (const provider of ["openai", "jev"] as const) {
        const { ask, jobs } = rig({ saved: { [provider]: "fixture-key" },
          job: async () => [{ choice: id, confidence: 0.98 }],
          reply: () => json({ answers: provider === "openai" ? [{ ...answer, name: "q1" }] : { q1: answer } }) });
        const result = await ask(["codex"], [question]);
        assert.equal(result.rung, choice === label ? provider : "job");
        assert.deepEqual(jobs.map(j => j.runner), choice === label ? [] : ["codex"]);
        assert.deepEqual(result.answers, [{ choice: id, confidence: choice === label ? 1 : 0.98 }]);
      }
      assert.deepEqual(parseVoiceRoutingReply({ answers: { q1: answer } }, [question]), expected, "job");
    }
  }
});

for (const provider of ["openai", "jev"] as const) {
  test(`${provider} malformed answers fall through to Luna and explicit uncertainty stops`, async () => {
    for (const answer of [{ type: "choice", choice: "split" }, { type: "choice", choice: "split", confidence: "high" },
      { type: "choice", choice: true, confidence: 1 }, { type: "choice", choice: "split", confidence: 2 },
      { type: "choice", choice: "not sure", confidence: 1 }]) {
      const { ask, jobs } = rig({ saved: { [provider]: "fixture-key" },
        reply: () => json({ answers: provider === "openai" ? [{ ...answer, name: "q1" }] : { q1: answer } }) });
      const result = await ask(["codex"]);
      if (answer.choice === "not sure") {
        assert.equal(result.rung, provider);
        assert.equal(result.answers[0]?.choice, null);
        assert.equal(jobs.length, 0);
      } else {
        assert.equal(result.rung, "job");
        assert.equal(result.answers[0]?.choice, "mention");
        assert.deepEqual(jobs.map(j => j.runner), ["codex"]);
      }
    }
  });

  test(`${provider} sends credentials only to HTTPS or loopback HTTP gateways`, async (t) => {
    const variable = provider === "openai" ? "MISSION_VOICE_OPENAI_DECISIONS_URL" : "MISSION_VOICE_JEV_URL";
    const original = process.env[variable];
    t.after(() => { if (original === undefined) delete process.env[variable]; else process.env[variable] = original; });
    for (const [base, allowed] of [
      ["http://gateway.invalid", false], ["file:///tmp/gateway", false],
      ["https://gateway.invalid?key=value", false], ["https://gateway.invalid#section", false],
      ["https://gateway.invalid", true], ["http://127.0.0.1", true], ["http://[::1]", true],
    ] as const) {
      process.env[variable] = base;
      const { calls, ask } = rig({ saved: { [provider]: "fixture-key" } });
      assert.equal((await ask(["codex"])).rung, allowed ? provider : "job", base);
      assert.equal(calls.length, allowed ? 1 : 0, base);
    }
  });

  test(`${provider} bounds the streamed reply and uses Luna on overflow`, async () => {
    const reply = JSON.stringify(provider === "openai" ? recorded.openai.split : recorded.jev.mention);
    const cap = 256 * 1024;
    for (const extra of [0, 1]) {
      let cancelled = false;
      const atLimit = new TextEncoder().encode(reply.padEnd(cap));
      const chunks = [atLimit.subarray(0, cap / 2), atLimit.subarray(cap / 2)];
      if (extra) chunks.push(Uint8Array.of(32));
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 });
      const { ask, jobs } = rig({ saved: { [provider]: "fixture-key" },
        reply: () => new Response(stream, { headers: { "content-length": "1" } }) });
      assert.equal((await ask(["codex"])).rung, extra ? "job" : provider);
      assert.equal(cancelled, Boolean(extra));
      assert.deepEqual(jobs.map(j => j.runner), extra ? ["codex"] : []);
    }
  });

  test(`${provider} requests reject redirects at the fetch boundary`, async () => {
    const { ask, calls } = rig({ saved: { [provider]: "fixture-key" }, reply: () => { throw new TypeError("redirect refused"); } });
    const result = await ask(["codex"]);
    assert.deepEqual(calls.map(c => c.redirect), ["error"]);
    assert.equal(result.rung, "job");
  });
}

test("OpenAI split answers must name each question in request order", async () => {
  const questions: VoiceQuestion[] = [SPLIT, { ...SPLIT, second: steve }];
  for (const names of [["q1", "q2"], ["q2", "q1"], ["q1", "q1"], ["q1", undefined]]) {
    const answers = names.map((name, i) => ({ name, type: "choice", choice: i ? "split" : "mention", confidence: 1 }));
    const { ask, jobs } = rig({ saved: { openai: "fixture-key" }, reply: () => json({ answers }) });
    const result = await ask(["codex"], questions);
    if (names[0] === "q1" && names[1] === "q2") {
      assert.equal(result.rung, "openai");
      assert.deepEqual(result.answers.map(a => a.choice), ["mention", "split"]);
    } else {
      assert.equal(result.rung, "job");
      assert.deepEqual(jobs.map(j => j.runner), ["codex"]);
    }
  }
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

function routerRig(answer: (...args: Parameters<VoiceDecider["ask"]>) => Promise<VoiceDecisionResult> | VoiceDecisionResult,
  roster = ["Steve", "Alice", "Will"].map((n) => name(n))) {
  const cards: VoiceCard[] = [];
  const delivered: [string, string, string][] = [];
  const asked: VoiceQuestion[][] = [];
  const decider: VoiceDecider = { ask: async (questions, options) => { asked.push([...questions]); return answer(questions, options); } };
  const router = new VoiceRouter(
    () => ({ mode: "listening", roster, backend: "fluidaudio" }),
    () => ({ enabled: true, seconds: 4 }),
    { deliver: async (target, text, id) => { delivered.push([target.name, text, id]); return "queued"; } },
    (card) => cards.push(structuredClone(card)),
    decider,
  );
  const say = async (text: string, id: string = crypto.randomUUID()) => {
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
  assert.equal(new Set(asked[0]?.map(q => voiceQuestionInstructions(q))).size, 2);
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
  t.mock.timers.enable({ apis: ["Date"], now: 100 });
  const { router, delivered, say } = routerRig(() => answered(null));
  t.after(() => router.reset());
  await say("Steve, ask Alice about the build", "one");
  assert.equal(await router.pick("one", "task:Steve"), true);
  await router.sendNow("one");
  assert.deepEqual(delivered, [["Steve", "ask Alice about the build", "one"]]);
  t.mock.timers.setTime(101);
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

test("a later duplicate name leaves an earlier split available and stays unsure after a mention", async (t) => {
  const ruby = name("Ruby");
  const roster = [name("Steve"), name("Alice"), ruby, { ...ruby, key: "other-ruby", sessionId: "s:other-ruby" }];
  for (const choice of ["split", "mention"]) {
    const { router, asked, cards, delivered, say } = routerRig(() => answered(choice), roster);
    t.after(() => router.reset());
    await say("Steve, check the build, and Alice, ask Ruby about the tests", choice);
    assert.deepEqual(asked.map(batch => batch.map(q => q.kind === "split" && q.second.label)), [["Alice"]]);
    if (choice === "split") {
      assert.equal(await router.sendNow(choice), true);
      assert.deepEqual(delivered, [["Steve", "check the build", choice], ["Alice", "ask Ruby about the tests", choice + "#2"]]);
    } else {
      assert.equal(cards.at(-1)?.state, "unsure");
      assert.equal(cards.at(-1)?.candidates.filter(c => c.title === "Ruby").length, 2);
      assert.equal(await router.sendNow(choice), false);
    }
  }
});

for (const action of ["cancel", "voice off"]) {
  test(`${action} aborts the resolving provider and prevents fallback after a late failure`, async (t) => {
    let onStart!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>(resolve => { onStart = resolve; });
    let fail!: (error: Error) => void;
    const pending = new Promise<Response>((_, reject) => { fail = reject; });
    const { decider, jobs } = rig({ saved: { openai: "fixture-key" },
      reply: (_call, signal) => { onStart(signal); return pending; } });
    const { router, delivered } = routerRig(decider.ask, [name("Steve", "codex"), name("Alice", "codex")]);
    t.after(() => router.reset());
    await router.accept(VoiceUtteranceSchema.parse({ id: "pending", text: SPLIT.text, capturedAt: Date.now(), backend: "fluidaudio" }));
    const resolution = router.resolution("pending");
    const signal = await started;
    if (action === "cancel") assert.equal(router.cancel("pending"), true);
    else router.clearActionsAndHistory();
    fail(new Error("fixture provider stopped"));
    await resolution;
    assert.equal(signal.aborted, true);
    assert.deepEqual(jobs, []);
    assert.deepEqual(delivered, []);
    assert.deepEqual(router.activeCards(), []);
  });
}

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
  const router = new VoiceRouter(() => ({ mode: "listening", roster, backend: "fluidaudio" }), () => ({ enabled: true, seconds: 4 }),
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
  assert.deepEqual(router.activeCards(), []);
  assert.equal(cards.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(cards.map((c) => c.state), ["resolving"]);
  assert.deepEqual(router.activeCards(), cards);
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

for (const choice of ["split", null]) {
  test(`model completion preserves cancel order when it becomes ${choice ? "pending" : "unsure"}`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 100 });
    let finish!: (result: VoiceDecisionResult) => void;
    const { router, cards, delivered } = routerRig(() => new Promise(resolve => { finish = resolve; }));
    t.after(() => router.reset());
    const accept = (id: string, text: string, capturedAt: number) => router.accept(VoiceUtteranceSchema.parse({
      id, text, capturedAt, backend: "fluidaudio",
    }));
    await accept("older", SPLIT.text, 101);
    const original = router.pendingVoiceActions[0];
    assert.equal(original?.openedAt, 101);
    await accept("newer", "Will, check the queue", 102);
    finish(answered(choice));
    await router.resolution("older");
    assert.equal(cards.at(-1)?.state, choice ? "pending" : "unsure");
    await accept("cancel", "cancel", 103);
    assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["newer", "cancelled"]);
    assert.equal(router.pendingVoiceActions[0], original);
    assert.equal(await router.sendNow("newer"), false);
    assert.deepEqual(delivered, []);
  });
}

for (const replaced of ["Steve", "Alice"]) {
  test(`a manual split pick stays unsure if ${replaced}'s captured session was replaced`, async (t) => {
    const roster = [name("Steve"), name("Alice")];
    const { router, delivered, say } = routerRig(() => answered(null), roster);
    t.after(() => router.reset());
    await say(SPLIT.text, "pick");
    const target = roster.find(agent => agent.name === replaced)!;
    const original = target.sessionId;
    target.sessionId = "replacement";
    assert.equal(await router.pick("pick", "task:Alice"), false);
    assert.equal(router.activeCards()[0]?.state, "unsure");
    assert.equal(await router.sendNow("pick"), false);
    assert.deepEqual(delivered, []);
    target.sessionId = original;
    assert.equal(await router.pick("pick", "task:Alice"), true);
    assert.equal(await router.sendNow("pick"), true);
    assert.deepEqual(delivered, [["Steve", "check the build", "pick"], ["Alice", "review the PR", "pick#2"]]);
  });
}

test("a partial job batch cannot return an actionable split", () => {
  const first = { choice: "split", confidence: 1 };
  for (const answers of [{ q1: first }, { q1: first, q3: first }, { q1: first, q2: { choice: "mention" } }, { q1: first, q2: { choice: "absent", confidence: 1 } }]) {
    assert.equal(parseVoiceRoutingReply({ answers }, [SPLIT, SPLIT]), null);
  }
});

test("generated wire labels avoid reserved and already numbered options", () => {
  const labels = ["Review", "Review", "Review (1)", "not sure", "not sure (4)"];
  const options = labels.map((label, i) => ({ label, id: String(i), detail: "" }));
  const question: VoiceQuestion = { kind: "option", options, text: "first", prompt: "Which?" };
  const values = voiceChoiceValues(question);
  assert.equal(new Set([...values.map(v => v.value), "not sure"]).size, 6);
  for (const v of values) assert.equal(parseVoiceRoutingReply({ answers: { q1: {choice: v.value, confidence: 1} } }, [question])?.[0]?.choice, v.id);
});

test("runner diagnostics stay out of voice history", async () => {
  const { ask } = rig({ job: async () => { throw new Error("private runner path and payload"); } });
  assert.equal((await ask(["codex"])).detail, "job on codex failed");
});

test("a repeated transcript appears once in a job or provider batch", async () => {
  const q = { ...SPLIT, text: "unique transcript for multiple boundaries" };
  for (const provider of ["openai", "jev"] as const) {
    const { ask, calls } = rig({ saved: { [provider]: "test-key" } });
    await ask(["codex"], [q, q]);
    assert.equal(JSON.stringify(calls[0]?.body).split(q.text).length, 2);
  }
  assert.equal(buildVoiceRoutingPrompt([q, q]).split(q.text).length, 2);
});

test("each provider associates a mixed batch's questions with their own transcripts", async () => {
  const first = { ...SPLIT, text: "Steve, check the issue and Alice, triage it" };
  const second = { ...SPLIT, text: "Steve, ask Alice about the report" };
  for (const provider of ["openai", "jev"] as const) {
    const { ask, calls } = rig({ saved: { [provider]: "test-key" } });
    await ask(["codex"], [first, second, first]);
    const speech = String(calls[0]!.body[provider === "openai" ? "input" : "state"]);
    const lines = speech.split("\n");
    assert.deepEqual(lines.filter(line => line.includes(first.text)).map(line => line.match(/q\d+/gu)), [["q1", "q3"]]);
    assert.deepEqual(lines.filter(line => line.includes(second.text)).map(line => line.match(/q\d+/gu)), [["q2"]]);
  }
});

test("an over-limit sentence keeps all manual split points without asking a model", async (t) => {
  const { router, asked, cards, say } = routerRig(() => answered("split"));
  t.after(() => router.reset());
  await say("Steve, ask " + "Alice about it and ".repeat(10) + "Alice, review the PR", "long");
  assert.equal(asked.length, 0);
  assert.equal(cards.at(-1)?.candidates.length, 12);
});

test("excluded duplicate-name candidates cannot change a Codex split to a mixed roster", async (t) => {
  const ruby = name("Ruby");
  const { router, say, cards } = routerRig((_q, opts) => {
    assert.deepEqual(opts?.agents, ["codex", "codex"]);
    return answered("split");
  }, [name("Steve", "codex"), name("Alice", "codex"), ruby, { ...ruby, key: "other-ruby" }]);
  t.after(() => router.reset());
  await say("Steve, check the build, and Alice, ask Ruby about the tests");
  assert.equal(cards.at(-1)?.reason, "split");
});

test("a resolving card suppresses a spoken pick that could match two captures", async (t) => {
  let finish!: (result: VoiceDecisionResult) => void;
  const pending = new Promise<VoiceDecisionResult>(resolve => { finish = resolve; });
  let calls = 0;
  const { router, say, cards } = routerRig(() => ++calls === 1 ? answered(null) : pending);
  t.after(() => router.reset());
  await say(SPLIT.text, "older");
  await router.accept(VoiceUtteranceSchema.parse({ id: "newer", text: SPLIT.text, capturedAt: Date.now(), backend: "fluidaudio" }));
  await say("Alice", "pick");
  finish(answered(null));
  await router.resolution("newer");
  assert.equal(router.heard.list().find(e => e.id === "pick")?.rule, "ambiguous-pick");
  assert.deepEqual(cards.map(c => c.state), ["unsure", "unsure"]);
});

test("a phonetic first choice and a later split share one deadline, including manual choices", async (t) => {
  for (const manual of [false, true]) {
    const deadlines: (number | undefined)[] = [];
    const { router, say, asked, delivered } = routerRig((questions, opts) => {
      deadlines.push(opts?.deadline);
      return answered(manual ? null : questions[0]?.kind === "who" ? "task:Steve" : "split");
    }, ["Steve", "Stevie", "Alice"].map(n => name(n, "codex")));
    t.after(() => router.reset());
    await say("Steven, check the build, and Alice, review the PR", "compound");
    if (manual) {
      assert.ok(await router.pick("compound", "task:Steve"));
      assert.equal(await router.sendNow("compound"), false);
      assert.equal(await router.pick("compound", "task:Steve"), false);
      const split = router.activeCards()[0]?.candidates.find(candidate => candidate.title === "Alice");
      assert.ok(split);
      assert.ok(await router.pick("compound", split.id));
    } else {
      assert.deepEqual(asked.map(q => q[0]?.kind), ["who", "split"]);
      assert.equal(typeof deadlines[0], "number");
      assert.equal(deadlines[0], deadlines[1]);
    }
    assert.ok(await router.sendNow("compound"));
    assert.deepEqual(delivered, [["Steve", "check the build", "compound"], ["Alice", "review the PR", "compound#2"]]);
  }
});

test("a retried first pick leaves the whole-message choice available", async (t) => {
  const { router, say, delivered } = routerRig(() => answered(null), ["Steve", "Stevie", "Alice"].map(n => name(n)));
  t.after(() => router.reset());
  await say("Steven, close the release, and Alice, update the docs", "choice");
  assert.ok(await router.pick("choice", "task:Steve"));
  const rows = router.activeCards()[0]!.candidates;
  assert.equal(await router.pick("choice", "task:Steve"), false);
  assert.deepEqual(router.activeCards()[0]?.candidates, rows);
  assert.ok(await router.pick("choice", rows.find(row => row.title === "Steve")!.id));
  assert.ok(await router.sendNow("choice"));
  assert.deepEqual(delivered, [["Steve", "close the release, and Alice, update the docs", "choice"]]);
});

test("a late split boundary retains its surrounding speech in the job request", async (t) => {
  const { router, say, asked } = routerRig(() => answered(null));
  t.after(() => router.reset());
  const text = "Steve, " + "check the build notes ".repeat(105) + "then ask Alice about the changelog";
  await say(text, "long");
  assert.equal(asked.length, 1);
  assert.ok(buildVoiceRoutingPrompt(asked[0]!).includes("then ask Alice about the changelog"));
});

test("an errored provider body cannot replace its sanitized HTTP status", async () => {
  const { ask, jobs } = rig({ env: { OPENAI_API_KEY: OPENAI_ENV }, reply: () =>
    new Response(new ReadableStream({ start(controller) { controller.error(new Error("private gateway diagnostic")); } }), { status: 401 }) });
  const result = await ask(["codex"]);
  assert.equal(result.rung, "job");
  assert.equal(jobs.length, 1);
  assert.match(result.detail, /OpenAI Decisions HTTP 401/);
  assert.doesNotMatch(result.detail, /private gateway diagnostic/);
});

for (const change of ["not-running", "unavailable"] as const) {
  test(`a later split part is withheld when its target becomes ${change} during the first delivery`, async (t) => {
    const roster = [name("Steve"), name("Alice")];
    const calls: string[] = [];
    let available = true;
    const router = new VoiceRouter(() => ({ mode: "listening", roster, backend: "fluidaudio" }),
      () => ({ enabled: true, seconds: 4 }), {
        available: () => available,
        deliver: async target => {
          calls.push(target.name);
          if (change === "unavailable") available = false;
          else roster[1]!.state = "not-running";
          return "queued";
        },
      }, () => {}, { ask: async () => answered("split") });
    t.after(() => router.reset());
    await router.accept(VoiceUtteranceSchema.parse({ text: SPLIT.text, id: "part", capturedAt: Date.now(), backend: "fluidaudio" }));
    await router.resolution("part");
    assert.ok(await router.sendNow("part"));
    assert.deepEqual(calls, ["Steve"]);
    assert.equal(router.heard.list()[0]?.outcome, "not-running");
  });
}

test("a spoken split pick must follow the change of candidate rows", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100 });
  const { router, say, delivered } = routerRig(() => answered(null), ["Steve", "Stevie", "Alice"].map(n => name(n)));
  t.after(() => router.reset());
  await say("Steven, check the build, and Alice, review the PR", "stages");
  t.mock.timers.setTime(200);
  assert.ok(await router.pick("stages", "task:Steve"));
  const sayAt = (id: string, capturedAt: number) => router.accept(VoiceUtteranceSchema.parse({
    id, text: "Alice", backend: "fluidaudio", capturedAt,
  }));
  await sayAt("early", 150);
  assert.equal(router.activeCards()[0]?.state, "unsure");
  assert.equal(await router.sendNow("stages"), false);
  await sayAt("current", 200);
  assert.ok(await router.sendNow("stages"));
  assert.deepEqual(delivered, [["Steve", "check the build", "stages"], ["Alice", "review the PR", "stages#2"]]);
});

test("confirming a comma-only split preserves literal C plus plus", async (t) => {
  const { router, say, delivered } = routerRig(() => answered(null));
  t.after(() => router.reset());
  await say("Steve, explain C plus plus, Alice, review the PR", "literal");
  assert.ok(await router.pick("literal", "task:Alice"));
  assert.ok(await router.sendNow("literal"));
  assert.deepEqual(delivered, [["Steve", "explain C plus plus", "literal"], ["Alice", "review the PR", "literal#2"]]);
});

test("a spoken boundary choice waits for the model's follow-up rows", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100 });
  let showRows!: (result: VoiceDecisionResult) => void;
  const result = new Promise<VoiceDecisionResult>(resolve => { showRows = resolve; });
  let onBoundary!: () => void;
  const boundary = new Promise<void>(resolve => { onBoundary = resolve; });
  const { router, delivered } = routerRig(questions => {
    if (questions[0]?.kind === "who") return answered("task:Steve");
    onBoundary();
    return result;
  }, ["Steve", "Stevie", "Alice"].map(n => name(n)));
  t.after(() => router.reset());
  const capture = (id: string, text: string, capturedAt: number) => router.accept(VoiceUtteranceSchema.parse({
    id, text, backend: "fluidaudio", capturedAt,
  }));
  await capture("model", "Steven, check the build, and Alice, review the PR", 100);
  await boundary;
  t.mock.timers.setTime(200);
  showRows(answered(null));
  await router.resolution("model");
  await capture("early", "Alice", 150);
  assert.equal(router.activeCards()[0]?.state, "unsure");
  await capture("current", "Alice", 200);
  assert.ok(await router.sendNow("model"));
  assert.deepEqual(delivered, [["Steve", "check the build", "model"], ["Alice", "review the PR", "model#2"]]);
});

test("job discovery cannot launch after the shared model deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100 });
  let start!: () => void;
  let finishDiscovery!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const discovery = new Promise<void>(resolve => { finishDiscovery = resolve; });
  let launches = 0;
  let jobSignal: AbortSignal | undefined;
  const { ask } = rig({ now: Date.now, deadlineMs: 100, job: async (_runner, _budget, signal) => {
    jobSignal = signal;
    start();
    await discovery;
    signal?.throwIfAborted();
    launches++;
    return [{ choice: "split", confidence: 1 }];
  } });
  const pending = ask(["codex"]);
  await started;
  t.mock.timers.tick(100);
  const result = await pending;
  finishDiscovery();
  await Promise.resolve();
  assert.equal(result.rung, "none");
  assert.deepEqual(result.answers, [{ choice: null, confidence: 0 }]);
  assert.equal(launches, 0);
  assert.equal(jobSignal?.aborted, true);
});

test("a split removes a comma-delimited connector and preserves the text before it", async (t) => {
  const { router, say, delivered } = routerRig(() => answered("split"));
  t.after(() => router.reset());
  await say("Steve, explain C plus plus, and then, Alice, review the PR", "connector");
  assert.ok(await router.sendNow("connector"));
  assert.deepEqual(delivered, [["Steve", "explain C plus plus", "connector"], ["Alice", "review the PR", "connector#2"]]);
});

test("speech captured during initial resolution cannot confirm newly offered choices", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100 });
  for (const [text, target] of [[SPLIT.text, "Alice"], ["Steven, check the build", "Steve"]] as const) {
    t.mock.timers.setTime(100);
    let finish!: (result: VoiceDecisionResult) => void;
    const pending = new Promise<VoiceDecisionResult>(resolve => { finish = resolve; });
    const { router } = routerRig(() => pending, ["Steve", "Stevie", "Alice"].map(n => name(n)));
    t.after(() => router.reset());
    const capture = (id: string, speech: string, capturedAt: number) => router.accept(VoiceUtteranceSchema.parse({
      id, text: speech, backend: "fluidaudio", capturedAt,
    }));
    await capture("initial", text, 100);
    t.mock.timers.setTime(200);
    finish(answered(null));
    await router.resolution("initial");
    await capture("early", target, 150);
    assert.equal(router.activeCards()[0]?.state, "unsure");
    await capture("current", target, 200);
    assert.equal(router.activeCards()[0]?.state, "pending");
  }
});

for (const later of ["resolving", "unsure", "pending", "cancelled"] as const) {
  test(`the same captured name cannot select the older card after the newer card becomes ${later}`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 100 });
    let finish!: (result: VoiceDecisionResult) => void;
    const pending = new Promise<VoiceDecisionResult>(resolve => { finish = resolve; });
    let calls = 0;
    const { router, say, delivered } = routerRig(() => ++calls === 1 ? answered(null) : pending);
    t.after(() => router.reset());
    await say(SPLIT.text, "older");
    const capture = (id: string, text: string, capturedAt: number) => router.accept(VoiceUtteranceSchema.parse({
      id, text, backend: "fluidaudio", capturedAt,
    }));
    t.mock.timers.setTime(200);
    await capture("newer", SPLIT.text, 200);
    t.mock.timers.setTime(300);
    if (later === "cancelled") router.cancel("newer");
    if (later !== "resolving") {
      finish(answered(later === "pending" ? "mention" : null));
      await router.resolution("newer");
    }
    await capture("late-name", "Alice", 250);
    finish(answered(null));
    await router.resolution("newer");
    assert.equal(router.heard.list().find(e => e.id === "late-name")?.rule, "ambiguous-pick");
    assert.equal(await router.sendNow("older"), false);
    assert.deepEqual(delivered, []);
  });
}

for (const closedAt of [200, 300]) {
  test(`a pick captured when a competing card closes at ${closedAt} stays ambiguous`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 100 });
    const { router, say } = routerRig(() => answered(null));
    t.after(() => router.reset());
    await say(SPLIT.text, "older");
    t.mock.timers.setTime(200);
    await say(SPLIT.text, "newer");
    t.mock.timers.setTime(closedAt);
    assert.ok(router.cancel("newer"));
    t.mock.timers.setTime(closedAt + 1);
    await router.accept(VoiceUtteranceSchema.parse({ id: "tie", text: "Alice", backend: "fluidaudio", capturedAt: closedAt }));
    assert.equal(router.activeCards()[0]?.state, "unsure");
    assert.equal(router.heard.list().find(e => e.id === "tie")?.rule, "ambiguous-pick");
    await say("Alice", "after");
    assert.equal(router.activeCards()[0]?.state, "pending");
  });
}

test("a comma-free split preserves the literal word before the next name", async (t) => {
  const { router, say, delivered } = routerRig(() => answered(null));
  t.after(() => router.reset());
  for (const first of ["explain C plus plus", "explain the word then", "define also", "spell and"]) {
    const id = String(delivered.length);
    await say(`Steve, ${first} Alice, review the PR`, id);
    assert.ok(await router.pick(id, "task:Alice"));
    assert.ok(await router.sendNow(id));
    assert.deepEqual(delivered.slice(-2), [["Steve", first, id], ["Alice", "review the PR", id + "#2"]]);
  }
});

test("a pick older than the retained choice history abstains while a fresh pick works", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100 });
  const { router, say } = routerRig(() => answered(null));
  t.after(() => router.reset());
  await say(SPLIT.text, "open");
  for (let i = 0; i <= 50; i++) {
    t.mock.timers.setTime(200 + 2 * i);
    await say("Will, check the issue with Steve about the queue", "other-" + i);
    t.mock.timers.setTime(201 + 2 * i);
    assert.ok(router.cancel("other-" + i));
  }
  await router.accept(VoiceUtteranceSchema.parse({ id: "old", text: "Alice", backend: "fluidaudio", capturedAt: 150 }));
  assert.equal(router.activeCards()[0]?.state, "unsure");
  await say("Alice", "fresh");
  assert.equal(router.activeCards()[0]?.state, "pending");
});

test("a confirmed split removes one conjunction before the address and preserves literal words", async (t) => {
  const { router, say, delivered } = routerRig(() => answered("split"));
  t.after(() => router.reset());
  for (const [spoken, expected] of [
    ["check the build and", "check the build"], ["check the build and then", "check the build"],
    ["check the build then", "check the build"], ["spell then", "spell then"],
    ["spell and", "spell and"], ["explain the word and", "explain the word and"],
    ["spell the word: and", "spell the word: and"], ["say, then", "say, then"],
    ["define the term: plus", "define the term: plus"],
    ["replace foo with then", "replace foo with then"], ["rename foo to and", "rename foo to and"],
  ]) {
    for (const separator of [" ", ", ", ",", " , "]) {
      const id = String(delivered.length);
      await say(`Steve, ${spoken}${separator}Alice, review the PR`, id);
      assert.ok(await router.sendNow(id));
      assert.deepEqual(delivered.slice(-2), [["Steve", expected, id], ["Alice", "review the PR", id + "#2"]]);
    }
  }
});

test("the resolving event and reconnect snapshot agree while the second model call is pending", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let chooseFirst!: (result: VoiceDecisionResult) => void;
  let chooseSplit!: (result: VoiceDecisionResult) => void;
  let startSecond!: () => void;
  const first = new Promise<VoiceDecisionResult>(resolve => { chooseFirst = resolve; });
  const split = new Promise<VoiceDecisionResult>(resolve => { chooseSplit = resolve; });
  const started = new Promise<void>(resolve => { startSecond = resolve; });
  const { router, cards } = routerRig(questions => {
    if (questions[0]?.kind === "who") return first;
    startSecond();
    return split;
  }, ["Steve", "Stevie", "Alice"].map(n => name(n)));
  t.after(() => router.reset());
  await router.accept(VoiceUtteranceSchema.parse({ id: "visible", text: "Steven, check the build, and Alice, review the PR",
    backend: "fluidaudio", capturedAt: Date.now() }));
  t.mock.timers.tick(1000);
  assert.equal(cards.at(-1)?.parts[0]?.target, null);
  const original = router.activeCards()[0]!;
  chooseFirst(answered("task:Steve"));
  await started;
  try {
    const latest = cards.at(-1)!;
    assert.equal(latest.state, "resolving");
    assert.equal(latest.reason, "second-name");
    assert.equal(latest.parts[0]?.target?.name, "Steve");
    assert.deepEqual(latest.candidates.map(c => c.title), ["Steve", "Alice"]);
    assert.deepEqual(router.activeCards(), [latest]);
    assert.equal(original.parts[0]?.target, null);
  } finally {
    chooseSplit(answered(null));
    await router.resolution("visible");
  }
  assert.equal(cards.at(-1)?.state, "unsure");
  assert.equal(cards.at(-1)?.reason, "second-name");
  assert.deepEqual(router.activeCards(), [cards.at(-1)]);
});

test("a split consumes comma-adjacent wrappers around the second address", async (t) => {
  const { router, say, delivered } = routerRig(() => answered("split"));
  t.after(() => router.reset());
  for (const address of ["“Alice,”", "“ Alice,”", "「 “ Alice,” 」"]) {
    const id = String(delivered.length);
    await say(`Steve, check the build,${address} review the PR`, id);
    assert.ok(await router.sendNow(id));
    assert.deepEqual(delivered.slice(-2), [["Steve", "check the build", id], ["Alice", "review the PR", id + "#2"]], address);
  }
});

test("a manual split preserves a detached closing quote from the first command", async (t) => {
  const { router, say, delivered } = routerRig(() => answered(null));
  t.after(() => router.reset());
  for (const first of ['type "hello "', "type 'hello '", "type 'don't stop '"]) {
    const id = String(delivered.length);
    await say(`Steve, ${first} Alice, review the PR`, id);
    assert.ok(await router.pick(id, "task:Alice"));
    assert.ok(await router.sendNow(id));
    assert.deepEqual(delivered.slice(-2), [["Steve", first, id], ["Alice", "review the PR", id + "#2"]]);
  }
});
