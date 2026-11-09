// Fixtures follow https://docs.coderabbit.ai/cli/agent-mode, verified with CLI 0.9.1 help. The
// `reviewedFiles` fixtures below are copied from a real CLI 0.9.2 completion line.
// No fixture invokes a real reviewer. Complete stdout and exit must agree independently.
import assert from "node:assert/strict";
import test from "node:test";
import { CodeRabbitResultParser, CODERABBIT_RESULT_LIMITS, type CodeRabbitChangedPaths } from "../src/server/workflows/coderabbit-result.ts";
const finding = { type: "finding", severity: "major", fileName: "src/🙂.ts", title: "Verify this claim", comment: "Details", codegenInstructions: "Inspect before fixing", suggestions: ["untrusted snippet"], startLine: 1, endLine: 2 };
const complete = { type: "complete", status: "review_completed", outcome: "completed", unreviewedFileCount: 0, findings: 1, gate: { threshold: "major", status: "blocked", blockingFindings: 1 } };
function parse(events: unknown[], exit = 2, empty = false, paths: CodeRabbitChangedPaths | null = null) {
  const parser = new CodeRabbitResultParser("attempt", "major", paths);
  parser.push(Buffer.from(events.map(e=>JSON.stringify(e)).join("\n")+"\n"));
  return parser.finish(exit, empty);
}
test("collection limits refuse oversized CodeRabbit records within the byte budget", () => {
  const suggestions = Array.from({ length: CODERABBIT_RESULT_LIMITS.suggestions }, () => "suggestion");
  assert.equal(parse([{ ...finding, suggestions }, complete]).status, "failed");
  assert.equal(parse([{ ...finding, suggestions: [...suggestions, null] }, complete]).status, "incomplete");
  const reviewedFiles = Array.from({ length: CODERABBIT_RESULT_LIMITS.reviewedFiles }, (_, i) => `p${i}`);
  const paths = { required: reviewedFiles, allowed: reviewedFiles };
  assert.equal(parse([finding, { ...complete, reviewedFiles }], 2, false, paths).status, "failed");
  const oversized = { ...complete, reviewedFiles: [...reviewedFiles, null] };
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) < CODERABBIT_RESULT_LIMITS.recordBytes);
  const result = parse([finding, oversized], 2, false, paths);
  assert.equal(result.status, "incomplete");
  assert.match(result.diagnostic, /Invalid CodeRabbit completion/);
});
test("split UTF-8 findings retain all text, stable ids and advisory severities", () => {
  const parser = new CodeRabbitResultParser("attempt", "major", null);
  const bytes = Buffer.from([finding, {...finding,severity:"info"}, {...complete,findings:2}].map(e=>JSON.stringify(e)).join("\n"));
  for (const byte of bytes) parser.push(Buffer.from([byte]));
  const result = parser.finish(2, false);
  assert.equal(result.status, "failed"); assert.equal(result.counts.info, 1);
  const rows = result.body.toString().trim().split("\n").map(s=>JSON.parse(s));
  assert.equal(rows[0].fileName, finding.fileName); assert.equal(rows[0].id,"attempt:1");
  assert.equal(rows[1].id,"attempt:2"); assert.deepEqual(rows[0].suggestions,finding.suggestions);
});
test("advisory-only completed and warning-completed reviews pass with full findings", () => {
  for (const outcome of ["completed", "completed_with_warnings"]) {
    const r = parse([{...finding,severity:"minor"}, {...complete,outcome, gate:{threshold:"major",status:"passed",blockingFindings:0}}],0);
    assert.equal(r.status,"passed"); assert.equal(r.counts.minor,1); assert.ok(r.body.includes(Buffer.from("Details")));
  }
});
test("completed, warning-completed, failed-gate and no-change results require explicit zero unreviewed files", () => {
  for (const [events, exit, empty] of [
    [[{ ...complete, findings: 0, gate: { threshold: "major", status: "passed", blockingFindings: 0 } }], 0, false],
    [[{ ...complete, outcome: "completed_with_warnings", findings: 0, gate: { threshold: "major", status: "passed", blockingFindings: 0 } }], 0, false],
    [[finding, complete], 2, false],
    [[{ ...complete, status: "review_skipped", findings: 0, gate: { threshold: "major", status: "passed", blockingFindings: 0 } }], 0, true],
  ] as const) {
    for (const coverage of [undefined, null, "0", -1, 0.5, 1]) {
      const result = parse(events.map(event => event.type === "complete"
        ? { ...event, unreviewedFileCount: coverage } : event), exit, empty);
      assert.equal(result.status, "incomplete", `coverage ${String(coverage)} must not establish a complete review`);
    }
    assert.notEqual(parse([...events], exit, empty).status, "incomplete");
  }
});
test("unknown additive events/fields and heartbeats are tolerated before completion", () => {
  assert.equal(parse([{type:"new_vendor_event",anything:true},{type:"heartbeat"},{...finding,additive:42},complete]).status,"failed");
});
for (const [name, events, code] of [
  ["exit 1",[finding,complete],1], ["exit disagreement",[finding,complete],0],
  ["missing completion",[finding],0], ["reused review",[finding,{...complete,reused:true}],2],
  ["missed files",[finding,{...complete,unreviewedFileCount:1}],2],
  ["failed outcome",[finding,{...complete,outcome:"failed"}],2],
  ["incomplete gate",[finding,{...complete,gate:{...complete.gate,status:"incomplete"}}],2],
  ["wrong threshold",[finding,{...complete,gate:{...complete.gate,threshold:"minor"}}],2],
  ["wrong counts",[finding,{...complete,findings:2}],2],
  ["duplicate completion",[finding,complete,complete],2],
  ["error before summary",[finding,{type:"error",errorType:"rate_limit"},complete],2],
  ["credit action before summary",[{type:"action_required",action:"use-credits"},finding,complete],2],
  ["unknown severity",[{...finding,severity:"surprise"},complete],2],
  ["invalid line range",[{...finding,endLine:0},complete],2],
] as const) test(`${name} blocks as incomplete and never fabricates a clean result`,()=>assert.equal(parse([...events],code).status,"incomplete"));
test("no-change skip requires an empty pinned comparison", () => {
  const event={...complete,status:"review_skipped",findings:0,gate:{threshold:"major",status:"passed",blockingFindings:0}};
  assert.equal(parse([event],0,true).status,"skipped"); assert.equal(parse([event],0,false).status,"incomplete");
  assert.equal(parse([{...event,status:"review_completed"}],0,true).status,"incomplete");
});
test("malformed JSON/UTF-8, oversized records and finding count overflow block", () => {
  for(const bytes of [Buffer.from("oops\n"),Buffer.from([0xff]),Buffer.from("x".repeat(CODERABBIT_RESULT_LIMITS.recordBytes+1))]) {
    const p=new CodeRabbitResultParser("a","major",null);p.push(bytes);p.push(Buffer.from(JSON.stringify(complete)));assert.equal(p.finish(0,false).status,"incomplete");
  }
  const r=parse([...Array.from({length:1001},()=>finding),{...complete,findings:1001,gate:{...complete.gate,blockingFindings:1001}}]);
  assert.equal(r.status,"incomplete");assert.equal(r.counts.major,1000);
});
test("normalized bytes overflow blocks; unsafe paths are retained as text but not display locations", () => {
  const large={...finding,comment:"x".repeat(200_000)};
  assert.equal(parse([...Array.from({length:24},()=>large),complete]).status,"incomplete");
  const r=parse([{...finding,fileName:"../escape"},complete]);assert.equal(JSON.parse(r.body.toString()).displayPath,null);
});
test("a vendor wait survives a later superficial completion as an action-required diagnostic", () => {
 const before=Date.now();const r=parse([{type:"error",errorType:"rate_limit",retryAfterSeconds:120},complete],1);
 assert.equal(r.status,"incomplete");assert.ok(r.retryAt!>=before+120000);
});
test("unknown events after completion remain additive, while duration stays diagnostic",()=>{
 const r=parse([{type:"review_context",expectedDuration:"15 minutes"},finding,complete,{type:"new_vendor_event"},{type:"heartbeat"}]);
 assert.equal(r.status,"failed");assert.equal(r.expectedDuration,"15 minutes");
});

