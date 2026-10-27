import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { renderInstallBootstrap } from '../scripts/render-install-bootstrap.mjs';

const root = process.cwd();
const shell = renderInstallBootstrap();
const commit = 'a'.repeat(40);
function fixture(t: test.TestContext, failure = '', appName = 'Agent Mission Control.app') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'binary-bootstrap-')));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const candidate = join(dir, 'candidate.app');
  const alpha = failure === 'alpha';
  mkdirSync(join(candidate, 'Contents/MacOS'), {recursive: true});
  mkdirSync(join(candidate, 'Contents/Resources/app/scripts'), {recursive: true});
  const log = join(dir, 'tools.log'); writeFileSync(log, '');
  writeFileSync(join(candidate, 'Contents/Info.plist'), JSON.stringify({CFBundleIdentifier: 'com.mission-control.app', CFBundleExecutable: 'Mission Control'}));
  writeFileSync(join(candidate, 'Contents/Resources/app/package.json'), JSON.stringify({missionBinary: {...(appName === 'Agent Mission Control.app' && failure !== 'signed-name' ? {appBundleName: appName} : {}), commit: failure === 'identity' ? 'b'.repeat(40) : commit, version: '1.2.3'}}));
  writeFileSync(join(candidate, 'Contents/MacOS/Mission Control'), '#!/bin/bash\nprintf "runtime:%s\\n" "$@" >> "$PROBE_LOG"\n[[ $ELECTRON_RUN_AS_NODE == 1 ]]\n', {mode: 0o755});
  if (failure === 'symlink') symlinkSync('/etc/passwd', join(candidate, 'Contents/escape'));
  if (failure === 'symlink-parent') symlinkSync('..', join(candidate, 'escape'));
  if (failure === 'internal-links') {
    const framework = join(candidate, 'Contents/Frameworks/Fixture.framework');
    mkdirSync(join(framework, 'Versions/A'), {recursive: true});
    writeFileSync(join(framework, 'Versions/A/Fixture'), 'framework fixture');
    symlinkSync('A', join(framework, 'Versions/Current'));
    symlinkSync('Versions/Current/Fixture', join(framework, 'Fixture'));
    symlinkSync('MacOS/../MacOS/Mission Control', join(candidate, 'Contents/internal'));
  }
  // The fake gh also writes diagnostics under the download's per-file limit.
  // An 18-byte DMG caps that growing log at 1 KiB on Linux; use a realistic
  // minimum payload so logging cannot fail before the fixture downloads it.
  const dmg = Buffer.alloc(64 * 1024, 'signed dmg fixture');
  const manifest = {protocol: 1, ...(appName === 'Agent Mission Control.app' ? {appBundleName: failure === 'manifest-name' ? 'Unrelated.app' : appName} : {}), repo: 'teamupstart/mission-control', bundleId: 'com.mission-control.app',
    channel: alpha ? 'alpha' : 'stable', releaseTag: alpha ? null : 'v1.2.3', version: '1.2.3', commit, platform: 'darwin', arch: failure === 'manifest-arch' ? 'x64' : 'arm64',
    minimumSystemVersion: '12.0', helperProtocol: {min: 1, max: 1}, assets: [
      {kind: 'app-zip', id: '12', name: 'app.zip', bytes: 3, sha256: 'a'.repeat(64)},
      {kind: 'dmg', id: '13', name: 'app.dmg', bytes: dmg.length, sha256: failure === 'digest' ? 'b'.repeat(64) : createHash('sha256').update(dmg).digest('hex')},
    ]};
  const release = {tag_name: alpha ? `alpha-${commit}` : 'v1.2.3', draft: false, prerelease: alpha, assets: [
    {id: 11, name: 'mission-control-manifest.json', size: 1024, state: 'uploaded'},
    ...manifest.assets.map(a => ({id: Number(a.id), name: a.name, size: a.bytes, state: 'uploaded'})),
  ]};
  if (failure === 'incomplete') release.assets.pop();
  if (failure === 'no-manifest') release.assets.shift();
  const script = `#!${process.execPath}
import {appendFileSync,readFileSync,writeFileSync,statSync,cpSync,mkdirSync,mkdtempSync} from 'node:fs';
import {basename,join} from 'node:path';
const tool=basename(process.argv[1]), args=process.argv.slice(2), fail=${JSON.stringify(failure)};
appendFileSync(${JSON.stringify(log)}, tool+':'+JSON.stringify(args)+'\\n');
if(tool==='gh') {
  const endpoint=args[3];
  if(endpoint.endsWith('/assets/11')) process.stdout.write(fail==='oversize'?'x'.repeat(20000):fail==='malformed'?'invalid':${JSON.stringify(JSON.stringify(manifest))});
  else if(endpoint.endsWith('/assets/13')) process.stdout.write(fail==='truncated'?'short':${JSON.stringify(dmg.toString())});
  else if(endpoint.includes('/commits/')) console.log(JSON.stringify({sha:${JSON.stringify(commit)}}));
  else console.log(${JSON.stringify(JSON.stringify(release))});
} else if(tool==='plutil') {
  try { let v=JSON.parse(readFileSync(args.at(-1),'utf8')); for(const part of args[1].split('.')) v=v[part]; if(v===undefined)process.exit(1); console.log(typeof v==='object'?JSON.stringify(v):v); } catch {process.exit(1);}
} else if(tool==='uname') console.log(args[0]==='-s'?'Darwin':'arm64');
else if(tool==='sw_vers') console.log('12.7.6');
else if(tool==='mktemp') console.log(mkdtempSync(${JSON.stringify(join(dir, 'private-'))}));
else if(tool==='stat') console.log(statSync(args.at(-1)).size);
else if(tool==='od') console.log(fail==='architecture'?'ce fa ed fe 07 00 00 00':'cf fa ed fe 0c 00 00 01');
else if(tool==='codesign') {if(fail==='signer')process.exit(1);}
else if(tool==='spctl') {console.error(fail==='notarization'?'source=Developer ID':'source=Notarized Developer ID');}
else if(tool==='hdiutil') {if(args[0]==='attach') {if(fail==='mount')process.exit(1);cpSync(${JSON.stringify(candidate)},join(args.at(-1),fail==='root-mismatch'?'Mission Control.app':${JSON.stringify(appName)}),{recursive:true,verbatimSymlinks:true});if(fail==='mixed-root')cpSync(${JSON.stringify(candidate)},join(args.at(-1),'Mission Control.app'),{recursive:true});}}
else if(tool==='ditto') cpSync(args[0],args[1],{recursive:true,verbatimSymlinks:true});
else {process.exit(99);}
`;
  const mocked = ['gh', 'plutil', 'uname', 'sw_vers', 'mktemp', 'stat', 'od', 'codesign', 'spctl', 'hdiutil', 'ditto'];
  for (const tool of mocked) writeFileSync(join(bin, tool), script, {mode: 0o755});
  for (const tool of ['node', 'npm', 'npx', 'git', 'xcode-select', 'xcrun']) writeFileSync(join(bin, tool), `#!/bin/bash\necho forbidden:${tool} >> "$PROBE_LOG"\nexit 99\n`, {mode: 0o755});
  if (failure === 'missing-gh') rmSync(join(bin, 'gh'));
  let input = shell;
  // Fixture-only OS substitution. Production has no environment bypass for trust checks.
  for (const tool of mocked.filter(t => t !== 'gh')) input = input.replaceAll(`/usr/bin/${tool}`, join(bin, tool)).replaceAll(`/usr/sbin/${tool}`, join(bin, tool));
  // Missing fixture tools must stay missing even on hosts with gh installed.
  // Production OS utilities use absolute paths; PATH contains only our probes.
  return {log, run: (args: string[] = []) => spawnSync('/bin/bash', ['-s', '--', ...args], {input, env: {...process.env, PATH: bin, PROBE_LOG: log}, encoding: 'utf8', timeout: 30_000})};
}

