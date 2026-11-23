import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const require = createRequire(resolve('.tmp/voice-spike/node/package.json'));
const sherpa = require('sherpa-onnx-node');
const small = process.argv.includes('--small');
const model = resolve('.tmp/voice-spike/' + (small ? 'small-tdt' : 'sherpa'));
const suffix = small ? '.onnx' : '.int8.onnx';
const boosted = process.argv.includes('--hotwords');
const start = performance.now();
const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { transducer: { encoder: `${model}/encoder${suffix}`, decoder: `${model}/decoder${suffix}`, joiner: `${model}/joiner${suffix}` }, tokens: `${model}/tokens.txt`, numThreads: 2, provider: 'cpu', modelType: 'nemo_transducer' },
  decodingMethod: boosted ? 'modified_beam_search' : 'greedy_search',
});
console.log(JSON.stringify({ loadMs: performance.now()-start, boosted }));
const vocabulary = readFileSync(`${model}/tokens.txt`, 'utf8').trim().split('\n').map(line => line.split(' ')[0]);
function tokenize(word) {
  const target = '▁' + word.toLowerCase();
  const memo = new Map();
  function walk(offset) {
    if (offset === target.length) return [];
    if (memo.has(offset)) return memo.get(offset);
    for (const token of vocabulary.filter(t => t && target.startsWith(t, offset)).sort((a,b)=>b.length-a.length)) {
      const rest = walk(offset+token.length);
      if (rest) return [token, ...rest];
    }
    memo.set(offset, null); return null;
  }
  const pieces = walk(0); if (!pieces) throw Error(`Cannot tokenize ${word}`); return pieces.join(' ');
}
const names = ['Steve','Will','Luna','Atlas','Nova','Jordan','Quinn','Sage','Phoenix','Rowan'];
const hotwords = names.map(tokenize).join('/');
const clips = process.argv.includes('--fixture') ? [{id:'upstream-0',file:`${model}/test_wavs/0.wav`}] : JSON.parse(readFileSync('.tmp/voice-spike/audio/corpus.json', 'utf8'));
for (const clip of clips) {
  const wav = sherpa.readWave(clip.file);
  const stream = recognizer.createStream(boosted ? hotwords : undefined);
  const t = performance.now(); stream.acceptWaveform({ sampleRate: wav.sampleRate, samples: wav.samples }); recognizer.decode(stream);
  console.log(JSON.stringify({id:clip.id, ms:performance.now()-t, ...recognizer.getResult(stream), rss:process.memoryUsage().rss}));
}
