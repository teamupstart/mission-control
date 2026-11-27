// Throwaway interactive probes. Nothing in the application imports this file.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
const out = resolve('.tmp/voice-spike');
mkdirSync(out, { recursive: true });
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
run('xcrun', ['swiftc', '-module-cache-path', `${out}/swift-cache`, 'scripts/voice-spike/mac.swift', '-o', `${out}/mac-probe`]);
const entitlement = '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.device.audio-input</key><true/></dict></plist>';
writeFileSync(`${out}/audio.plist`, entitlement);
for (const shell of [false, true]) for (const helper of [false, true]) {
  const name = `VoiceSpike-S${+shell}H${+helper}`;
  const app = `${out}/${name}.app`;
  mkdirSync(`${app}/Contents/MacOS`, { recursive: true });
  writeFileSync(`${app}/Contents/Info.plist`, `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>probe</string><key>CFBundleIdentifier</key><string>local.voice-spike.s${+shell}h${+helper}</string><key>CFBundleName</key><string>${name}</string><key>CFBundlePackageType</key><string>APPL</string><key>NSMicrophoneUsageDescription</key><string>Measure microphone permission for the voice spike.</string></dict></plist>`);
  for (const binary of ['probe', 'helper']) {
    copyFileSync(`${out}/mac-probe`, `${app}/Contents/MacOS/${binary}`);
    run('codesign', ['--force', '--sign', '-', '--options', 'runtime', ...((binary === 'probe' ? shell : helper) ? ['--entitlements', `${out}/audio.plist`] : []), `${app}/Contents/MacOS/${binary}`]);
  }
  run('codesign', ['--force', '--sign', '-', '--options', 'runtime', ...(shell ? ['--entitlements', `${out}/audio.plist`] : []), app]);
  run('codesign', ['--verify', '--deep', '--strict', app]);
}
if (process.argv.includes('--build-only')) process.exit(0);
const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log('S4: four distinct hardened apps. Record the exact prompt name and allow each when prompted. No system permission is reset. Logs stay in .tmp/voice-spike.');
for (const variant of ['S0H0', 'S0H1', 'S1H0', 'S1H1']) {
  await rl.question(`Press Enter to launch ${variant}; allow microphone if prompted. `);
  run('open', ['-W', '-n', `${out}/VoiceSpike-${variant}.app`]);
  const note = await rl.question('Exact prompt name, or no prompt; any error? ');
  writeFileSync(`${out}/${variant}-operator.txt`, note + '\n');
}
console.log('Now disable VoiceSpike-S1H1 in System Settings > Privacy & Security > Microphone.');
await rl.question('Press Enter after disabling it to measure denial. ');
copyFileSync(`${out}/VoiceSpike-S1H1.app.log`, `${out}/permission-allowed.log`);
run('open', ['-W', '-n', `${out}/VoiceSpike-S1H1.app`]);
copyFileSync(`${out}/VoiceSpike-S1H1.app.log`, `${out}/permission-denied.log`);
console.log('S5: over 30 seconds, press, hold 2 seconds, then release Control+Command+V, and Control+Command+Option+V, three times each. Try releasing Option before V once. Note any permission prompt.');
await rl.question('Enter to begin. ');
const hotkey = spawnSync(`${out}/mac-probe`, ['hotkey'], { encoding: 'utf8' });
writeFileSync(`${out}/hotkey.log`, hotkey.stdout + hotkey.stderr); console.log(hotkey.stdout);
writeFileSync(`${out}/hotkey-operator.txt`, await rl.question('Any prompt, missed event, or sticky key? ') + '\n');
console.log('S6: join a call in your usual app. For the next 30 seconds: stay unmuted for 10 seconds, mute for 10, then leave. No audio is recorded by this probe.');
await rl.question('Enter when ready. ');
const calls = spawnSync(`${out}/mac-probe`, ['calls'], { encoding: 'utf8' });
writeFileSync(`${out}/calls.log`, calls.stdout + calls.stderr);
writeFileSync(`${out}/calls-operator.txt`, await rl.question('Call app/version and approximate mute/leave times? ') + '\n');
rl.close(); console.log('Done. Tell Mission Control the checks finished; logs are under .tmp/voice-spike.');
