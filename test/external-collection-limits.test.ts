import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { z } from "zod";
import { BacklogReportSchema } from "../src/server/foreman/backlog-plan.ts";
import { QueueVerdictSchema } from "../src/server/foreman/queue-verify.ts";
import { normalizePersonaVerdict, parsePersonaVerdict } from "../src/server/workflows/verdict.ts";
import { SettingsBackupJsonValueSchema } from "../src/shared/settings-backups.ts";
import { VerdictSchema } from "../src/server/foreman/verdict.ts";
import { LLM_REPLY_COLLECTION_MAX } from "../src/shared/llm.ts";
import { PLANNABLE_LIMIT } from "../src/shared/backlog.ts";
import { SETTINGS_BACKUP_LIMITS } from "../src/shared/settings-backups.ts";

test("the installed Zod and every lockfile Zod resolution include the collection fix", () => {
  const fixed = (version: string) => {
    const [major, minor, patch] = version.split(".").map(Number);
    return major! > 4 || major === 4 && (minor! > 6 || minor === 6 && patch! >= 6);
  };
  const installed = JSON.parse(readFileSync(new URL("../node_modules/zod/package.json", import.meta.url), "utf8"));
  assert.ok(fixed(installed.version), `installed Zod ${installed.version} is vulnerable`);
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const resolutions = Object.entries(lock.packages).filter(([path]) => /(?:^|\/)node_modules\/zod$/.test(path));
  assert.ok(resolutions.length > 0);
  for (const [path, entry] of resolutions) assert.ok(fixed((entry as { version: string }).version), `${path} is vulnerable`);
});

for (const [name, schema, input] of [
  ["array", z.array(z.string()).max(2), [null, null, null]],
  ["set", z.set(z.string()).max(2), new Set([1, 2, 3])],
  ["map", z.map(z.string(), z.string()).max(2), new Map([[1, null], [2, null], [3, null]])],
] as const) {
  test(`Zod rejects an oversized ${name} with one size issue and no element issues`, () => {
    const result = schema.safeParse(input);
    assert.equal(result.success, false);
    assert.deepEqual(result.error!.issues.map(issue => [issue.code, issue.path]), [["too_big", []]]);
  });
}

// These boundaries receive external data after HTTP/MCP validation, or independently of it.
// An accessor counts element reads without allocating thousands of validation issues.
function unreadArray(length: number) {
  let reads = 0;
  const value = Array.from({ length }, () => null);
  Object.defineProperty(value, 0, { get() { reads++; return null; } });
  return { value, reads: () => reads };
}

test("oversized Persona replies are refused through the raw model-reply parser", () => {
  const result = parsePersonaVerdict(JSON.stringify({
    verdict: "pass", summary: "Approved", confidence: 1,
    approvalDetails: { reason: "Reviewed", evidence: Array.from({ length: 1001 }, () => ({ kind: "goal", quote: "Goal" })) },
  }));
  assert.equal(result, null, "refuse excessive input instead of parsing and then trimming it");
});

for (const field of ["requestedChanges", "approvalEvidence", "changeEvidence"] as const) {
  test(`Persona ${field} are bounded before reading elements`, () => {
    const input = unreadArray(1001);
    const result = normalizePersonaVerdict(field === "approvalEvidence" ? {
      verdict: "pass", summary: "Approved", confidence: 1,
      approvalDetails: { reason: "Reviewed", evidence: input.value },
    } : {
      verdict: "fail", summary: "Repair", confidence: 1,
      requestedChanges: field === "requestedChanges" ? input.value : [{ title: "Fix", rationale: "Needed", evidence: input.value }],
    });
    assert.equal(result, null);
    assert.equal(input.reads(), 0, "no element should be parsed");
  });
}

for (const field of ["gaps", "resolved"] as const) {
  test(`queue verifier ${field} are bounded before normalization`, () => {
    const input = unreadArray(1001);
    const result = QueueVerdictSchema.safeParse({ complete: false, summary: "Review", [field]: input.value });
    assert.equal(result.success, false);
    assert.deepEqual(result.error!.issues.map(issue => [issue.code, issue.path]), [["too_big", [field]]]);
    assert.equal(input.reads(), 0);
  });
}

test("backlog model tasks and dependency lists stop before reading elements", () => {
  for (const nested of [false, true]) {
    const input = unreadArray(401);
    const result = BacklogReportSchema.safeParse({ tasks: nested ? [{ id: "t", dependsOn: input.value }] : input.value });
    assert.equal(result.success, false);
    assert.deepEqual(result.error!.issues.map(issue => [issue.code, issue.path]), [["too_big", nested ? ["tasks", 0, "dependsOn"] : ["tasks"]]]);
    assert.equal(input.reads(), 0);
  }
});

test("backup JSON bounds arrays and records at every depth before reading entries", () => {
  for (const nested of [false, true]) {
    for (const record of [false, true]) {
      let reads = 0;
      const input = record ? Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`k${i}`, null])) : Array.from({ length: 5001 }, () => null);
      Object.defineProperty(input, record ? "k0" : "0", { enumerable: true, get() { reads++; return Infinity; } });
      const result = SettingsBackupJsonValueSchema.safeParse(nested ? { outer: [input] } : input);
      assert.equal(result.success, false);
      assert.equal(reads, 0, "the oversized container must stop the recursive parser");
    }
  }
});

test("external collections accept their intake limits and still apply normal output trimming", () => {
  const refs = Array.from({ length: LLM_REPLY_COLLECTION_MAX }, () => ({ kind: "goal", quote: "Goal" }));
  const verdict = normalizePersonaVerdict({ verdict: "pass", summary: "Approved", confidence: 1, approvalDetails: { reason: "Reviewed", evidence: refs } });
  assert.equal(verdict?.verdict, "pass");
  assert.equal(verdict?.verdict === "pass" && verdict.approvalDetails.evidence.length, 30);
  const resolved = Array.from({ length: LLM_REPLY_COLLECTION_MAX }, (_, i) => `g${i}`);
  assert.equal(QueueVerdictSchema.parse({ complete: true, summary: "Reviewed", resolved }).resolved.length, 32);
  const tasks = Array.from({ length: PLANNABLE_LIMIT }, (_, i) => ({ id: `t${i}`, dependsOn: Array.from({ length: PLANNABLE_LIMIT }, (_, j) => `t${j}`) }));
  assert.equal(BacklogReportSchema.parse({ tasks }).tasks.length, PLANNABLE_LIMIT);
  const values = Array.from({ length: SETTINGS_BACKUP_LIMITS.entriesPerCatalog }, () => null);
  assert.equal(SettingsBackupJsonValueSchema.safeParse(values).success, true);
  assert.equal(SettingsBackupJsonValueSchema.safeParse(Object.fromEntries(values.map((v, i) => [`k${i}`, v]))).success, true);
});

test("Foreman form answers bound both the question map and each selected-option list", () => {
  for (const record of [false, true]) {
    let reads = 0;
    const input = unreadArray(1001);
    const answers = record ? Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`q${i}`, "Yes"])) : { question: input.value };
    if (record) Object.defineProperty(answers, "q0", { enumerable: true, get() { reads++; return null; } });
    const result = VerdictSchema.safeParse({ purpose: "Review", classification: "implementation", action: "answer", answer: { text: "Yes", form: { answers } } });
    assert.equal(result.success, false);
    assert.equal(reads, 0);
    assert.equal(input.reads(), 0);
  }
});
