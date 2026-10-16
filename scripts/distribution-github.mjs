// gh owns authentication and redirect handling. Never extract tokens, accept a
// downloaded URL, or pass credentials to a second HTTP client.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { BINARY_REPO } from '../src/shared/binary-distribution.mjs';
import { binaryReleaseTag, BINARY_MANIFEST_NAME } from '../src/shared/binary-publisher-policy.mjs';
import { assertBuildMetadata } from './distribution-contract.mjs';

const ALPHA_TAG = /^alpha-([a-f0-9]{40})$/;
const RETIRED_ALPHA = 'Mission Control alpha retired. Request a new explicit offer; this exact identity must not be republished.';

function githubFailure(stderr) {
  const status = /\(HTTP (\d{3})\)/.exec(stderr ?? '')?.[1];
  return new Error(`Canonical GitHub request failed${status ? ` (HTTP ${status})` : ''}; check release App permissions and connectivity`);
}

export function githubDistributionTransport({command = 'gh', env = process.env} = {}) {
  const childEnv = {...env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1'};
  // A caller's debugging mode can log authorization headers. Distribution never inherits it.
  delete childEnv.GH_DEBUG;
  delete childEnv.DEBUG;
  const prefix = ['api', '--hostname', 'github.com'];
  const repo = `repos/${BINARY_REPO}`;
  const json = (endpoint, body, missing = false, method = body ? 'POST' : 'GET') => {
    const args = [...prefix, endpoint, '--method', method, ...(body ? ['--input', '-'] : [])];
    const result = spawnSync(command, args, {env: childEnv, input: body ? JSON.stringify(body) : undefined,
      encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 ** 2});
    if (result.error || result.status !== 0) {
      if (missing && !result.error && /\(HTTP 404\)/.test(result.stderr)) return null;
      throw githubFailure(result.stderr);
    }
    if (method === 'DELETE' && !result.stdout.trim()) return null;
    try { return JSON.parse(result.stdout); } catch { throw new Error('Canonical GitHub returned invalid JSON'); }
  };
  const transport = {
    async ensureRelease(metadata) {
      assertBuildMetadata(metadata);
      const tag = binaryReleaseTag(metadata);
      if (metadata.channel === 'alpha') {
        const comparison = json(`${repo}/compare/${metadata.commit}...main`);
        if (!['ahead', 'identical'].includes(comparison.status) || comparison.merge_base_commit?.sha !== metadata.commit) {
          throw new Error('Alpha commit is not on canonical main');
        }
      }
      let release = json(`${repo}/releases/tags/${tag}`, undefined, true);
      if (!release && metadata.channel === 'alpha') {
        release = json(`${repo}/releases`, {tag_name: tag, target_commitish: metadata.commit,
          name: `Mission Control alpha ${metadata.commit}`, prerelease: true, draft: false, make_latest: 'false',
          body: 'Exact-commit alpha. Ready only with mission-control-manifest.json. Replaced after a newer complete alpha is verified; retired identities are unavailable.'});
      }
      if (!release || release.tag_name !== tag || release.draft || release.prerelease !== (metadata.channel === 'alpha') || !Number.isSafeInteger(release.id)) {
        throw new Error('Release channel or identity mismatch; stable releases must already exist through Release Please');
      }
      if (metadata.channel === 'alpha' && release.body === RETIRED_ALPHA) throw new Error('This exact alpha identity has been retired; request a new explicit offer');
      if (json(`${repo}/commits/${tag}`).sha !== metadata.commit) throw new Error('Release tag does not resolve to the exact build commit');
      return {id: release.id, tag};
    },
    async listAssets(release) {
      const assets = [];
      for (let page = 1; page <= 10; page++) {
        const batch = json(`${repo}/releases/${release.id}/assets?per_page=100&page=${page}`);
        if (!Array.isArray(batch)) throw new Error('Invalid release asset inventory');
        assets.push(...batch);
        if (batch.length < 100) return assets;
      }
      throw new Error('Release asset inventory exceeds the publication limit');
    },
    async listAlphaReleases() {
      const releases = [];
      for (let page = 1; page <= 10; page++) {
        const batch = json(`${repo}/releases?per_page=100&page=${page}`);
        if (!Array.isArray(batch)) throw new Error('Invalid alpha release inventory');
        for (const release of batch) {
          if (!ALPHA_TAG.test(release.tag_name) || release.draft || release.prerelease !== true) continue;
          if (!Number.isSafeInteger(release.id) || release.id < 1) throw new Error('Invalid alpha release id');
          const retired = release.body === RETIRED_ALPHA;
          if (retired && Array.isArray(release.assets) && release.assets.length === 0) continue;
          if (json(`${repo}/commits/${release.tag_name}`).sha !== release.tag_name.slice(6)) throw new Error('Alpha release tag does not match its exact commit');
          releases.push({id: release.id, tag: release.tag_name, retired});
        }
        if (batch.length < 100) return releases;
      }
      throw new Error('Alpha release inventory exceeds the retention limit');
    },
    async isAncestor(ancestor, descendant) {
      if (![ancestor, descendant].every((sha) => /^[a-f0-9]{40}$/.test(sha))) throw new Error('Invalid alpha comparison identity');
      const comparison = json(`${repo}/compare/${ancestor}...${descendant}`);
      return ['ahead', 'identical'].includes(comparison.status) && comparison.merge_base_commit?.sha === ancestor;
    },
    async retireAlphaRelease(release) {
      if (!ALPHA_TAG.test(release.tag) || !Number.isSafeInteger(release.id) || release.id < 1) throw new Error('Only an exact-commit alpha can be retired');
      const found = json(`${repo}/releases/${release.id}`);
      if (found.tag_name !== release.tag || found.draft || found.prerelease !== true ||
          json(`${repo}/commits/${release.tag}`).sha !== release.tag.slice(6)) throw new Error('Alpha retirement identity changed');
      const allowed = new Set([BINARY_MANIFEST_NAME, ...['zip', 'dmg'].map((ext) => `Mission-Control-${release.tag}-darwin-arm64.${ext}`)]);
      const checkedAssets = async () => {
        const assets = await transport.listAssets(release);
        if (assets.some((asset) => !allowed.has(asset.name) || !/^[1-9]\d{0,31}$/.test(String(asset.id))) ||
            new Set(assets.map((asset) => asset.name)).size !== assets.length) throw new Error('Unexpected alpha retirement assets');
        return assets;
      };
      let assets = await checkedAssets();
      // Keep a small tombstone so a retry can never recreate different bytes under
      // a retired commit. Remove readiness before deleting any referenced archive.
      if (found.body !== RETIRED_ALPHA) json(`${repo}/releases/${release.id}`, {body: RETIRED_ALPHA}, false, 'PATCH');
      const ready = assets.find((asset) => asset.name === BINARY_MANIFEST_NAME);
      if (ready) json(`${repo}/releases/assets/${ready.id}`, undefined, true, 'DELETE');
      assets = await checkedAssets();
      if (assets.some((asset) => asset.name === BINARY_MANIFEST_NAME)) throw new Error('Alpha readiness remained after retirement');
      for (const asset of assets) json(`${repo}/releases/assets/${asset.id}`, undefined, true, 'DELETE');
      if ((await checkedAssets()).length) throw new Error('Alpha retirement is incomplete; retry with the retained current build');
    },
    async upload(release, path) {
      const result = spawnSync(command, ['release', 'upload', release.tag, path, '--repo', BINARY_REPO],
        {env: childEnv, encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 64 * 1024});
      if (result.error || result.status !== 0) throw githubFailure(result.stderr);
    },
    async readAsset(id, maxBytes, text = false) {
      if (!/^[1-9]\d{0,31}$/.test(id)) throw new Error('Invalid canonical asset id');
      const child = spawn(command, [...prefix, `${repo}/releases/assets/${id}`, '-H', 'Accept: application/octet-stream'],
        {env: childEnv, stdio: ['ignore', 'pipe', 'pipe']});
      let stderr = '';
      child.stderr.on('data', (chunk) => { if (stderr.length < 4096) stderr += chunk.toString(); });
      const completion = new Promise((done) => {
        child.once('error', () => done(false));
        child.once('close', (code) => done(code === 0));
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 15 * 60_000);
      const hash = createHash('sha256');
      let bytes = 0;
      const chunks = [];
      try {
        for await (const chunk of child.stdout) {
          bytes += chunk.length;
          if (bytes > maxBytes) throw new Error('Canonical asset exceeded its expected size');
          hash.update(chunk);
          if (text) chunks.push(chunk);
        }
        if (!await completion) throw githubFailure(stderr);
        return {bytes, sha256: hash.digest('hex'), ...(text ? {text: Buffer.concat(chunks).toString('utf8')} : {})};
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) child.kill('SIGKILL');
        await completion;
      }
    },
  };
  return transport;
}
