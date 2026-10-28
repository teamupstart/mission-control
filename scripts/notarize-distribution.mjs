import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { distributionDiagnostic, distributionToolError, DistributionStageError } from './distribution-diagnostics.mjs';

// Unlike @electron/notarize's error strings, retain the child status and submission
// identity even when submit/wait fails. Never log credential argv or raw responses.
export function runNotarizationTool(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, {encoding: 'utf8', timeout: 21 * 60_000, maxBuffer: 1024 * 1024}, (error, stdout, stderr) => {
      resolve({status: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        signal: error?.signal, error, stdout, stderr});
    });
  });
}

export async function notarizeDistribution(appPath, credentials, {
  run = runNotarizationTool, log = console.log, env = process.env,
  wait = (ms) => new Promise((done) => setTimeout(done, ms)),
} = {}) {
  const stage = appPath.endsWith('.dmg') ? 'notarize (dmg)' : 'notarize (app)';
  const auth = ['--key', credentials.appleApiKey, '--key-id', credentials.appleApiKeyId, '--issuer', credentials.appleApiIssuer];
  let submissionId, notarizationStatus;
  const tool = async (command, args) => {
    const result = await run(command, args);
    if (result.error || result.status !== 0) throw distributionToolError(command, result);
    return result;
  };
  const notary = async (args) => {
    const result = await run('/usr/bin/xcrun', ['notarytool', ...args, ...auth, '--output-format', 'json']);
    let parsed;
    try { parsed = JSON.parse(result.stdout); } catch { /* Tool errors can be plain text. */ }
    if (typeof parsed?.id === 'string' && /^[a-f0-9-]{36}$/i.test(parsed.id)) submissionId = parsed.id;
    if (typeof parsed?.status === 'string') notarizationStatus = parsed.status;
    log(`[distribution] ${distributionDiagnostic({stage, command: 'notarytool', operation: args[0],
      status: result.status, submissionId, notarizationStatus: notarizationStatus ?? 'unavailable'}, env)}`);
    if (result.error || result.status !== 0 || !parsed) throw distributionToolError('notarytool', result);
    return parsed;
  };
  const root = mkdtempSync(join(tmpdir(), 'mission-notarize-'));
  try {
    let file = appPath;
    if (!appPath.endsWith('.dmg')) {
      await tool('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
      file = join(root, 'app.zip');
      await tool('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, file]);
    }
    await notary(['submit', file]);
    if (!submissionId) throw new Error('Notarytool did not return a submission ID');
    await notary(['wait', submissionId, '--timeout', '20m']);
    if (notarizationStatus !== 'Accepted') throw Object.assign(new Error('Apple did not accept the notarization submission'), {command: 'notarytool', status: 0});
    // Ticket propagation can lag acceptance. Preserve @electron/notarize's three retries.
    for (let attempt = 0; ; attempt++) {
      try { await tool('/usr/bin/xcrun', ['stapler', 'staple', '-v', appPath]); break; }
      catch (error) { if (attempt === 3) throw error; await wait(1000 * 2 ** attempt); }
    }
  } catch (error) {
    Object.assign(error, {submissionId, notarizationStatus});
    if (submissionId && notarizationStatus !== 'Accepted') {
      try {
        const result = await run('/usr/bin/xcrun', ['notarytool', 'log', submissionId, ...auth]);
        const report = JSON.parse(result.stdout);
        // Keep Apple's actionable issue list, not arbitrary transport/credential data.
        error.notarizationLog = JSON.stringify({status: report.status, statusCode: report.statusCode,
          statusSummary: report.statusSummary, issues: report.issues?.map(({severity, code, path, message, architecture}) =>
            ({severity, code, path, message, architecture}))});
      } catch { /* A log lookup must not mask the original submit/wait failure. */ }
    }
    throw new DistributionStageError(stage, error);
  } finally { rmSync(root, {recursive: true, force: true}); }
}
