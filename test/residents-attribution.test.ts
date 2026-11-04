import { test } from "node:test";
import assert from "node:assert/strict";
import { attributeTranscript } from "../src/server/transcript-attribution.ts";
import { recordInjection } from "../src/server/injections.ts";
import { ResidentProfileRevisionSchema, residentLaunchInput } from "../src/shared/residents.ts";
import { residentWakeMarker } from "../src/shared/resident-turn.ts";
import * as store from "../src/server/residents/store.ts";
import * as loop from "../src/server/residents/loop-store.ts";
import type { TranscriptMessage } from "../src/shared/types.ts";
import type { SessionMessages } from "../src/server/harness/index.ts";

test("marker-shaped human text needs a recorded wake in this conversation, and a copied wake stays human", () => {
  const settings = ResidentProfileRevisionSchema.parse({ identity: { name: "Watcher" }, persona: { personaId: "p" } });
  store.createResidentProfile({ id: "profile", settings, at: 1 });
  store.reserveResidentRun({ id: "run", profileId: "profile", profileRevision: 1, taskId: "task", launchRequestId: "launch", launchInput: residentLaunchInput("/repo", ""), repoSpelling: "/repo", persona: { personaId: "p", name: "P", guidanceMarkdown: "" }, runInstructions: "", at: 1 });
  store.markResidentRunLaunched("run", null, 1);
  const text = residentWakeMarker("run", 2) + "\n" + settings.loop.prompt;
  const message = (id: string, ts = 100): TranscriptMessage => ({ id, role: "user", text, ts, tools: [] });
  const sent = message("sent"), copied = message("copied", 200);
  const conversation = { key: "native", transcript: { path: "/fixture", read: {
    after: () => ({ messages: [sent, copied], end: 200, atEnd: true }),
  } } as unknown as SessionMessages };
  assert.equal(attributeTranscript("session", [sent], null, undefined, conversation)[0]!.origin, undefined, "syntax alone proves nothing");
  const claim = loop.claimResidentWake("run", "loop", 0, 100, "native")!;
  loop.settleResidentClaim(claim, "sent", 110);
  recordInjection("session", text, "resident");
  assert.equal(attributeTranscript("other", [sent], null, undefined, { ...conversation, key: "other" })[0]!.origin, undefined);
  const [real, human] = attributeTranscript("session", [sent, copied], null, undefined, conversation);
  assert.equal(real!.origin, "resident");
  assert.equal(real!.presentation?.displayText, settings.loop.prompt);
  assert.equal(human!.origin, undefined, "a text-keyed live injection cannot swallow a human repeat");
  assert.equal(human!.presentation, undefined);
  assert.equal(attributeTranscript("session", [copied], null, undefined, conversation)[0]!.origin, undefined, "paging past the genuine wake cannot move attribution");
  assert.equal(attributeTranscript("session", [sent], null, undefined, { ...conversation, transcript: null })[0]!.origin, "resident", "the bound native turn survives loss of the transcript reader");
});
