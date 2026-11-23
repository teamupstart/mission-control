// Focused follow-up. Original observations and app signatures remain untouched.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
const root = resolve('.tmp/voice-spike');
const runId = new Date().toISOString().replace(/[^0-9]/g, '');
const out = `${root}/followup-${runId}`;
mkdirSync(out, { recursive: true });
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
const probe = `${out}/mac-probe`;
run('xcrun', ['swiftc', '-module-cache-path', `${root}/swift-cache`, 'scripts/voice-spike/mac.swift', '-o', probe]);
writeFileSync(`${out}/audio.plist`, '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.device.audio-input</key><true/></dict></plist>');
const apps = {};
for (const kind of ['Allow', 'Deny']) {
  const name = `VoiceSpike-${kind}-${runId}`;
  const app = `${out}/${name}.app`;
  apps[kind] = app;
  mkdirSync(`${app}/Contents/MacOS`, { recursive: true });
  writeFileSync(`${app}/Contents/Info.plist`, `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>probe</string><key>CFBundleIdentifier</key><string>local.voice-spike.${kind.toLowerCase()}.${runId}</string><key>CFBundleName</key><string>${name}</string><key>CFBundlePackageType</key><string>APPL</string><key>NSMicrophoneUsageDescription</key><string>Measure voice spike permission and synthetic speaker feedback. Microphone audio is not saved.</string></dict></plist>`);
  for (const binary of ['probe', 'helper']) {
    copyFileSync(probe, `${app}/Contents/MacOS/${binary}`);
    run('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', `${out}/audio.plist`, `${app}/Contents/MacOS/${binary}`]);
  }
  run('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', `${out}/audio.plist`, app]);
  run('codesign', ['--verify', '--deep', '--strict', app]);
}
writeFileSync(`${root}/followup-latest.txt`, out + '\n');
console.log(`Results: ${out}`);
if (process.argv.includes('--build-only')) process.exit(0);
const recognizer = `${root}/fluid-local-build/release/Probe`;
if (!existsSync(recognizer)) throw Error('Build the FluidAudio probe using the README first.');
const rl = createInterface({ input: process.stdin, output: process.stdout });
function rows(text) {
  return text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}
function saveApp(kind, label) {
  const text = readFileSync(`${apps[kind]}.log`, 'utf8');
  writeFileSync(`${out}/${label}.log`, text);
  console.log(text);
  return rows(text);
}
async function record(command, args, label, env = {}) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; process.stdout.write(data); });
  const code = await new Promise((ok, fail) => { child.on('error', fail); child.on('close', ok); });
  writeFileSync(`${out}/${label}.log`, output);
  if (code !== 0) throw Error(`${label} exited ${code}; evidence saved.`);
  return rows(output);
}
console.log('S4: a fresh Deny app makes the denial unambiguous. No existing permission is reset.');
await rl.question('Enter to launch; click DON’T ALLOW on the microphone prompt. ');
run('open', ['-W', '-n', apps.Deny]);
const denied = saveApp('Deny', 'permission-denied');
console.log(denied.some(x => x.authorizationAfter === 2 && x.granted === false) ? 'PASS: actual denial observed.' : 'UNRESOLVED: did not observe denied authorization.');
writeFileSync(`${out}/denial-operator.txt`, await rl.question('Prompt name and any error? ') + '\n');
await rl.question('Enter to launch the separate Allow app; click ALLOW. ');
run('open', ['-W', '-n', apps.Allow]);
const allowed = saveApp('Allow', 'permission-allowed');
const hasAudio = allowed.some(x => x.frames > 0);
console.log(hasAudio ? 'PASS: allowed helper captured frames.' : 'UNRESOLVED: no captured frames; dependent audio checks will be skipped.');
console.log('S5: over 30 seconds, press, hold for 2 seconds, then release Control+Command+V three times and Control+Command+Option+V three times. Release Option before V once. Events will appear live.');
await rl.question('Enter to start. ');
const keys = await record(probe, ['hotkey'], 'hotkey');
for (const id of [1, 2]) console.log(`Chord ${id}: ${keys.filter(x => x.id === id && x.event === 'press').length} presses, ${keys.filter(x => x.id === id && x.event === 'release').length} releases`);
writeFileSync(`${out}/hotkey-operator.txt`, await rl.question('Any permission prompt, missing event, or sticky key? ') + '\n');
console.log('S6: use your usual call app. The next three snapshots are explicitly labeled.');
for (const [stage, instruction] of [['unmuted', 'Join a call and UNMUTE'], ['muted', 'MUTE the call but remain joined'], ['left', 'LEAVE the call']]) {
  await rl.question(`${instruction}, then press Enter. `);
  await record(probe, ['calls'], `calls-${stage}`, { SPIKE_POLLS: '8', SPIKE_STAGE: stage });
}
writeFileSync(`${out}/calls-operator.txt`, await rl.question('Call app/version and anything unusual? ') + '\n');
if (hasAudio) {
  console.log('Checking own-helper exclusion for 8 seconds, without saving audio.');
  const launched = spawn('open', ['-W', '-n', apps.Allow, '--args', 'launch', 'capture', '8']);
  const completion = new Promise((ok, fail) => { launched.on('error', fail); launched.on('close', ok); });
  let pid;
  for (let attempt = 0; attempt < 50; attempt++) {
    const log = readFileSync(`${apps.Allow}.log`, 'utf8');
    pid = rows(log).find(x => x.authorizationBefore !== undefined)?.pid;
    // Wait for the new capture, not the previous app invocation's PID.
    if (pid && pid !== allowed.find(x => x.pid)?.pid) break;
    pid = undefined;
    await new Promise(ok => setTimeout(ok, 100));
  }
  if (pid) await record(probe, ['calls', String(pid)], 'calls-own', { SPIKE_POLLS: '8', SPIKE_STAGE: 'own-helper' });
  else console.log('UNRESOLVED: new helper PID not observed.');
  await completion; saveApp('Allow', 'own-capture');
  console.log('S9: select SPEAKERS (not headphones), use normal audible volume, and keep the room quiet. About one minute of synthetic speech follows. Mic samples go only through memory to the local recognizer; only transcripts/metrics are saved.');
  writeFileSync(`${out}/feedback-operator.txt`, await rl.question('Speaker/output name, approximate volume, and microphone position? ') + '\n');
  await rl.question('Enter to start automatic playback/capture comparisons. ');
  run('open', ['-W', '-n', apps.Allow, '--args', 'launch', 'feedback', recognizer, `${root}/fluid`]);
  saveApp('Allow', 'feedback');
}
rl.close();
console.log(`Done. Tell Mission Control the follow-up completed. Logs: ${out}`);
