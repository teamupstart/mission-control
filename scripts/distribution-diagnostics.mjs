// Only this projection may turn packaging errors into operator-visible text.
// Never serialize error objects, argv, environments, or stacks wholesale.
export function redactDistributionText(value, env = process.env) {
  let text = String(value ?? '');
  const secrets = Object.entries(env)
    .filter(([key, value]) => value && /CSC_|APPLE_|TOKEN|PASSWORD|SECRET|CREDENTIAL/i.test(key))
    .flatMap(([, value]) => [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)])
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  // Also cover PEM data and generated keychain passwords that were never in env.
  text = text.replace(/-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?(?:-----END [\w ]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]');
  text = text.replace(/\b(?:CSC_[A-Z_]+|APPLE_[A-Z_]+|[\w]*(?:PASSWORD|TOKEN|SECRET))["']?\s*[=:]\s*(?:"(?:\\.|[^"])*"|'[^']*'|[^\s,]+)/gi, '[REDACTED SETTING]');
  // A tool's reconstructed command line has lost argv boundaries. In particular,
  // security -p/-k passwords can contain spaces. Drop the entire command line.
  text = text.replace(/^.*(?:\bsecurity\b[^\n]*(?:create-keychain|unlock-keychain|import|set-key-partition-list)|--(?:key|password|keychain-profile)(?:[=\s])|\s-[pPk][=\s]).*$/gm, '[REDACTED COMMAND]');
  text = text.replace(/(?:"[^"\n]*\.p8"|'[^'\n]*\.p8'|[^\s"']*\.p8)/gi, '[REDACTED KEY PATH]');
  // No terminal escapes or forged GitHub workflow commands in error details.
  // eslint-disable-next-line no-control-regex -- Strip terminal control sequences from untrusted diagnostics.
  return text.replace(/\x1b\[[0-9;]*m/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/::/g, ': :').slice(0, 6000);
}

export class DistributionStageError extends Error {
  constructor(stage, cause) {
    super(cause instanceof Error ? cause.message : String(cause), {cause});
    this.name = 'DistributionStageError';
    this.stage = stage;
  }
}

export function distributionStages(log = console.log) {
  let current = 'preflight';
  const enter = (stage) => {
    if (current !== stage) log(`[distribution] stage=${stage}`);
    current = stage;
  };
  return {
    enter,
    async run(stage, operation) {
      enter(stage);
      try { return await operation(); }
      catch (error) { throw error instanceof DistributionStageError ? error : new DistributionStageError(current, error); }
    },
  };
}

export function distributionFailure(error, env = process.env) {
  const stage = error instanceof DistributionStageError ? error.stage : 'preflight';
  const cause = error instanceof DistributionStageError ? error.cause : error;
  const detail = {stage, error: cause?.name ?? 'Error'};
  for (const field of ['code', 'status', 'exitCode', 'signal', 'command', 'submissionId', 'notarizationStatus']) {
    if (typeof cause?.[field] === 'string' || typeof cause?.[field] === 'number') detail[field] = cause[field];
  }
  detail.message = cause?.message ?? String(cause);
  for (const field of ['stdout', 'stderr', 'notarizationLog']) {
    if (cause?.[field]) detail[field] = String(cause[field]);
  }
  return `[distribution] failed ${distributionDiagnostic(detail, env)}`;
}

export function distributionDiagnostic(detail, env = process.env) {
  // Redact before JSON encoding so command/PEM boundaries still exist.
  return JSON.stringify(Object.fromEntries(Object.entries(detail)
    .map(([key, value]) => [key, typeof value === 'number' || value == null ? value : redactDistributionText(value, env)])));
}

export function distributionToolError(command, result) {
  return Object.assign(new Error(`Distribution verification failed: ${command}`), {
    command, status: result.status, signal: result.signal, code: result.error?.code,
    stdout: result.stdout, stderr: result.stderr,
  });
}

export function preserveFailureExit() {
  process.exitCode = 1;
  // temp-file@3.4.0 -> async-exit-hook@2.0.1 binds beforeExit to exit(0).
  // Match electron-builder's CLI workaround (cli/cli-util.js, issue #2940).
  // Let asynchronous temporary keychain cleanup finish before pinning the exit.
  process.once('exit', () => { process.exitCode = 1; });
}
