// Offline checks deliberately import no native package and open no audio device.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
if (process.argv.length !== 3 || process.argv[2] !== '--dry') throw Error('Usage: node scripts/voice-spike/run.mjs --dry');
const cases = JSON.parse(readFileSync(resolve(here,'routing-cases.json'),'utf8'));
assert.equal(cases.length,60);
assert.equal(new Set(cases.map(x=>x.id)).size,60);
assert.equal(new Set(cases.map(x=>x.text)).size,60);
for(const kind of ['plain','phonetic','split','mention','option']) assert.equal(cases.filter(x=>x.kind===kind).length,12);
for(const row of cases) assert.ok(row.text && row.expected);
const schema=JSON.parse(readFileSync(resolve(here,"routing-schema.json"),"utf8"));
assert.deepEqual(schema.required,["choice","confidence"]);
assert.equal(schema.additionalProperties,false);
for(const file of ['mac-checks.mjs','mac-followup.mjs','summarize-mac.mjs','sherpa.mjs','routing.mjs','summarize.mjs','stream.mjs','capture.mjs','summarize-routing.mjs','first-word.mjs']) {
 const result=spawnSync(process.execPath,['--check',resolve(here,file)],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
}
const fixture={tokens:[' W','ill',' grab',' the',' door'],timestamps:[0,.16,.48,.64,.8],durations:[.16,.16,.08,.08,.08]};
const { tokenWords } = await import('./summarize.mjs');
const words=tokenWords(fixture);
assert.ok(Math.abs((words[1].startTime-words[0].endTime)*1000-160)<1e-6);
const { firstWordTarget } = await import('./first-word.mjs');
for (const [text,target] of [
 ['Will, grab the door','Will'], ['Will you grab the door','Will'],
 ['will check the build','Will'], ['"Will," check the build','Will'],
 ['Steve, ask Will about the build','Steve'], ['Please ask Will',null],
 ['Willow, check the build',null], ["Will's build failed",null], ['',null],
]) assert.equal(firstWordTarget(text,['Will','Steve']),target,text);
console.log('PASS: 60 synthetic routing cases, five balanced categories, unique IDs, probe syntax, token-to-word gap arithmetic, and first-word routing policy. No network, native imports, or microphone access.');
