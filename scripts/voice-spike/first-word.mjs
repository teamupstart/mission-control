// Offline replay of the operator's first-word rule. Not an application router.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export function firstWordTarget(text, names) {
  const first = text.match(/^\s*(?:["“([{]\s*)*([\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*)/u)?.[1];
  return names.find(name => name.toLowerCase() === first?.toLowerCase()) ?? null;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = '.tmp/voice-spike/';
  const corpus = JSON.parse(readFileSync(root + 'audio/corpus.json', 'utf8'));
  const names = ['Steve', 'Will', 'Luna', 'Atlas', 'Nova', 'Jordan', 'Quinn', 'Sage', 'Phoenix', 'Rowan'];
  for (const backend of ['fluid', 'fluid-boosted', 'sherpa', 'sherpa-hotwords']) {
    const rows = readFileSync(root + backend + '-results.jsonl', 'utf8').trim().split('\n')
      .filter(line => line.includes('{')).map(line => JSON.parse(line.slice(line.indexOf('{'))))
      .filter(row => row.id);
    assert.equal(rows.length, 57);
    assert.equal(new Set(rows.map(row => row.id)).size, 57);
    const results = rows.map(row => {
      const clip = corpus.find(clip => clip.id === row.id);
      assert.ok(clip, row.id);
      // Expected name comes from the synthesis recipe, not the recognizer output.
      const expected = clip.name ?? (clip.id.startsWith('continuous-') ? 'Will' : null);
      const target = firstWordTarget(row.text, names);
      return { id: row.id, text: row.text, expected, target, correct: target === expected };
    });
    console.log(JSON.stringify({ backend, policy: 'first-word-no-pause', cases: results.length,
      correct: results.filter(row => row.correct).length,
      roster: results.filter(row => !row.id.startsWith('gap-') && !row.id.startsWith('continuous-')).filter(row => row.correct).length,
      gapTrials: results.filter(row => row.id.startsWith('gap-')).filter(row => row.correct).length,
      continuousRoutes: results.filter(row => row.id.startsWith('continuous-')).filter(row => row.correct).length,
      failures: results.filter(row => !row.correct) }));
  }
}
