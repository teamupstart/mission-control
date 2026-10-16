import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BINARY_REPO } from '../src/shared/binary-distribution.mjs';
import { distributionMetadata } from './distribution-contract.mjs';
import { readVersions } from './assert-release-version.mjs';

export function distributionInput({ref, commit, head, versions, ciRuns, releasePulls = [], commitTags = []}) {
  if (head !== commit) throw new Error('Distribution source commit mismatch');
  const channel = ref === 'main' ? 'alpha' : 'stable';
  const metadata = distributionMetadata({channel, tag: ref, commit, versions});
  if (!ciRuns.some((run) => run.head_sha === commit && run.head_branch === ref && run.event === 'push' && run.conclusion === 'success' && run.head_repository?.full_name === BINARY_REPO)) {
    throw new Error('Distribution requires successful canonical push CI for this exact commit and source ref');
  }
  // Release Please's merged PR is published by its stable tag CI, not twice as
  // both stable and alpha. Require the canonical merged PR and its owner label.
  if (channel === 'alpha' && (commitTags.includes(`v${metadata.version}`) || releasePulls.some((pr) => pr.merged_at && pr.merge_commit_sha === commit &&
      pr.base?.ref === 'main' && pr.base?.repo?.full_name === BINARY_REPO && pr.head?.repo?.full_name === BINARY_REPO &&
      pr.head?.ref?.startsWith('release-please--branches--main') &&
      pr.labels?.some((label) => /^autorelease: (pending|tagged|published)$/.test(label.name))))) {
    return {commit, channel: 'skip', tag: ''};
  }
  return {commit, channel, tag: metadata.releaseTag ?? ''};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const commit = process.env.SOURCE_SHA;
    if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('Invalid source commit');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
    const env = {...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1'};
    delete env.GH_DEBUG; delete env.DEBUG;
    const read = (endpoint) => JSON.parse(execFileSync('gh', ['api', '--hostname', 'github.com', `repos/${BINARY_REPO}/${endpoint}`],
      {env, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2 * 1024 ** 2}));
    const ciRuns = read(`actions/workflows/ci.yml/runs?head_sha=${commit}&event=push&status=success&per_page=100`).workflow_runs;
    const releasePulls = process.env.SOURCE_REF === 'main' ? read(`commits/${commit}/pulls?per_page=100`) : [];
    if (!Array.isArray(releasePulls) || releasePulls.length >= 100) throw new Error('Ambiguous release pull request inventory');
    const commitTags = execFileSync('git', ['tag', '--points-at', commit], {encoding: 'utf8'}).trim().split('\n');
    const input = distributionInput({ref: process.env.SOURCE_REF, commit, head, versions: readVersions(process.cwd()), ciRuns, releasePulls, commitTags});
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(input).map(([key, value]) => `${key}=${value}\n`).join(''));
  } catch {
    console.error('Distribution input refused: require canonical successful push CI, exact source commit and matching stable versions');
    process.exitCode = 1;
  }
}
