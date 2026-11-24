// The Phase 4 retest of the voice-routing job rung: a manual evaluation, never a unit test.
//
//   node --import tsx scripts/voice-spike/routing-retest.ts --yes [--cases <file>] [--runner claude|codex] [--label <name>]
//   With the Claude runner, --transport sdk|print selects the protocol to measure.
//   node --import tsx scripts/voice-spike/routing-retest.ts --summarize <label> [<label> ...]
//
// It spends the operator's own provider usage, through the operator's own `claude` (or `codex`)
// login, so it refuses to run without `--yes`. Each case is one call of `runVoiceRoutingJob`, the
// function the daemon calls: the same prompt, system prompt, response schema, thinking off,
// tools disabled, the runner's default transport and one attempt. Expected answers and category
// labels are never sent. The model sees only the question the product would ask.
//
// The daemon modules are imported under a throwaway `MISSION_HOME` in the OS temp directory, so
// nothing the run touches is the operator's real state. Results append to
// `.tmp/voice-spike/retest-<label>.jsonl` (ignored by Git).
//
// `routing-tuning.json` (the spike's cases, recast) is the tuning set. `routing-holdout.json` was
// written before any tuning run and is the only pass evidence.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireHelperLock, realHelperLockOperations, releaseHelperLock } from "../update-lock.mjs";
import type { VoiceQuestion } from "../../src/shared/voice-decide.ts";
import type { ClaudeTransport, CodexTransport } from "../../src/shared/llm.ts";

interface CorpusCase {
  id: string;
  category: string;
  question:
    | { kind: "who"; text: string; candidates: string[] }
    | { kind: "split"; text: string; first: string; second: string; nameOffset: number }
    | { kind: "option"; text: string; card: string };
  expected: string;
}
interface Corpus {
  roster: Record<string, string>;
  cards: Record<string, { prompt: string; options: { label: string; detail: string }[] }>;
  cases: CorpusCase[];
}
interface Row {
  id: string;
  category: string;
  expected: string;
  choice: string | null;
  confidence: number;
  /** Whether the choice is one of the question's own: an answer outside them is never accepted. */
  member: boolean;
  ms: number;
  error: string | null;
  runner: string;
  /** Resolved Voice job model ID. Historical rows did not record it. */
  model?: string;
  /** Digest of the input corpus file. Historical rows have no recorded identity. */
  corpusSha256?: string;
  /** Digest of the system prompt and every corpus case's rendered user prompt and response schema. */
  promptSchemaSha256?: string;
  /** Occurrence identified in the split prompt. Historical runs omitted it. */
  nameOffset?: number;
  /** Absent on results written before transport was recorded. */
  transport?: ClaudeTransport | CodexTransport;
}

const OUT = resolve(".tmp/voice-spike");
const DEADLINE_MS = 5_000;
const FLOORS = [0.5, 0.8, 0.9, 0.95, 0.98, 0.99, 1];
const CATEGORIES = ["plain", "phonetic", "split", "mention", "option"];
const NOT_SURE = "not sure";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

