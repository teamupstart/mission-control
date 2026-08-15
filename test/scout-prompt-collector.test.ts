import assert from "node:assert/strict";
import test from "node:test";
import {
  ARCHIVE_PROMPT_LIMITS,
  type ArchiveManifestPromptEntry,
} from "../src/shared/archives.ts";
import type { TranscriptMessage } from "../src/shared/types.ts";
import type { TranscriptMessages } from "../src/server/harness/types.ts";
import {
  boundScoutPromptTrail,
  collectScoutPromptTrail,
  type ScoutPromptCollectorDependencies,
} from "../src/server/scouts/prompt-collector.ts";
import {
  scoutPromptFingerprint,
  type ScoutPromptContext,
  type ScoutPromptTurn,
} from "../src/server/scouts/prompt-context.ts";
import { SCOUT_APPENDIX_MARKER } from "../src/server/scouts/prompt.ts";
import { scoutArchiveTitle } from "../src/server/archives/task-gateway.ts";

const TASK = { id: "task-1", agent: "claude" as const, intent: "Investigate resume permissions exactly." };

function context(over: Partial<ScoutPromptContext> = {}): ScoutPromptContext {
  return {
    taskId: TASK.id,
    episodeId: "episode-1",
    sessionId: "session-1",
    sessionName: "Resume permission loss",
    transcriptPath: "/tmp/scout.jsonl",
    transcriptOffset: 0,
    truncated: false,
    createdAt: 100,
    updatedAt: 100,
    ...over,
  };
}

function turn(
  id: string,
  origin: ScoutPromptTurn["origin"],
  text: string | null,
  deliveredAt: number,
): ScoutPromptTurn {
  return {
    id,
    taskId: TASK.id,
    episodeId: "episode-1",
    seq: Number(id.replace(/\D/g, "")) || 0,
    origin,
    text,
    fingerprint: scoutPromptFingerprint(text ?? id),
    deliveredAt,
  };
}

function message(id: string, role: "user" | "assistant", text: string, ts: number): TranscriptMessage {
  return { id, role, text, tools: [], ts };
}

function reader(messages: TranscriptMessage[], size = 100): TranscriptMessages {
  return {
    size: () => size,
    after: (_path: string, offset: number) => ({ messages, start: offset, end: size, atEnd: true }),
  } as unknown as TranscriptMessages;
}

function deps(options: {
  frozen?: ScoutPromptContext | null;
  turns?: ScoutPromptTurn[];
  messages?: TranscriptMessage[];
  size?: number | null;
  readError?: boolean;
  liveOrigin?: ScoutPromptCollectorDependencies["liveOrigin"];
} = {}): ScoutPromptCollectorDependencies {
  const read = options.size === null
    ? null
    : options.readError
      ? ({
          size: () => options.size ?? 100,
          after: () => {
            throw new Error("transcript rotated after stat");
          },
        } as unknown as TranscriptMessages)
      : reader(options.messages ?? [], options.size ?? 100);
  return {
    context: () => (options.frozen === undefined ? context() : options.frozen),
    turns: () => options.turns ?? [],
    sessionMessages: () => null,
    transcriptMessages: () => read,
    liveOrigin: options.liveOrigin ?? (() => undefined),
  };
}

test("the collector keeps only human prompts and removes the scout opening and assistant output", () => {
  const human = turn("turn-1", "human", "Also compare Pi.", 2_000);
  const automated = turn("turn-2", "workflow", null, 3_000);
  automated.fingerprint = scoutPromptFingerprint("Run the workflow repair packet.");
  const collected = collectScoutPromptTrail(TASK, "episode-1", null, deps({
    turns: [human, automated],
    messages: [
      message("opening", "user", `${TASK.intent}\n\n${SCOUT_APPENDIX_MARKER}\ncontract`, 1_000),
      message("answer", "assistant", "The report says something private.", 1_500),
      message("human", "user", "Also compare Pi.", 2_050),
      message("workflow", "user", "Run the workflow repair packet.", 3_050),
      message("direct", "user", "Check terminal pickup too.", 4_000),
    ],
  }));

  assert.equal(collected.frozenSessionName, "Resume permission loss");
  assert.deepEqual(collected.trail.entries, [
    { kind: "initial", text: TASK.intent, at: null },
    { kind: "follow_up", text: "Also compare Pi.", at: new Date(2_000).toISOString() },
    { kind: "follow_up", text: "Check terminal pickup too.", at: new Date(4_000).toISOString() },
  ]);
  assert.equal(collected.trail.truncated, false);
});