// CLI 0.9.2 dropped `unreviewedFileCount` and reports `reviewedFiles` instead. This is the
// completion line a real 0.9.2 review printed, with its file list shortened.
const reviewedFilesComplete = { type: "complete", status: "review_completed", findings: 0,
  gate: { threshold: "major", status: "passed", blockingFindings: 0 },
  reviewedFiles: ["docs/task-read.md", "internal/service/task_read.go", "openapi/openapi.yaml"],
  outcome: "completed", message: "Review completed" };
const changed: CodeRabbitChangedPaths = { required: ["docs/task-read.md", "internal/service/task_read.go", "openapi/openapi.yaml"],
  allowed: ["docs/task-read.md", "internal/service/task_read.go", "openapi/openapi.yaml"] };
test("a reviewedFiles completion that covers exactly the pinned comparison passes", () => {
  const r = parse([{ type: "heartbeat", status: "reviewing" }, reviewedFilesComplete], 0, false, changed);
  assert.equal(r.status, "passed", r.diagnostic);
  const listedInAnotherOrder = { ...reviewedFilesComplete, reviewedFiles: [...reviewedFilesComplete.reviewedFiles].reverse() };
  assert.equal(parse([listedInAnotherOrder], 0, false, changed).status, "passed");
});
test("a reviewedFiles completion still fails on blocking findings", () => {
  const blocked = { ...reviewedFilesComplete, findings: 1, gate: { threshold: "major", status: "blocked", blockingFindings: 1 } };
  assert.equal(parse([finding, blocked], 2, false, changed).status, "failed");
});
test("reviewedFiles that miss a changed file, or name one outside the comparison, are incomplete", () => {
  const missed = parse([{ ...reviewedFilesComplete, reviewedFiles: ["docs/task-read.md", "openapi/openapi.yaml"] }], 0, false, changed);
  assert.equal(missed.status, "incomplete");
  assert.match(missed.diagnostic, /1 of 3 changed files not reviewed, 0 reviewed files outside/);
  assert.ok(!missed.diagnostic.includes("task_read.go"), "repository paths never reach the compact diagnostic");
  const outside = parse([{ ...reviewedFilesComplete, reviewedFiles: [...reviewedFilesComplete.reviewedFiles, "src/other.ts"] }], 0, false, changed);
  assert.equal(outside.status, "incomplete");
  assert.match(outside.diagnostic, /0 of 3 changed files not reviewed, 1 reviewed files outside/);
});
test("deleted and renamed-away paths may be reviewed but are never required", () => {
  const paths: CodeRabbitChangedPaths = { required: ["src/new.ts"], allowed: ["src/new.ts", "src/old.ts"] };
  for (const reviewedFiles of [["src/new.ts"], ["src/new.ts", "src/old.ts"]]) {
    assert.equal(parse([{ ...reviewedFilesComplete, reviewedFiles }], 0, false, paths).status, "passed");
  }
  assert.equal(parse([{ ...reviewedFilesComplete, reviewedFiles: ["src/old.ts"] }], 0, false, paths).status, "incomplete");
});
test("reviewedFiles cannot be trusted without the pinned comparison's changed files", () => {
  const r = parse([reviewedFilesComplete], 0, false, null);
  assert.equal(r.status, "incomplete"); assert.match(r.diagnostic, /changed files are unavailable/);
});
test("a completion with neither coverage shape is incomplete, and malformed reviewedFiles are rejected", () => {
  const { reviewedFiles: _files, ...bare } = reviewedFilesComplete;
  assert.match(parse([bare], 0, false, changed).diagnostic, /no review coverage/);
  for (const reviewedFiles of [null, "docs/task-read.md", [""], [42]]) {
    assert.equal(parse([{ ...reviewedFilesComplete, reviewedFiles }], 0, false, changed).status, "incomplete");
  }
});
test("both coverage shapes together must both agree", () => {
  assert.equal(parse([{ ...reviewedFilesComplete, unreviewedFileCount: 0 }], 0, false, changed).status, "passed");
  assert.equal(parse([{ ...reviewedFilesComplete, unreviewedFileCount: 1 }], 0, false, changed).status, "incomplete");
});
test("a no-change skip with an empty reviewedFiles list matches an empty comparison", () => {
  const skipped = { ...reviewedFilesComplete, status: "review_skipped", reviewedFiles: [] };
  assert.equal(parse([skipped], 0, true, { required: [], allowed: [] }).status, "skipped");
});
