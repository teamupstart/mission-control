// Claims survive restarts and uncertainty without replaying handled root findings.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { adoptPr } from "../src/server/inspector/worker.ts";
import { claimCodeRabbit, codeRabbitSummary, failCodeRabbit, finishCodeRabbit, openDb, readCodeRabbit, recordCodeRabbit } from "../src/server/db.ts";
import { ShippingConfigSchema } from "../src/shared/protocol.ts";
import { setShippingConfig, getShippingConfig } from "../src/server/shipping/config.ts";

const owner = { noteKey: "conversation", episodeKey: "intent" };
const finding = (id: string, identity = "initial", resolved = false) => ({ id, rootId: `root-${id}`, identity, resolved, url: `https://github.com/a/b/pull/1#discussion_r${id}`, path: "a.ts" });
let next = 1;
function setup() {
  const n = next++;
  adoptPr(`https://github.com/a/b/pull/${n}`, { sessionId: "s", cwd: "/tmp", repoRoot: "/tmp" }, "hook", Date.now());
  const key = `a/b#${n}`;
  const observe = (findings = [finding("a")], headSha = "head") => recordCodeRabbit(key, { findings, headSha, state: "OPEN", draft: false });
  const claim = () => claimCodeRabbit(key, owner, readCodeRabbit(key)!.observationId);
  const pending = () => codeRabbitSummary(key, owner).pending;
  return { key, observe, claim, pending };
}

test("old settings default off and patching preserves independent grants", () => {
  assert.equal(ShippingConfigSchema.parse({ autoMerge: true }).codeRabbitAutoResolve, false);
  setShippingConfig({ codeRabbitAutoResolve: true });
  assert.equal(getShippingConfig().autoMerge, false);
  setShippingConfig({ soakMinutes: 12 });
  assert.equal(getShippingConfig().codeRabbitAutoResolve, true);
});

test("one atomic winner, no replay on identical polls, shrinking sets, ordering or head-only changes", async () => {
  const s = setup(); s.observe([finding("a"), finding("b")]);
  const claims = await Promise.all([Promise.resolve().then(s.claim), Promise.resolve().then(s.claim)]);
  assert.equal(claims.filter(Boolean).length, 1);
  finishCodeRabbit(s.key, claims.find(Boolean)!, "delivered");
  s.observe([finding("b"), finding("a")], "push");
  assert.equal(s.pending(), 0);
  s.observe([finding("a")], "push-again");
  assert.equal(s.pending(), 0);
  setShippingConfig({ codeRabbitAutoResolve: false }); setShippingConfig({ codeRabbitAutoResolve: true });
  assert.equal(s.claim(), null);
  s.observe([finding("a"), finding("new")]);
  assert.equal(s.pending(), 1);
});

test("only root edits and observed reopen transitions create new generations", () => {
  const s = setup(); s.observe(); assert.ok(s.claim());
  s.observe([finding("a", "edit")]); assert.equal(s.pending(), 1); assert.ok(s.claim());
  s.observe([finding("a", "edit", true)]); assert.equal(s.pending(), 0);
  s.observe([finding("a", "edit")]); assert.equal(s.pending(), 1);
  assert.equal(readCodeRabbit(s.key)!.findings[0]!.generation, 3);
});

test("positive refusal releases only that claim; lost response stays uncertain and old results cannot clear new generations", () => {
  const s = setup(); s.observe(); const first = s.claim()!;
  assert.match(codeRabbitSummary(s.key, owner).delivery, /uncertain/i);
  assert.equal(s.claim(), null);
  finishCodeRabbit(s.key, first, "refused"); assert.equal(s.pending(), 1);
  const old = s.claim()!;
  s.observe([finding("a", "changed")]); const latest = s.claim()!;
  finishCodeRabbit(s.key, old, "refused");
  assert.equal(s.pending(), 0);
  assert.equal(readCodeRabbit(s.key)!.receipts[0]!.claimId, latest);
});

