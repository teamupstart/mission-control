// A root YAML runs CodeRabbit unless auto_review.enabled is boolean false. Strings, tags, aliases and ambiguous YAML never enable it.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCodeRabbitConfig, parseCodeRabbitConfig } from "../src/server/workflows/coderabbit-config.ts";
import { CodeRabbitConfigSnapshotSchema } from "../src/shared/protocol.ts";
const parse=(source:string)=>parseCodeRabbitConfig(Buffer.from(source));
test("explicit boolean true with schema comment and inheritance enables locally",()=>{
 assert.equal(parse('# yaml-language-server: $schema=https://coderabbit.ai/integrations/schema.v2.json\ninheritance: true\nreviews:\n  auto_review:\n    enabled: true\n').enabled,true);
});
for(const [name,source] of Object.entries({inheritance:"inheritance: true",noReviews:"reviews: {}",noAutoReview:"reviews: {auto_review: {}}",empty:"",whitespaceOnly:"  \n\n",commentOnly:"# nothing configured yet\n",docStartOnly:"---\n"})) {
 test(`${name} (no auto_review.enabled opt-out) runs CodeRabbit`,()=>assert.equal(parse(source).enabled,true));
}
for(const [name,source] of Object.entries({false:'reviews: {auto_review: {enabled: false}}',string:'reviews: {auto_review: {enabled: "true"}}',malformed:"reviews: [",duplicate:"reviews: {}\nreviews: {auto_review: {enabled: true}}",documents:"reviews: {}\n---\nreviews: {auto_review: {enabled: true}}",tag:"reviews: !thing {}",alias:"reviews: &r {auto_review: {enabled: true}}\ncopy: *r",oversized:"#".repeat(65537)})) {
 test(`${name} cannot enable CodeRabbit`,()=>assert.equal(parse(source).enabled,false));
}
test("capture refuses symlinks/nonfiles and preserves sanitized digest without source secrets",()=>{
 const root=mkdtempSync(join(tmpdir(),"mc-cr-yaml-"));const path=join(root,'.coderabbit.yaml');
 try {
  assert.equal(captureCodeRabbitConfig(root).state,"missing");
  writeFileSync(join(root,"secret"),"sensitive: sentinel\nreviews: {auto_review: {enabled: true}}");symlinkSync(join(root,"secret"),path);
  assert.equal(captureCodeRabbitConfig(root).state,"unreadable");rmSync(path);mkdirSync(path);assert.equal(captureCodeRabbitConfig(root).state,"unreadable");rmSync(path,{recursive:true});
  writeFileSync(path,"secret: sentinel\nreviews: {auto_review: {enabled: true}}");const captured=captureCodeRabbitConfig(root);
  assert.equal(captured.enabled,true);assert.match(captured.digest!,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(captured).includes("sentinel"));
  writeFileSync(path,"reviews: {auto_review: {enabled: false}}");assert.equal(captured.enabled,true);assert.equal(captureCodeRabbitConfig(root).enabled,false);
 } finally {rmSync(root,{recursive:true,force:true});}
});

// Gating matrix (jh-cpr): which repo files decide whether the CodeRabbit stage runs.
function withRepo(files: Record<string, string>, run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "mc-cr-gate-"));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
    run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const YAML_ON = "reviews:\n  auto_review:\n    enabled: true\n";
const YAML_OFF = "reviews:\n  auto_review:\n    enabled: false\n";
const CONFIG_TS = "export default { reviews: {} };\n";

test("gate: .coderabbit.yaml with auto_review enabled true runs",()=>{
  withRepo({ ".coderabbit.yaml": YAML_ON }, (root) => assert.equal(captureCodeRabbitConfig(root).enabled, true));
});
test("gate: .coderabbit.yaml with no auto_review entry runs",()=>{
  withRepo({ ".coderabbit.yaml": "language: en-US\nreviews:\n  profile: chill\n" }, (root) => assert.equal(captureCodeRabbitConfig(root).enabled, true));
});
test("gate: .coderabbit.yaml with auto_review enabled false does not run",()=>{
  withRepo({ ".coderabbit.yaml": YAML_OFF }, (root) => assert.equal(captureCodeRabbitConfig(root).enabled, false));
});
test("gate: .coderabbit.config.ts alone runs",()=>{
  withRepo({ ".coderabbit.config.ts": CONFIG_TS }, (root) => assert.equal(captureCodeRabbitConfig(root).enabled, true));
});
test("gate: neither .coderabbit.yaml nor .coderabbit.config.ts does not run",()=>{
  withRepo({}, (root) => assert.equal(captureCodeRabbitConfig(root).enabled, false));
});
test("gate: .coderabbit.yaml auto_review false wins over .coderabbit.config.ts",()=>{
  withRepo({ ".coderabbit.yaml": YAML_OFF, ".coderabbit.config.ts": CONFIG_TS }, (root) => {
    const snapshot = captureCodeRabbitConfig(root);
    assert.equal(snapshot.enabled, false);
    assert.equal(snapshot.state, "disabled");
    // The snapshot must say the YAML opt-out is why, so an operator can see the config.ts was overridden.
    assert.match(snapshot.diagnostic, /auto_review.*false/i);
  });
});
test("gate: a bare empty .coderabbit.yaml runs",()=>{
  withRepo({ ".coderabbit.yaml": "" }, (root) => {
    const snapshot = captureCodeRabbitConfig(root);
    assert.equal(snapshot.enabled, true);
    assert.equal(snapshot.state, "enabled");
  });
});
test("gate: a comment-only .coderabbit.yaml runs",()=>{
  withRepo({ ".coderabbit.yaml": "# TODO configure\n" }, (root) => assert.equal(captureCodeRabbitConfig(root).enabled, true));
});

test("the persisted snapshot schema accepts a .coderabbit.config.ts source",()=>{
  withRepo({ ".coderabbit.config.ts": CONFIG_TS }, (root) => {
    const snapshot = captureCodeRabbitConfig(root);
    assert.equal(snapshot.source, ".coderabbit.config.ts");
    assert.equal(CodeRabbitConfigSnapshotSchema.safeParse(snapshot).success, true);
  });
});
test("gate: an oversized .coderabbit.config.ts is invalid, not enabled",()=>{
  withRepo({ ".coderabbit.config.ts": "//" + "x".repeat(65537) }, (root) => {
    const snapshot = captureCodeRabbitConfig(root);
    assert.equal(snapshot.enabled, false);
    assert.equal(snapshot.state, "invalid");
    assert.equal(snapshot.source, ".coderabbit.config.ts");
  });
});
