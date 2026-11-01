// Enablement must never be inferred from inherited defaults, strings, or ambiguous YAML.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCodeRabbitConfig, parseCodeRabbitConfig } from "../src/server/workflows/coderabbit-config.ts";
const parse=(source:string)=>parseCodeRabbitConfig(Buffer.from(source));
test("explicit boolean true with schema comment and inheritance enables locally",()=>{
 assert.equal(parse('# yaml-language-server: $schema=https://coderabbit.ai/integrations/schema.v2.json\ninheritance: true\nreviews:\n  auto_review:\n    enabled: true\n').enabled,true);
});
for(const [name,source] of Object.entries({empty:"",inheritance:"inheritance: true",missing:"reviews: {}",false:'reviews: {auto_review: {enabled: false}}',string:'reviews: {auto_review: {enabled: "true"}}',malformed:"reviews: [",duplicate:"reviews: {}\nreviews: {auto_review: {enabled: true}}",documents:"reviews: {}\n---\nreviews: {auto_review: {enabled: true}}",tag:"reviews: !thing {}",alias:"reviews: &r {auto_review: {enabled: true}}\ncopy: *r",oversized:"#".repeat(65537)})) {
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
  writeFileSync(path,"reviews: {}");assert.equal(captured.enabled,true);assert.equal(captureCodeRabbitConfig(root).enabled,false);
 } finally {rmSync(root,{recursive:true,force:true});}
});
