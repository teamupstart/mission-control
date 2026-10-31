// Fixtures follow https://docs.coderabbit.ai/cli/agent-mode, verified with CLI 0.9.1 help.
// No fixture invokes a real reviewer. Complete stdout and exit must agree independently.
import assert from "node:assert/strict";
import test from "node:test";
import { CodeRabbitResultParser, CODERABBIT_RESULT_LIMITS } from "../src/server/workflows/coderabbit-result.ts";
const finding = { type: "finding", severity: "major", fileName: "src/🙂.ts", title: "Verify this claim", comment: "Details", codegenInstructions: "Inspect before fixing", suggestions: ["untrusted snippet"], startLine: 1, endLine: 2 };
const complete = { type: "complete", status: "review_completed", outcome: "completed", unreviewedFileCount: 0, findings: 1, gate: { threshold: "major", status: "blocked", blockingFindings: 1 } };
function parse(events: unknown[], exit = 2, empty = false) {
  const parser = new CodeRabbitResultParser("attempt", "major");
  parser.push(Buffer.from(events.map(e=>JSON.stringify(e)).join("\n")+"\n"));
  return parser.finish(exit, empty);
}
test("split UTF-8 findings retain all text, stable ids and advisory severities", () => {
  const parser = new CodeRabbitResultParser("attempt", "major");
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
    const p=new CodeRabbitResultParser("a","major");p.push(bytes);p.push(Buffer.from(JSON.stringify(complete)));assert.equal(p.finish(0,false).status,"incomplete");
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
