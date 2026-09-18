import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import type { startDaemon } from '../src/main/daemon.ts';

test('fresh migration startup rejects an occupied unhealthy port and starts only after it is absent', async (t) => {
  let mode = 'http-error';
  const server = createServer((_request, response) => {
    if (mode === 'timeout') return;
    response.writeHead(mode === 'http-error' ? 503 : 200);
    response.end(mode === 'invalid-json' ? '{' : '{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const root = mkdtempSync(join(tmpdir(), 'mission-daemon-adapter-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const outfile = join(root, 'daemon.cjs');
  await build({stdin: {contents: 'export {startDaemon} from "./src/main/daemon.ts"; export {calls} from "./src/main/utility-supervisor.ts";', resolveDir: resolve('.')}, outfile,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [{name: 'daemon-boundaries', setup(b) {
      b.onResolve({filter: /utility-supervisor\.ts$/}, () => ({path: 'supervisor', namespace: 'fixture'}));
      b.onResolve({filter: /harness-runtime\.mjs$/}, (args) => args.importer.endsWith('/daemon.ts') ? {path: 'runtime', namespace: 'fixture'} : undefined);
      b.onLoad({filter: /.*/, namespace: 'fixture'}, (args) => ({contents: args.path === 'runtime'
        ? `export const PORT=${address.port}; export const BASE_URL="http://127.0.0.1:${address.port}";`
        : 'export const calls=[]; export function superviseUtilityProcess(opts) {calls.push(opts);return {stop(){}};}'}));
    }}]});
  const loaded = createRequire(import.meta.url)(outfile) as {startDaemon: typeof startDaemon; calls: unknown[]};
  const options = {requireFresh: true, serverEntry: '/fixture/personal/server.mjs', webDir: '/fixture/personal/web', logPath: join(root, 'daemon.log')};
  for (mode of ['http-error', 'invalid-json', 'wrong-service', 'timeout']) {
    await assert.rejects(loaded.startDaemon(options), /previous daemon.*running/);
    assert.equal(loaded.calls.length, 0, mode);
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const started = await loaded.startDaemon(options);
  assert.equal(started.adopted, false);
  assert.equal(loaded.calls.length, 1);
  started.stop();
});