test('standalone bootstrap stays generated from the shipped publisher policy', () => {
  assert.equal(readFileSync(join(root, 'scripts/install.sh'), 'utf8'), shell);
});
test('native bootstrap verifies twice, unmounts, and forwards quoted options without host build tools', t => {
  const f = fixture(t); const result = f.run(['--apps-dir', '/A folder/Applications', '--dry-run']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const log = readFileSync(f.log, 'utf8');
  assert.doesNotMatch(log, /forbidden:/);
  assert.match(log, /runtime:--apps-dir\nruntime:\/A folder\/Applications\nruntime:--dry-run/);
  assert.ok(log.lastIndexOf('codesign:') < log.indexOf('runtime:'));
  assert.ok(log.indexOf('hdiutil:["detach"') < log.indexOf('runtime:'));
  assert.equal((log.match(/codesign:/g) ?? []).length, 3);
});
for (const [failure, message] of Object.entries({
  'manifest-name': /Unsupported app bundle name/,
  'signed-name': /signed app name differs/,
  'root-mismatch': /unexpected entry|Unexpected DMG|does not contain|unexpected DMG|exactly one/i,
  'mixed-root': /unexpected entry|Unexpected DMG|does not contain|unexpected DMG|exactly one/i,
  'missing-gh': /GitHub CLI \(gh\) is required/,
  identity: /signed app differs from the selected release/,
  oversize: /Canonical download failed|Download exceeds its size limit/,
  truncated: /DMG size or SHA-256 mismatch/,
  'no-manifest': /no ready binary/,
  malformed: /Missing or invalid metadata/,
  'manifest-arch': /Unexpected manifest identity or protocol/,
  digest: /DMG size or SHA-256 mismatch/,
  incomplete: /ready release is incomplete/,
  signer: /DMG publisher verification failed/,
  notarization: /DMG is not notarized/,
  architecture: /app is not an arm64 executable/,
  mount: /Could not mount the DMG read-only/,
  symlink: /app contains an escaping or invalid link/,
  'symlink-parent': /app contains an escaping or invalid link/,
})) {
  test(`bootstrap refuses ${failure} before executing downloaded code`, t => {
    const f = fixture(t, failure); const result = f.run();
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, message);
    assert.doesNotMatch(readFileSync(f.log, 'utf8'), /runtime:|forbidden:/);
  });
}
for (const args of [['--scope','user','--scope','system'], ['--scope','user','--apps-dir','/somewhere'], ['--ref','main'], ['--repo','someone/fork'], ['--temporary-source'], ['--from-staged','/app']]) {
  test(`bootstrap rejects unsupported selection ${args.join(' ')}`, t => {
    const f = fixture(t); assert.notEqual(f.run(args).status, 0);
    assert.equal(readFileSync(f.log, 'utf8'), '');
  });
}

test('alpha bootstrap pins the selected full main SHA without falling back to stable', t => {
  const f = fixture(t, 'alpha'); const result = f.run(['--channel', 'alpha', '--dry-run']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const log = readFileSync(f.log, 'utf8');
  assert.match(log, /commits\/main/); assert.ok(log.includes(`releases/tags/alpha-${commit}`));
  assert.doesNotMatch(log, /releases\/latest|forbidden:/);
});

test('bootstrap accepts internal framework link chains and normalized internal file targets', t => {
  const f = fixture(t, 'internal-links'); const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(readFileSync(f.log, 'utf8'), /runtime:/);
});

test('current bootstrap can authenticate the historical root without accepting mixed or mismatched new roots', t => {
  const f = fixture(t, '', 'Mission Control.app');
  const result = f.run(['--dry-run']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(readFileSync(f.log, 'utf8'), /runtime:/);
});
