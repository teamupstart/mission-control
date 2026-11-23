import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Intercept curl inside the Python process: fixtures never contact a model host.
const harness = `
import json, pathlib, runpy, subprocess, sys
from unittest.mock import patch
fixture = json.loads(pathlib.Path('fixture.json').read_text())
calls = []
def curl(args, **kwargs):
    url = args[-3]
    calls.append(url)
    dest = pathlib.Path(args[-1])
    if '/api/models/' in url:
        siblings = [{'rfilename': 'tokens.txt', 'size': fixture['expectedBytes']}]
        dest.write_text(json.dumps({'siblings': siblings if '/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/' in url else []}))
    else:
        dest.write_bytes(fixture['download'].encode())
    return subprocess.CompletedProcess(args, 0)
try:
    with patch('subprocess.run', curl):
        runpy.run_path(sys.argv[1], run_name='__main__')
finally:
    pathlib.Path('requests.json').write_text(json.dumps(calls))
`;

function runProbe(t, { cached, download = 'good' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'voice-spike-download-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, 'download.py');
  copyFileSync(new URL('./download.py', import.meta.url), script);
  const pinned = [{
    backend: 'sherpa',
    repository: 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    revision: '84b478d541cdbf0c296a7ab5f1e20a6f8f998114',
    file: 'tokens.txt',
    bytes: 4,
    sha256: createHash('sha256').update('good').digest('hex'),
  }];
  writeFileSync(join(root, 'models.json'), JSON.stringify(pinned));
  writeFileSync(join(root, 'fixture.json'), JSON.stringify({ expectedBytes: 4, download }));
  const output = join(root, '.tmp/voice-spike');
  mkdirSync(output, { recursive: true });
  if (cached !== undefined) {
    const dest = join(output, 'sherpa/tokens.txt');
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, cached);
  }
  const result = spawnSync('python3', ['-c', harness, script], { cwd: root, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return { ...result, output, pinned, requests: JSON.parse(readFileSync(join(root, 'requests.json'), 'utf8')) };
}

test('downloads the pinned file and records only verified bytes', (t) => {
  const r = runProbe(t);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(r.output, 'model-manifest.json'), 'utf8')), r.pinned);
  assert.ok(r.requests.includes(`https://huggingface.co/${r.pinned[0].repository}/resolve/${r.pinned[0].revision}/tokens.txt`));
});

test('verifies a valid cached file without downloading it', (t) => {
  const r = runProbe(t, { cached: 'good' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.requests.every((url) => !url.includes('/resolve/')));
});

for (const [label, options] of [
  ['same-size corrupt cached non-LFS bytes', { cached: 'evil' }],
  ['same-size corrupt downloaded non-LFS bytes', { download: 'evil' }],
  ['wrong-size cached bytes', { cached: 'short' }],
  ['wrong-size downloaded bytes', { download: 'short' }],
]) {
  test(`rejects ${label} against models.json`, (t) => {
    const r = runProbe(t, options);
    assert.notEqual(r.status, 0, 'corrupt bytes must not pass verification');
    assert.match(r.stderr, /tokens\.txt/);
    assert.throws(() => readFileSync(join(r.output, 'model-manifest.json')), { code: 'ENOENT' });
  });
}