function rangeArgument(name: string, fallback: number, minimum: number): number {
  if (!args.includes(name)) return fallback;
  const raw = flag(name) ?? "";
  const value = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} requires an integer of at least ${minimum}.`);
  }
  return value;
}

function toQuestion(corpus: Corpus, row: CorpusCase): VoiceQuestion {
  const agent = (name: string) => ({ id: name, label: name, detail: corpus.roster[name] ?? "" });
  const q = row.question;
  if (q.kind === "who") return { kind: "who", text: q.text, candidates: q.candidates.map(agent) };
  if (q.kind === "split") {
    if (!Number.isInteger(q.nameOffset) || q.nameOffset <= 0 || !q.text.startsWith(q.second, q.nameOffset)
      || /[\p{L}\p{M}\p{N}]$/u.test(q.text.slice(0, q.nameOffset))
      || /^[\p{L}\p{M}\p{N}]/u.test(q.text.slice(q.nameOffset + q.second.length))) {
      throw new Error(`Case ${row.id}: nameOffset must point to the specified later name.`);
    }
    return { kind: "split", text: q.text, first: agent(q.first), second: agent(q.second), nameOffset: q.nameOffset };
  }
  const card = corpus.cards[q.card]!;
  return { kind: "option", text: q.text, prompt: card.prompt, options: card.options.map((o) => ({ id: o.label, label: o.label, detail: o.detail })) };
}

function quantile(values: number[], p: number): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * p) - 1] ?? null;
}

function readRows(path: string): Row[] {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
}

function checkRun(rows: Pick<Row, "id" | "runner" | "model" | "transport" | "corpusSha256" | "promptSchemaSha256">[]): void {
  if (new Set(rows.map(row => row.corpusSha256)).size > 1) {
    throw new Error("Mixed corpora: choose a separate label for each corpus.");
  }
  if (new Set(rows.map(row => row.promptSchemaSha256)).size > 1) {
    throw new Error("Mixed prompt and schema revisions: choose a fresh run label.");
  }
  if (new Set(rows.map((r) => r.id)).size !== rows.length) {
    throw new Error("Repeated case IDs: choose a fresh run label or summarize a single pass.");
  }
  if (new Set(rows.map(row => row.runner)).size > 1) throw new Error("Mixed runners: use a separate label for each runner.");
  if (new Set(rows.map(row => row.model)).size > 1) throw new Error("Mixed model IDs: use a separate label for each model.");
  const transports = new Set(rows.map(row => row.transport ?? "unrecorded"));
  if (transports.size > 1) throw new Error("Mixed transports: use a separate label for each transport.");
}

function summarize(label: string): void {
  const path = join(OUT, `retest-${label}.jsonl`);
  if (!existsSync(path)) throw new Error(`no results at ${path}`);
  const rows = readRows(path);
  checkRun(rows);
  const latencies = rows.map((r) => r.ms);
  const accepted = (r: Row, floor: number) => r.error === null && r.choice !== null && r.member && r.confidence >= floor;
  const byFloor = FLOORS.map((floor) => {
    const per = CATEGORIES.map((category) => {
      const cat = rows.filter((r) => r.category === category);
      const acc = cat.filter((r) => accepted(r, floor));
      return { category, n: cat.length, accepted: acc.length, acceptedBeforeDeadline: acc.filter((r) => r.ms < DEADLINE_MS).length, wrong: acc.filter((r) => r.choice !== r.expected).length };
    });
    const acc = rows.filter((r) => accepted(r, floor));
    return {
      floor,
      accepted: acc.length,
      wrong: acc.filter((r) => r.choice !== r.expected).length,
      abstained: rows.length - acc.length,
      abstainExpected: rows.filter((r) => r.expected === NOT_SURE).length,
      perCategory: per,
    };
  });
  const failures = rows.filter((r) => r.error !== null || (r.choice ?? NOT_SURE) !== r.expected)
    .map((r) => ({ id: r.id, expected: r.expected, choice: r.choice ?? NOT_SURE, confidence: r.confidence, error: r.error }));
  console.log(JSON.stringify({
    label,
    n: rows.length,
    runner: [...new Set(rows.map((r) => r.runner))],
    model: rows[0]?.model ?? "unrecorded",
    transport: rows[0]?.transport ?? "unrecorded",
    corpusSha256: rows[0]?.corpusSha256 ?? "unrecorded",
    promptSchemaSha256: rows[0]?.promptSchemaSha256 ?? "unrecorded",
    errors: rows.filter((r) => r.error !== null).length,
    overDeadline: rows.filter((r) => r.ms >= DEADLINE_MS).length,
    p50Ms: quantile(latencies, 0.5),
    p95Ms: quantile(latencies, 0.95),
    maxMs: quantile(latencies, 1),
    byFloor,
    failures,
  }, null, 1));
}

async function run(): Promise<void> {
  if (!args.includes("--yes")) {
    console.error("This spends provider usage through your own CLI login. Re-run with --yes.");
    process.exit(2);
  }
  const runner = flag("--runner") ?? "claude";
  if (runner !== "claude" && runner !== "codex") throw new Error("Use --runner claude or codex.");
  const casesPath = flag("--cases") ?? "scripts/voice-spike/routing-holdout.json";
  const label = flag("--label") ?? `${runner}-${casesPath.includes("tuning") ? "tuning" : "holdout"}`;
  const lockDir = join(OUT, `retest-${label}.lock.d`);
  const ops = realHelperLockOperations();
  const claim = acquireHelperLock(lockDir, ops);
  if (!claim.ok || !claim.entryName) throw new Error(`Retest label ${label} is already in use.`);
  try {
    const home = mkdtempSync(join(tmpdir(), "voice-retest-"));
    process.env.MISSION_HOME = home;
    try {
      await runCorpus(runner, casesPath, label);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  } finally {
    releaseHelperLock(lockDir, claim.entryName, ops);
  }
}

async function runCorpus(runner: "claude" | "codex", casesPath: string, label: string): Promise<void> {
  const { runVoiceRoutingJob } = await import("../../src/server/voice/decide.ts");
  const { llmJobModel } = await import("../../src/server/llm/config.ts");
  const { buildVoiceRoutingPrompt, VOICE_ROUTING_SYSTEM_PROMPT, voiceRoutingSchema } = await import("../../src/server/voice/decide-prompt.ts");
  const { DEFAULT_CLAUDE_TRANSPORT, DEFAULT_CODEX_TRANSPORT } = await import("../../src/shared/llm.ts");
  const requested = flag("--transport");
  let transport: ClaudeTransport | CodexTransport = DEFAULT_CODEX_TRANSPORT;
  if (runner === "claude") {
    const selected = requested ?? DEFAULT_CLAUDE_TRANSPORT;
    if (selected !== "sdk" && selected !== "print") throw new Error("Use --transport sdk or print with Claude.");
    const { configureClaudeRunnerTransport } = await import("../../src/server/llm/claude.ts");
    configureClaudeRunnerTransport(() => selected);
    transport = selected;
  } else if (requested !== undefined) {
    throw new Error("--transport selects a Claude transport. Omit it for Codex.");
  }
  const { voiceQuestionChoices } = await import("../../src/shared/voice-decide.ts");
  const input = readFileSync(casesPath);
  const corpusSha256 = createHash("sha256").update(input).digest("hex");
  const corpus = JSON.parse(input.toString("utf8")) as Corpus;
  const start = rangeArgument("--start", 0, 0);
  const limit = rangeArgument("--limit", corpus.cases.length, 1);
  if (start >= corpus.cases.length) throw new Error(`--start ${start} selects no cases from a corpus of ${corpus.cases.length}.`);
  mkdirSync(OUT, { recursive: true });
  const dest = join(OUT, `retest-${label}.jsonl`);
  const cases = corpus.cases.map(row => ({ row, question: toQuestion(corpus, row) }));
  // Include every case so two slices of the same run have the same revision.
  const digest = createHash("sha256").update(JSON.stringify(VOICE_ROUTING_SYSTEM_PROMPT));
  for (const { question } of cases) {
    digest.update(JSON.stringify([buildVoiceRoutingPrompt([question]), voiceRoutingSchema([question])]));
  }
  const model = llmJobModel("voice-routing", undefined, runner).id;
  const runIdentity = { runner, model, transport, corpusSha256, promptSchemaSha256: digest.digest("hex") };
  const selected = cases.slice(start, start + limit);
  checkRun([...(existsSync(dest) ? readRows(dest) : []), ...selected.map(({ row }) => ({ id: row.id, ...runIdentity }))]);
  for (const { row, question } of selected) {
    const began = performance.now();
    let choice: string | null = null;
    let confidence = 0;
    let error: string | null = null;
    try {
      // A 30 second watchdog, not the product budget: the point is to measure how long a call
      // takes, and a call over the five-second budget is counted against the pass bar.
      const [answer] = await runVoiceRoutingJob([question], { runner, timeoutMs: 30_000 });
      choice = answer?.choice ?? null;
      confidence = answer?.confidence ?? 0;
    } catch (caught) {
      error = caught instanceof Error ? caught.message.slice(0, 300) : String(caught);
    }
    const member = choice !== null && voiceQuestionChoices(question).includes(choice);
    const result: Row = { id: row.id, category: row.category, expected: row.expected, choice, confidence, member,
      ms: Math.round(performance.now() - began), error, ...runIdentity,
      ...(question.kind === "split" && { nameOffset: question.nameOffset }) };
    appendFileSync(dest, `${JSON.stringify(result)}\n`);
    console.log(JSON.stringify(result));
  }
  summarize(label);
}

if (args[0] === "--summarize") {
  for (const label of args.slice(1)) summarize(label);
} else {
  await run();
}
