// Exercise the real Electron utility port with a detached check in a disposable home.
import assert from 'node:assert/strict';
import test from 'node:test';
import {buildSync} from 'esbuild';
import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);

test('Electron waits for its utility to interrupt and reap a live check before quitting', {skip:process.platform !== 'darwin', timeout:30000}, async (t) => {
  const root = mkdtempSync(join(tmpdir(),'mission-update-shutdown-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const output = join(root,'result.json');
  buildSync({stdin:{contents:`
    import {spawnCheckProcess} from './src/server/workflows/check-spawn.ts';
    import {killLiveCheckGroups} from './src/server/workflows/check-group.ts';
    import {writeFileSync} from 'node:fs';
    process.parentPort.on('message', ({data})=> { if(data?.type==='mission:shutdown') killLiveCheckGroups(); });
    const outcome = await spawnCheckProcess({attemptId:'electron-shutdown',command:['/bin/sleep','60'],
      cwd:process.cwd(),env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},timeoutMs:60000,
      onSupervisorReady:()=>setImmediate(()=>process.parentPort.postMessage('ready'))});
    writeFileSync(${JSON.stringify(output)}, JSON.stringify(outcome));
    process.exit(0);
  `,resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',packages:'external',alias:{'@shared':'./src/shared'},outfile:join(root,'worker.mjs')});
  buildSync({stdin:{contents:`
    import {app,utilityProcess} from 'electron';
    import {stopUtilityProcess} from './src/main/utility-shutdown.ts';
    app.whenReady().then(() => {
    const worker = utilityProcess.fork(${JSON.stringify(join(root,'worker.mjs'))});
    worker.on('exit', (code)=> { if(code) app.exit(code); });
    worker.once('message', async ()=> { await stopUtilityProcess(worker); app.exit(0); });
    });
  `,resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',external:['electron'],outfile:join(root,'main.mjs')});
  writeFileSync(join(root,'package.json'),JSON.stringify({main:'main.mjs',type:'module'}));
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(require('electron'),[root],{env,stdio:['ignore','ignore','pipe']});
  t.after(()=>app.kill('SIGKILL'));
  let stderr=''; app.stderr.on('data',chunk=>{stderr+=chunk; process.stderr.write(chunk);});
  const code = await new Promise((resolve,reject)=> { app.on('error',reject); app.on('exit',resolve); });
  assert.equal(code,0,stderr);
  const outcome=JSON.parse(readFileSync(output,'utf8'));
  assert.equal(outcome.emptiness,'empty');
  assert.match(outcome.result.reason,/Mission Control is shutting down/);
});