test("newer errors invalidate prior successes, retaining count; stale and startup history cannot deliver", () => {
  const s = setup(); s.observe(); const at = readCodeRabbit(s.key)!.observedAt;
  failCodeRabbit(s.key, "provider unavailable");
  const summary = codeRabbitSummary(s.key, owner);
  assert.equal(summary.status, "error"); assert.equal(summary.unresolved, 1);
  assert.equal(summary.observedAt, at); assert.equal(summary.pending, 0); assert.equal(s.claim(), null);
  s.observe(); assert.equal(codeRabbitSummary(s.key, owner, Date.now() + 500_000).pending, 0);
  assert.ok(s.claim());
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    const db = await import('./src/server/db.ts');
    const before = db.codeRabbitSummary(${JSON.stringify(s.key)}, ${JSON.stringify(owner)});
    if (before.status !== 'unknown' || before.pending !== 0) process.exit(10);
    db.recordCodeRabbit(${JSON.stringify(s.key)}, { findings: [${JSON.stringify(finding("a"))}], headSha: 'head', state: 'OPEN', draft: false });
    if (db.codeRabbitSummary(${JSON.stringify(s.key)}, ${JSON.stringify(owner)}).pending !== 0) process.exit(11);
  `], { encoding: "utf8", env: process.env });
  assert.equal(child.status, 0, child.stderr);
});

test("PR and episode identities stay independent; bounded state refuses to discard history", () => {
  const a = setup(), b = setup(); a.observe(); b.observe(); assert.ok(a.claim()); assert.equal(b.pending(), 1);
  assert.equal(codeRabbitSummary(a.key, { ...owner, episodeKey: "another" }).pending, 1);
  a.observe(Array.from({ length: 2001 }, (_, i) => finding(String(i))));
  assert.equal(codeRabbitSummary(a.key, owner).status, "error");
  assert.equal(readCodeRabbit(a.key)!.receipts.length, 1);
  openDb().prepare("DELETE FROM inspector_prs WHERE key = ?").run(a.key);
  assert.equal(readCodeRabbit(a.key), null, "adoption deletion owns cleanup");
});

test("claims may retain exactly 10,000 receipts but refuse overflow without discarding history", () => {
  const s = setup();
  s.observe([finding("handled")]);
  const handledClaim = s.claim();
  assert.ok(handledClaim);
  finishCodeRabbit(s.key, handledClaim, "delivered");
  const history = readCodeRabbit(s.key)!;
  const receipt = history.receipts[0]!;
  // Seed prior owners efficiently while retaining this owner's already handled finding.
  // Both delivered and uncertain receipts must survive a claim at the storage boundary.
  history.receipts = Array.from({ length: 9999 }, (_, i) => i === 0 ? receipt : {
    ...receipt, noteKey: `past-conversation-${i}`, claimId: `past-claim-${i}`,
    outcome: i % 2 === 0 ? "delivered" : "uncertain",
  });
  const db = openDb();
  db.prepare("UPDATE inspector_prs SET code_rabbit_state = ? WHERE key = ?")
    .run(JSON.stringify(history), s.key);

  s.observe([finding("handled"), finding("at-limit")]);
  assert.equal(s.pending(), 1, "the handled finding stays suppressed");
  const before = readCodeRabbit(s.key)!;
  assert.equal(before.receipts.length, 9999);
  const now = Date.now();
  const claim = claimCodeRabbit(s.key, owner, before.observationId, now);
  assert.ok(claim, "adding the 10,000th receipt must succeed");
  const atLimit = readCodeRabbit(s.key)!;
  assert.equal(atLimit.receipts.length, 10000);
  assert.deepEqual(atLimit.receipts.slice(0, -1), before.receipts);
  assert.deepEqual(atLimit.receipts.at(-1), {
    ...owner, threadId: "at-limit", generation: 1, observationId: before.observationId,
    headSha: "head", claimId: claim, at: now, outcome: "uncertain",
  });
  assert.equal(s.pending(), 0);

  s.observe([finding("handled"), finding("at-limit"), finding("over-limit")]);
  assert.equal(s.pending(), 1, "only the new finding is eligible before the overflow attempt");
  const persisted = () => db.prepare("SELECT code_rabbit_state FROM inspector_prs WHERE key = ?")
    .get(s.key)!.code_rabbit_state;
  const beforeOverflow = persisted();
  assert.equal(s.claim(), null, "adding the 10,001st receipt must hold delivery");
  assert.equal(persisted(), beforeOverflow, "a refused claim must not write or evict suppression history");
  assert.deepEqual(readCodeRabbit(s.key)!.receipts, atLimit.receipts);
  assert.equal(s.pending(), 1, "the held finding was not partially claimed");
});
