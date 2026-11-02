import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { verifyBinaryPublisher } from '../scripts/install-staged-app.mjs';
import { verifyDistributionDmg } from '../scripts/verify-distribution.mjs';
import { appPublisherRequirement, binaryPublisherPolicy, imagePublisherRequirement } from '../src/shared/binary-publisher-policy.mjs';
import { renderInstallBootstrap } from '../scripts/render-install-bootstrap.mjs';

const policy = binaryPublisherPolicy();
const macOnly = {skip: process.platform !== 'darwin' ? 'Requires real macOS codesign' : false};
const appRequirement = `=anchor apple generic and identifier "${policy.bundleId}" and certificate leaf[subject.OU] = "${policy.teamId}"`;
const dmgRequirement = `=anchor apple generic and certificate leaf[subject.OU] = "${policy.teamId}"`;
const sharedRequirements: Record<string, string> = {
  appPublisherRequirement: appPublisherRequirement(policy.teamId),
  imagePublisherRequirement: imagePublisherRequirement(policy.teamId),
};

// Discover calls throughout shipped code, not just a fixed list of known files.
// Require inspectable argv and literal text or the imported shared formatters at
// this trust boundary. Unknown expressions fail closed; no source text is evaluated.
function requirements(source: string, path: string): string[] {
  const found: string[] = [];
  if (/\.[cm]?[jt]sx?$/.test(path)) {
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const formatters = new Map<string, string>();
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
        || resolve(dirname(path), statement.moduleSpecifier.text) !== resolve('src/shared/binary-publisher-policy.mjs')) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const binding of bindings.elements) {
        const value = sharedRequirements[(binding.propertyName ?? binding.name).text];
        if (value !== undefined) formatters.set(binding.name.text, value);
      }
    }
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.arguments.some(arg => ts.isStringLiteral(arg) && /(^|\/)codesign$/.test(arg.text))) {
        const argv = node.arguments[1];
        assert.ok(argv && ts.isArrayLiteralExpression(argv), `${path}: codesign needs inspectable argv`);
        const args = argv.elements.map(arg => {
          if (ts.isStringLiteralLike(arg)) return arg.text;
          if (ts.isTemplateExpression(arg)) return arg.getText(ast).slice(1, -1);
          if (!ts.isCallExpression(arg) || !ts.isIdentifier(arg.expression) || arg.arguments.length !== 1) return null;
          const team = arg.arguments[0]!;
          if (!ts.isPropertyAccessExpression(team) || team.name.text !== 'teamId'
            || !ts.isIdentifier(team.expression) || !['publisher', 'policy'].includes(team.expression.text)) return null;
          return formatters.get(arg.expression.text) ?? null;
        });
        for (let i = 0; i < args.length; i++) {
          const arg = args[i];
          if (arg === '-R' || arg === '--test-requirement') {
            assert.ok(args[i + 1]?.startsWith('='), `${path}: ${arg} must receive requirement TEXT beginning with =`);
            found.push(args[++i]!);
          } else if (arg?.startsWith('-R')) {
            assert.ok(arg.startsWith('-R='), `${path}: attached -R must begin with -R=`);
            found.push(arg.slice(2));
          } else if (arg?.startsWith('--test-requirement=')) {
            assert.ok(arg.startsWith('--test-requirement=='), `${path}: long option value must begin with =`);
            found.push(arg.slice('--test-requirement='.length));
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  } else {
    for (const line of source.replace(/\\\r?\n/g, ' ').split('\n')) {
      if (!/(^|\s)(?:\/usr\/bin\/)?codesign\s/.test(line) || !/\s(?:-R|--test-requirement)/.test(line)) continue;
      const match = line.match(/\s(?:-R|--test-requirement)\s+(['"])(=.*?)\1(?:\s|$)/);
      assert.ok(match, `${path}: shell codesign must pass quoted requirement TEXT beginning with =`);
      found.push(match[2]!);
    }
  }
  return found;
}

test('every shipped codesign requirement is text and retains the publisher policy', () => {
  const sites: string[] = [];
  for (const root of ['scripts', 'src', 'hooks', '.github']) {
    for (const entry of readdirSync(root, {recursive: true, withFileTypes: true})) {
      if (!entry.isFile() || !/\.(?:[cm]?[jt]sx?|sh|ya?ml)$/.test(entry.name)) continue;
      const path = join(entry.parentPath, entry.name);
      const source = path === 'scripts/install-bootstrap.sh' ? renderInstallBootstrap() : readFileSync(path, 'utf8');
      if (!source.includes('codesign')) continue;
      for (const requirement of requirements(source, path)) {
        const rendered = requirement.replace(/\$\{(?:publisher|policy)\.teamId\}|@TEAM@/g, policy.teamId)
          .replace(/@BUNDLE_ID@/g, policy.bundleId);
        assert.ok([appRequirement, dmgRequirement].includes(rendered), `${path}: publisher semantics changed: ${rendered}`);
        sites.push(path);
      }
    }
  }
  for (const [path, count] of Object.entries({'scripts/install-staged-app.mjs': 1, 'scripts/verify-distribution.mjs': 1,
    'scripts/install-bootstrap.sh': 2, 'scripts/install.sh': 2})) {
    assert.equal(sites.filter(site => site === path).length, count, `guard must discover ${path}`);
  }
  assert.equal(readFileSync('scripts/install.sh', 'utf8'), renderInstallBootstrap(), 'regenerate the shipped installer');
});

test('the source guard rejects missing prefixes in JavaScript and shell, including multiline argv', () => {
  assert.throws(() => requirements("run('/usr/bin/codesign', ['--verify', '-R',\n `anchor apple`, app])", 'future.mjs'), /requirement TEXT/);
  assert.throws(() => requirements("/usr/bin/codesign --verify \\\n -R 'anchor apple' app", 'future.sh'), /requirement TEXT/);
});

test('the source guard follows only the shared formatter import and the publisher team argument', () => {
  const imported = "import { appPublisherRequirement as requirement } from '../src/shared/binary-publisher-policy.mjs';\n";
  const call = (argument: string) => `run('/usr/bin/codesign', ['--verify', '-R', ${argument}, app])`;
  assert.deepEqual(requirements(imported + call('requirement(publisher.teamId)'), 'scripts/future.mjs'), [appRequirement]);
  assert.throws(() => requirements(call('requirement(publisher.teamId)'), 'scripts/future.mjs'), /requirement TEXT/);
  assert.throws(() => requirements(imported + call('requirement(otherTeam)'), 'scripts/future.mjs'), /requirement TEXT/);
  assert.throws(() => requirements(imported + call('requirement(publisher.teamId).slice(1)'), 'scripts/future.mjs'), /requirement TEXT/);
});

function assertUnsatisfied(result: {status: number | null; stderr: string}, label: string) {
  assert.equal(result.status, 3, `${label}: ${result.stderr}`);
  assert.match(result.stderr, /failed to satisfy specified code requirement/);
  assert.doesNotMatch(result.stderr, /No such file|invalid requirement|syntax error|parse error/i);
}

test('real codesign accepts Apple anchor text and refuses wrong identifier and team semantically', macOnly, t => {
  for (const requirement of ['=anchor apple', '=anchor apple and identifier "com.mission-control.wrong"', dmgRequirement]) {
    const result = spawnSync('/usr/bin/codesign', ['--verify', '--strict', '-R', requirement, '/bin/ls'],
      {encoding: 'utf8', timeout: 30_000, env: {...process.env, LC_ALL: 'C'}});
    assert.ifError(result.error);
    t.diagnostic(JSON.stringify({tool: '/usr/bin/codesign', requirement, status: result.status, stderr: result.stderr}));
    if (requirement === '=anchor apple') assert.equal(result.status, 0, result.stderr);
    else assertUnsatisfied(result, requirement);
  }
});

test('real production app and DMG verifiers refuse an Apple binary at the publisher gate', macOnly, async t => {
  for (const verify of [verifyBinaryPublisher, verifyDistributionDmg]) {
    await assert.rejects(async () => verify('/bin/ls', policy), (error: {status: number; stderr: string}) => {
      t.diagnostic(JSON.stringify({verifier: verify.name, status: error.status, stderr: error.stderr}));
      assertUnsatisfied(error, verify.name);
      return true;
    });
  }
});

test('real codesign evaluates both rendered bootstrap requirements without file or parse errors', macOnly, t => {
  const source = renderInstallBootstrap();
  const calls = [...source.matchAll(/\/usr\/bin\/codesign ([^\n]+?) -R '([^']+)'/g)];
  assert.equal(calls.length, 2);
  for (const [, flags, requirement] of calls) {
    const result = spawnSync('/usr/bin/codesign', [...flags!.split(' '), '-R', requirement!, '/bin/ls'],
      {encoding: 'utf8', timeout: 30_000, env: {...process.env, LC_ALL: 'C'}});
    assert.ifError(result.error);
    t.diagnostic(JSON.stringify({bootstrapRequirement: requirement, status: result.status, stderr: result.stderr}));
    assertUnsatisfied(result, 'bootstrap');
  }
});