test("durable origins survive restart and journaled humans survive a missing transcript", () => {
  const automated = turn("turn-1", "foreman", null, 2_000);
  automated.fingerprint = scoutPromptFingerprint("Automated Foreman instruction");
  const human = turn("turn-2", "human", "Keep the exact delivered follow-up.", 3_000);
  const collected = collectScoutPromptTrail(TASK, "episode-1", null, deps({
    turns: [automated, human],
    size: null,
  }));

  assert.deepEqual(collected.trail.entries.map((entry) => entry.text), [
    TASK.intent,
    "Keep the exact delivered follow-up.",
  ]);
  assert.equal(collected.trail.truncated, true, "a missing transcript is never presented as complete");
});

test("a rotated anchor keeps delivered journal rows and marks the trail incomplete", () => {
  const collected = collectScoutPromptTrail(TASK, "episode-1", null, deps({
    frozen: context({ transcriptOffset: 500 }),
    turns: [turn("turn-1", "human", "This delivery still counts.", 3_000)],
    size: 100,
  }));
  assert.deepEqual(collected.trail.entries.map((entry) => entry.text), [
    TASK.intent,
    "This delivery still counts.",
  ]);
  assert.equal(collected.trail.truncated, true);
});

test("a transcript removed during paging degrades to durable human rows", () => {
  const collected = collectScoutPromptTrail(TASK, "episode-1", null, deps({
    turns: [turn("turn-1", "human", "Keep this accepted prompt.", 3_000)],
    readError: true,
  }));
  assert.deepEqual(collected.trail.entries.map((entry) => entry.text), [
    TASK.intent,
    "Keep this accepted prompt.",
  ]);
  assert.equal(collected.trail.truncated, true);
});

test("a pre-context scout keeps its exact initial intent and says completeness is unknown", () => {
  const collected = collectScoutPromptTrail(TASK, "episode-1", null, deps({ frozen: null }));
  assert.deepEqual(collected.trail.entries, [{ kind: "initial", text: TASK.intent, at: null }]);
  assert.equal(collected.trail.truncated, true);
});

test("journal identities preserve repeated deliveries while recovery duplicates collapse", () => {
  const first = turn("turn-1", "human", "Repeat this.", 2_000);
  const second = turn("turn-2", "human", "Repeat this.", 2_000);
  const collected = collectScoutPromptTrail(TASK, "episode-1", null, deps({
    turns: [first, second],
    messages: [
      message("one", "user", "Repeat this.", 2_000),
      message("two", "user", "Repeat this.", 2_000),
      message("recovery-a", "user", "Transcript only.", 4_000),
      message("recovery-b", "user", "Transcript only.", 4_000),
    ],
  }));
  assert.deepEqual(collected.trail.entries.map((entry) => entry.text), [
    TASK.intent,
    "Repeat this.",
    "Repeat this.",
    "Transcript only.",
  ]);
});

test("a truncated attribution journal never promotes an unknown transcript turn to human", () => {
  const collected = collectScoutPromptTrail(TASK, "episode-1", null, deps({
    frozen: context({ truncated: true }),
    messages: [message("unknown", "user", "Could be evicted automation", 2_000)],
  }));
  assert.deepEqual(collected.trail.entries.map((entry) => entry.text), [TASK.intent]);
  assert.equal(collected.trail.truncated, true);
});

test("portable bounds keep the initial prompt and newest follow-ups", () => {
  const followUps: ArchiveManifestPromptEntry[] = Array.from({ length: 300 }, (_, index) => ({
    kind: "follow_up",
    text: `follow-up-${index}`,
    at: null,
  }));
  const bounded = boundScoutPromptTrail("initial", followUps);
  assert.equal(bounded.entries.length, ARCHIVE_PROMPT_LIMITS.entries);
  assert.equal(bounded.entries[0]?.text, "initial");
  assert.equal(bounded.entries[1]?.text, "follow-up-45");
  assert.equal(bounded.entries.at(-1)?.text, "follow-up-299");
  assert.equal(bounded.truncated, true);

  const multibyte = "界".repeat(ARCHIVE_PROMPT_LIMITS.entryBytes);
  const clipped = boundScoutPromptTrail(multibyte, []);
  assert.ok(Buffer.byteLength(clipped.entries[0]!.text, "utf8") <= ARCHIVE_PROMPT_LIMITS.entryBytes);
  assert.equal(clipped.truncated, true);
});

test("scout title projection prefers the live card, then the frozen episode, then the task", () => {
  assert.equal(scoutArchiveTitle("Live short title", "Frozen title", "A very long task"), "Live short title");
  assert.equal(scoutArchiveTitle(" ", "Frozen title", "A very long task"), "Frozen title");
  assert.equal(scoutArchiveTitle(null, null, "Legacy task title"), "Legacy task title");
  assert.equal(scoutArchiveTitle("x".repeat(500), null, "fallback"), "x".repeat(200));
});
