// Run on the distribution runner or a Mac with the same Xcode installed.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const workflow = parse(readFileSync(new URL('../.github/workflows/distribution.yml', import.meta.url), 'utf8'));
const developerDir = workflow.jobs.package.env.DEVELOPER_DIR;
console.log('DEVELOPER_DIR=%s', developerDir);
const options = { env: { ...process.env, DEVELOPER_DIR: developerDir }, stdio: 'inherit' };
execFileSync('/usr/bin/xcodebuild', ['-version'], options);
execFileSync('/usr/bin/xcrun', ['swift', '--version'], options);
execFileSync('/usr/bin/xcrun', ['swift', 'build', '--package-path', 'native/voice-listener', '-c', 'release', '--product', 'voice-listener'], options);
