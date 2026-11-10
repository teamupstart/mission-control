import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectorFindingPostedLine,
  inspectorFindingsMinimumBytes,
  omittedFindingsLine,
  renderInspectorFindings,
} from "../src/server/inspector/findings-text.ts";
import { WORKFLOW_LIMITS } from "../src/shared/workflow.ts";
import type { InspectorComment } from "../src/shared/types.ts";

// What is at stake: this section is what a session reads to decide where a finding lives.
// A draft called "posted" sends the agent hunting for a thread that does not exist; a
// posted finding called "the only copy" hides the conversation already on it. And a
// section clipped mid-finding hands over half an instruction with no word that the rest
// exists, which is why the budget drops whole findings and counts them instead.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

function finding(
  fingerprint: string,
  severity: InspectorComment["severity"] = "major",
  over: Partial<InspectorComment> = {},
): InspectorComment {
  return {
    id: fingerprint,
    prKey: "owner/repo#7",
    fingerprint,
    path: "src/a.ts",
    line: 12,
    title: `${severity} ${fingerprint}`,
    body: `${severity} detail for ${fingerprint}`,
    severity,
    round: 1,
    status: "open",
    replies: 0,
    answeredCommentId: null,
    postedAt: 1_000,
    githubUrl: `https://github.com/owner/repo/pull/7#discussion_r${fingerprint}`,
    legacyPosted: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const ONLY_COPY = "Not posted on GitHub. This message is the only copy.";

test("every posted marker reads what the row proves", () => {
  const cases: Array<[string, Partial<InspectorComment>, string]> = [
    ["posted with a link", {}, "Posted on GitHub: https://github.com/owner/repo/pull/7#discussion_rf"],
    ["posted, link not captured", { githubUrl: null }, "Posted on GitHub (link not captured yet)"],
    [
      "demoted into the review summary",
      { line: null, githubUrl: "https://github.com/owner/repo/pull/7#pullrequestreview-9" },
      "Posted on GitHub in the review summary: https://github.com/owner/repo/pull/7#pullrequestreview-9",
    ],
    ["a draft never posted", { status: "drafted", postedAt: null, githubUrl: null }, ONLY_COPY],
    [
      "a draft whose earlier version was posted",
      { status: "drafted", postedAt: 500, githubUrl: "https://github.com/owner/repo/pull/7#discussion_r1" },
      "Not posted again. An earlier version was posted on GitHub: https://github.com/owner/repo/pull/7#discussion_r1",
    ],
    ["being posted", { status: "posting", postedAt: null, githubUrl: null }, "Being posted now"],
  ];
  for (const [name, over, line] of cases) {
    assert.equal(inspectorFindingPostedLine(finding("f", "major", over)), line, name);
    const section = renderInspectorFindings([finding("f", "major", over)], { budgetBytes: 8_000 });
    assert.ok(section.text.split("\n").includes(line), `${name}: the section carries its marker`);
  }
});

test("a draft posted earlier is never called the only copy", () => {
  const earlier: Array<[string, Partial<InspectorComment>]> = [
    ["by postedAt, with the earlier link", { status: "drafted", postedAt: 500 }],
    ["by the legacy backfill", { status: "drafted", postedAt: null, legacyPosted: "posted" }],
    ["with no link captured", { status: "drafted", postedAt: 500, githubUrl: null }],
  ];
  for (const [name, over] of earlier) {
    const line = inspectorFindingPostedLine(finding("f", "major", over));
    assert.match(line, /^Not posted again\. An earlier version was posted on GitHub/, name);
    const section = renderInspectorFindings([finding("f", "major", over)], { budgetBytes: 8_000 });
    assert.doesNotMatch(section.text, /only copy/, name);
  }
  // A legacy-unknown row is reachable only once resolved, and says it is unknown, never "only copy".
  const unknown = inspectorFindingPostedLine(
    finding("f", "major", { status: "resolved", postedAt: null, legacyPosted: "unknown" }),
  );
  assert.match(unknown, /^Not known whether this was posted on GitHub/);
});

// The two refusal markers. A refused draft is still not on GitHub, so the session must
// read that, and why: from the first refusal, not only once the cap stops it being offered.
const REASON = "Line could not be resolved (HTTP 422)";
const neverPosted: Partial<InspectorComment> = { status: "drafted", postedAt: null, githubUrl: null };

test("a draft GitHub refused once or twice says how many times and why, and that it comes back", () => {
  const cases: Array<[number, string]> = [
    [1, `Not posted yet. GitHub refused it 1 time: ${REASON}. Mission Control offers it again on the next push.`],
    [2, `Not posted yet. GitHub refused it 2 times: ${REASON}. Mission Control offers it again on the next push.`],
  ];
  for (const [refusals, line] of cases) {
    const over = { ...neverPosted, postRefusals: refusals, lastPostError: REASON };
    assert.equal(inspectorFindingPostedLine(finding("f", "major", over)), line);
    const section = renderInspectorFindings([finding("f", "major", over)], { budgetBytes: 8_000 });
    assert.ok(section.text.split("\n").includes(line), `refused ${refusals}: the section carries its marker`);
  }
});

test("a draft refused 3 times reads refused, with no promise of another try", () => {
  const over = { ...neverPosted, postRefusals: 3, lastPostError: REASON };
  const line = `Not posted. GitHub refused it 3 times: ${REASON}`;
  assert.equal(inspectorFindingPostedLine(finding("f", "major", over)), line);
  const section = renderInspectorFindings([finding("f", "major", over)], { budgetBytes: 8_000 });
  assert.ok(section.text.split("\n").includes(line));
  assert.doesNotMatch(section.text, /offers it again/);
});

test("a refusal line keeps a posted earlier version's link and tolerates a missing reason", () => {
  const earlier = "https://github.com/owner/repo/pull/7#discussion_r1";
  assert.equal(
    inspectorFindingPostedLine(finding("f", "major", {
      status: "drafted", postedAt: 500, githubUrl: earlier, postRefusals: 3, lastPostError: REASON,
    })),
    `Not posted. GitHub refused it 3 times: ${REASON}. An earlier version was posted on GitHub: ${earlier}`,
  );
  assert.equal(
    inspectorFindingPostedLine(finding("f", "major", { ...neverPosted, postRefusals: 1, lastPostError: null })),
    "Not posted yet. GitHub refused it 1 time. Mission Control offers it again on the next push.",
  );
  // A reason ending in a full stop does not double it.
  assert.equal(
    inspectorFindingPostedLine(finding("f", "major", { ...neverPosted, postRefusals: 3, lastPostError: "Bad anchor." })),
    "Not posted. GitHub refused it 3 times: Bad anchor",
  );
});

test("the refusal reason is a bounded packet field", () => {
  const limit = WORKFLOW_LIMITS.feedbackFieldBytes;
  const over = { ...neverPosted, postRefusals: 3, lastPostError: `${"r".repeat(limit)}s` };
  const section = renderInspectorFindings([finding("f", "major", over)], { budgetBytes: 100_000 });
  assert.equal(section.truncated, true);
  assert.ok(section.text.split("\n").includes(`Not posted. GitHub refused it 3 times: ${"r".repeat(limit)}`));
  assert.equal(section.text.includes(`${"r".repeat(limit)}s`), false);
});

test("each finding keeps today's shape, dedupe and severity order", () => {
  const rows = [
    finding("minor", "minor"),
    finding("blocker", "blocker", { path: "z.ts" }),
    finding("major", "major"),
    finding("nit", "nit", { path: null, line: null, body: null }),
    finding("major", "major", { title: "a duplicate of the same fingerprint" }),
  ];
  // Caller order never decides which duplicate is kept, so a frozen packet cannot drift.
  const first = renderInspectorFindings(rows, { budgetBytes: 8_000 });
  const second = renderInspectorFindings([...rows].reverse(), { budgetBytes: 8_000 });
  assert.equal(first.text, second.text);
  assert.deepEqual([first.shown, first.omitted, first.truncated], [4, 0, false]);
  assert.equal(first.text.match(/Fingerprint: major/g)?.length, 1);
  assert.equal(first.text.match(/^## MAJOR/gm)?.length, 1);
  const headings = first.text.split("\n").filter((line) => line.startsWith("## "))
    .map((line) => line.split(" - ")[0]);
  assert.deepEqual(headings, ["## BLOCKER", "## MAJOR", "## MINOR", "## NIT"]);
  assert.ok(first.text.startsWith([
    "## BLOCKER - blocker blocker",
    "Location: z.ts:12",
    "Posted on GitHub: https://github.com/owner/repo/pull/7#discussion_rblocker",
    "blocker detail for blocker",
    "Fingerprint: blocker",
    "",
    "## MAJOR",
  ].join("\n")));
  assert.match(first.text, /Location: general\nPosted on GitHub in the review summary: \S+\nLegacy finding detail is unavailable/);
  assert.doesNotMatch(first.text, /more unresolved finding/);
});

test("fields still clip at the per-field limit, and the finding stays whole", () => {
  const huge = "ø".repeat(10_000);
  const section = renderInspectorFindings(
    [finding("huge", "major", { body: huge }), finding("small", "minor")],
    { budgetBytes: 20_000 },
  );
  assert.equal(section.truncated, true);
  assert.deepEqual([section.shown, section.omitted], [2, 0]);
  const body = section.text.split("\n").find((line) => line.startsWith("ø"))!;
  assert.equal(bytes(body), WORKFLOW_LIMITS.feedbackFieldBytes);
  assert.match(section.text, /Fingerprint: huge/);
  assert.match(section.text, /Fingerprint: small/);
});

// Each field is bounded on its own, so each is driven on its own: removing the clip from any
// one of them fails its row. The exact limit must pass through untouched and unflagged; one
// byte over must clip back to the limit and set `truncated`.
test("each bounded field clips at exactly the per-field limit", () => {
  const limit = WORKFLOW_LIMITS.feedbackFieldBytes;
  const fields: Array<{
    name: string;
    over: (value: string) => Partial<InspectorComment>;
    prefix: string;
  }> = [
    { name: "title", over: (value) => ({ title: value }), prefix: "## MAJOR - " },
    // No line, so the location is the path alone and the whole field is the path.
    { name: "location", over: (value) => ({ path: value, line: null }), prefix: "Location: " },
    { name: "link", over: (value) => ({ githubUrl: value }), prefix: "Posted on GitHub: " },
    { name: "body", over: (value) => ({ body: value }), prefix: "" },
  ];
  for (const { name, over, prefix } of fields) {
    const atLimit = "a".repeat(limit);
    const exact = renderInspectorFindings([finding("f", "major", over(atLimit))], { budgetBytes: 100_000 });
    assert.equal(exact.truncated, false, `${name}: a value at exactly the limit was flagged`);
    assert.ok(exact.text.split("\n").includes(`${prefix}${atLimit}`), `${name}: a value at the limit was altered`);

    const oneOver = renderInspectorFindings([finding("f", "major", over(`${atLimit}b`))], { budgetBytes: 100_000 });
    assert.equal(oneOver.truncated, true, `${name}: one byte over the limit was not flagged`);
    const lines = oneOver.text.split("\n");
    assert.ok(lines.includes(`${prefix}${atLimit}`), `${name}: one byte over was not clipped back to the limit`);
    assert.equal(oneOver.text.includes(`${atLimit}b`), false, `${name}: the byte over the limit survived`);
    assert.deepEqual([oneOver.shown, oneOver.omitted], [1, 0]);
    assert.equal(lines.at(-1), "Fingerprint: f", `${name}: the clipped finding lost its fingerprint`);
  }
});

test("past the budget whole findings drop from the tail, lowest severity first, and are counted", () => {
  const severities = ["nit", "blocker", "minor", "major"] as const;
  const rows = Array.from({ length: 12 }, (_, index) =>
    finding(`f${String(index).padStart(2, "0")}`, severities[index % 4], { body: "d".repeat(400) }));
  const all = renderInspectorFindings(rows, { budgetBytes: 100_000 });
  const budgetBytes = Math.floor(bytes(all.text) / 2);
  const section = renderInspectorFindings(rows, { budgetBytes });

  assert.ok(bytes(section.text) <= budgetBytes);
  assert.ok(section.shown > 0 && section.omitted > 0);
  assert.equal(section.shown + section.omitted, 12);
  assert.equal(section.truncated, false, "no field was clipped to make room");
  // Every listed finding is complete; every left-out one is wholly absent.
  const shownFingerprints = [...section.text.matchAll(/^Fingerprint: (\S+)$/gm)].map((match) => match[1]);
  assert.equal(shownFingerprints.length, section.shown);
  assert.equal(section.text.match(/^## /gm)?.length, section.shown);
  assert.equal(section.text.match(/d{400}/g)?.length, section.shown);
  // The kept set is the head of the severity order, so whatever was dropped ranks no higher.
  const rank = { blocker: 0, major: 1, minor: 2, nit: 3 };
  const kept = rows.filter((row) => shownFingerprints.includes(row.fingerprint));
  const dropped = rows.filter((row) => !shownFingerprints.includes(row.fingerprint));
  const worstKept = Math.max(...kept.map((row) => rank[row.severity]));
  const bestDropped = Math.min(...dropped.map((row) => rank[row.severity]));
  assert.ok(worstKept <= bestDropped, "a higher-severity finding was dropped before a lower one");
  assert.ok(dropped.some((row) => row.severity === "nit"));
  assert.ok(kept.some((row) => row.severity === "blocker"));
  assert.ok(section.text.endsWith(`\n\n${omittedFindingsLine(section.omitted, section.shown)}`));
  assert.match(
    omittedFindingsLine(section.omitted, section.shown),
    new RegExp(`^${section.omitted} more unresolved findings are not listed here, to keep this message short\\. They stay open and come back in the next relay\\.$`),
  );
});

test("the omitted count reads in the singular for one finding", () => {
  const rows = [finding("a", "major"), finding("b", "nit")];
  const both = renderInspectorFindings(rows, { budgetBytes: 100_000 });
  const firstOnly = bytes(both.text.split("\n\n")[0]!);
  const section = renderInspectorFindings(rows, {
    budgetBytes: firstOnly + 2 + bytes(omittedFindingsLine(1, 1)),
  });
  assert.deepEqual([section.shown, section.omitted], [1, 1]);
  assert.ok(section.text.endsWith(
    "1 more unresolved finding is not listed here, to keep this message short. It stays open and comes back in the next relay.",
  ));
  assert.doesNotMatch(section.text, /Fingerprint: b/);
});

test("a first finding too large for the budget is dropped whole and counted, never cut", () => {
  const rows = [finding("top", "blocker", { body: "b".repeat(3_000) }), finding("next", "minor")];
  const section = renderInspectorFindings(rows, { budgetBytes: 600 });
  // The small minor finding would fit, but listing it while the blocker is dropped would
  // drop a higher severity before a lower one.
  assert.deepEqual(section, {
    text: "2 unresolved findings are not listed here, because not even the first fits in this message whole. They stay open.",
    shown: 0,
    omitted: 2,
    truncated: false,
  });
  assert.equal(
    renderInspectorFindings([rows[0]!], { budgetBytes: 600 }).text,
    "1 unresolved finding is not listed here, because it does not fit in this message whole. It stays open.",
  );

  const nothing = renderInspectorFindings(rows, { budgetBytes: 10 });
  assert.deepEqual(nothing, { text: "", shown: 0, omitted: 2, truncated: true });
  assert.deepEqual(renderInspectorFindings([], { budgetBytes: 100 }), {
    text: "",
    shown: 0,
    omitted: 0,
    truncated: false,
  });
});

// A reserve the caller spends only when the section comes back truncated, such as a packet's
// truncation notice: an unclipped listing may use the whole budget, a clipped one must leave
// the reserve free.
test("the truncation reserve applies only to a listing with a clipped field", () => {
  const reserve = 50;
  const plain = [finding("p", "major")];
  const plainBytes = bytes(renderInspectorFindings(plain, { budgetBytes: 100_000 }).text);
  const atBudget = renderInspectorFindings(plain, { budgetBytes: plainBytes, truncationReserveBytes: reserve });
  assert.deepEqual([atBudget.shown, atBudget.truncated], [1, false], "an unclipped finding paid the reserve");

  const clipped = [finding("c", "major", { title: "t".repeat(WORKFLOW_LIMITS.feedbackFieldBytes + 1) })];
  const clippedBytes = bytes(renderInspectorFindings(clipped, { budgetBytes: 100_000 }).text);
  const withRoom = renderInspectorFindings(clipped, {
    budgetBytes: clippedBytes + reserve,
    truncationReserveBytes: reserve,
  });
  assert.deepEqual([withRoom.shown, withRoom.truncated], [1, true]);
  const short = renderInspectorFindings(clipped, {
    budgetBytes: clippedBytes + reserve - 1,
    truncationReserveBytes: reserve,
  });
  assert.equal(short.shown, 0, "a clipped finding was listed without room for the reserve");
  assert.equal(short.truncated, false, "the count line alone needs no reserve");
});

// Two rows for one fingerprint that differ only in what `findingPublication` reads would
// otherwise tie, and input order would decide whether the packet says "Posted" or "only copy".
test("duplicate selection does not depend on input order when only posting state differs", () => {
  const posted = finding("dup", "major", {
    status: "open",
    postedAt: 1_000,
    githubUrl: "https://github.com/owner/repo/pull/7#discussion_r1",
  });
  const variants: Array<Partial<InspectorComment>> = [
    { status: "drafted", postedAt: null, githubUrl: null },
    { postedAt: null },
    { githubUrl: null },
    { status: "resolved", postedAt: null, githubUrl: null, legacyPosted: "unknown" },
    { postedAt: undefined, legacyPosted: undefined },
  ];
  for (const over of variants) {
    const other = { ...posted, ...over };
    const forward = renderInspectorFindings([posted, other], { budgetBytes: 8_000 });
    const reverse = renderInspectorFindings([other, posted], { budgetBytes: 8_000 });
    assert.equal(forward.text, reverse.text, `order decided the marker for ${JSON.stringify(over)}`);
    assert.equal(forward.shown, 1);
  }
});

// The reservation a caller makes before sizing its header: at exactly this budget the count
// is stated, and one byte less is the only way to lose it. It counts deduplicated findings.
test("the minimum budget always states the count of every finding", () => {
  const rows = [
    finding("a", "blocker", { body: "a".repeat(3_000) }),
    finding("b", "major", { body: "b".repeat(3_000) }),
    finding("b", "major", { title: "a duplicate fingerprint" }),
  ];
  const minimum = inspectorFindingsMinimumBytes(rows);
  const line = "2 unresolved findings are not listed here, because not even the first fits in this message whole. They stay open.";
  assert.equal(minimum, bytes(line));
  assert.deepEqual(renderInspectorFindings(rows, { budgetBytes: minimum }), {
    text: line,
    shown: 0,
    omitted: 2,
    truncated: false,
  });
  assert.equal(renderInspectorFindings(rows, { budgetBytes: minimum - 1 }).text, "");
  assert.equal(inspectorFindingsMinimumBytes([]), 0);
});

// The property behind every budget case above, swept over every budget from nothing to
// everything: a listed finding is always whole (heading, location, posted marker, body and
// fingerprint), and every finding is either listed or counted.
test("at every budget, each listed finding is whole and the rest are counted", () => {
  const rows = [
    finding("a", "blocker", { body: "a".repeat(120) }),
    finding("b", "major", { status: "drafted", postedAt: null, githubUrl: null }),
    finding("c", "minor", { line: null, githubUrl: "https://github.com/owner/repo/pull/7#pullrequestreview-1" }),
  ];
  const full = bytes(renderInspectorFindings(rows, { budgetBytes: 100_000 }).text);
  for (let budgetBytes = 0; budgetBytes <= full; budgetBytes += 1) {
    const section = renderInspectorFindings(rows, { budgetBytes });
    assert.ok(bytes(section.text) <= budgetBytes, `budget ${budgetBytes}: over budget`);
    assert.equal(section.shown + section.omitted, 3, `budget ${budgetBytes}: a finding vanished`);
    const blocks = section.text.split("\n\n").filter((block) => block.startsWith("## "));
    assert.equal(blocks.length, section.shown, `budget ${budgetBytes}: a fragment was listed`);
    for (const block of blocks) {
      const lines = block.split("\n");
      assert.equal(lines.length, 5, `budget ${budgetBytes}: an incomplete finding:\n${block}`);
      assert.match(lines[1]!, /^Location: /);
      assert.match(lines[2]!, /^(Posted on GitHub|Not posted|Being posted)/);
      assert.match(lines[4]!, /^Fingerprint: [abc]$/);
    }
    if (section.omitted > 0 && section.text) {
      assert.ok(section.text.endsWith(omittedFindingsLine(section.omitted, section.shown)));
    }
  }
});

// Distinct from the packet-level control test in `workflow-security.test.ts`: a caller such
// as Foreman's relay, once it adopts the renderer, types this section without
// `finalizePacket`, so the section must be safe on its own.
test("the section is sanitized for a terminal before it is measured", () => {
  const section = renderInspectorFindings([
    finding("ctl", "major", {
      title: "Fix\u001b[2Jtitle",
      body: "Body\u0000with\u009fcontrols\r\nand\ttabs",
      githubUrl: "https://github.com/owner/repo/pull/7#discussion_r1\u0007",
    }),
  ], { budgetBytes: 8_000 });
  const forbidden = [...section.text].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x09
      || (codePoint >= 0x0b && codePoint <= 0x1f)
      || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
  assert.equal(forbidden, false);
  assert.match(section.text, /Bodywithcontrols\nand  tabs/);
});

// Foreman's worker talks to the daemon over HTTP and never touches SQLite, and its relay is
// to adopt this renderer. If this module ever reaches the database or a network client,
// that adoption would load it too.
test("the renderer's import graph reaches no database or network module", () => {
  const entry = join(repoRoot, "src/server/inspector/findings-text.ts");
  const seen = new Set<string>();
  const external = new Set<string>();
  const queue = [entry];
  const specifiers = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(specifiers)) {
      const specifier = match[1] ?? match[2] ?? match[3]!;
      let target: string | null = null;
      if (specifier.startsWith("@shared/")) target = join(repoRoot, "src/shared", specifier.slice(8));
      else if (specifier.startsWith(".")) target = resolve(dirname(file), specifier);
      if (!target) {
        external.add(specifier);
        continue;
      }
      const candidates = [target, target.replace(/\.js$/, ".ts"), `${target}.ts`];
      const found = candidates.find((candidate) => existsSync(candidate) && candidate.match(/\.(ts|mjs|js)$/));
      assert.ok(found, `unresolved import ${specifier} in ${relative(repoRoot, file)}`);
      queue.push(found);
    }
  }
  const local = [...seen].map((file) => relative(repoRoot, file)).sort();
  const outsideShared = local.filter((file) => !file.startsWith("src/shared/"));
  assert.deepEqual(outsideShared, [
    "src/server/inspector/findings-text.ts",
    "src/server/util/utf8.ts",
    "src/server/workflows/packet-text.ts",
  ]);
  // An allowlist, not a denylist: a new package or built-in (`better-sqlite3`, `undici`,
  // `node:http`, ...) fails here until someone decides it is safe for Foreman to load.
  // `node:string_decoder` cuts UTF-8 on a character boundary; `zod` is the shared schemas'.
  assert.deepEqual([...external].sort(), ["node:string_decoder", "zod"]);
});
