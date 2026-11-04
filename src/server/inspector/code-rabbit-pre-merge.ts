import { createHash } from "node:crypto";
import { parseFragment } from "parse5";
import type { CodeRabbitFinding } from "@shared/code-rabbit.ts";
import type { GhResult, IssueCommentSnapshot } from "./github.ts";

const START = "<!-- pre_merge_checks_walkthrough_start -->";
const END = "<!-- pre_merge_checks_walkthrough_end -->";
const label = (text: string) => text.replace(/<[^>]*>/g, "").replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim();
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Only the marked check section is semantic. Summary/review/checkbox edits do not re-arm it. */
export function preMergeFindings(comment: IssueCommentSnapshot): GhResult<Omit<CodeRabbitFinding, "generation">[]> {
  const start = comment.body.indexOf(START), end = comment.body.indexOf(END);
  if (start === -1 && end === -1) return { ok: true, value: [] };
  if (start === -1 || end < start || comment.body.indexOf(START, start + START.length) !== -1
    || comment.body.indexOf(END, end + END.length) !== -1) {
    return { ok: false, error: "Incomplete or repeated CodeRabbit pre-merge section" };
  }
  const section = comment.body.slice(start + START.length, end);
  const details = new Map<string, string>();
  const bodyRanges: [number, number][] = [];
  const nodes = [...parseFragment(section, { sourceCodeLocationInfo: true }).childNodes];
  while (nodes.length) {
    const node = nodes.pop()!;
    if (!("tagName" in node)) continue;
    nodes.push(...node.childNodes);
    if (node.tagName !== "summary") continue;
    const source = node.sourceCodeLocation;
    if (!source?.startTag) continue;
    const heading = label(section.slice(source.startTag.endOffset, source.endTag?.startOffset ?? source.endOffset));
    if (!/^Full details\s*:/i.test(heading)) continue;
    const parent = node.parentNode;
    if (!source.endTag || !parent || !("tagName" in parent) || parent.tagName !== "details"
      || !parent.sourceCodeLocation?.endTag) {
      return { ok: false, error: "Incomplete CodeRabbit pre-merge details" };
    }
    const name = heading.replace(/^Full details\s*:\s*/i, "");
    if (details.has(name)) return { ok: false, error: "Repeated CodeRabbit pre-merge details" };
    // Source locations preserve the entire body, including nested details and text after them.
    details.set(name, section.slice(source.endTag.endOffset, parent.sourceCodeLocation.endTag.startOffset).trim());
    bodyRanges.push([source.endTag.endOffset, parent.sourceCodeLocation.endTag.startOffset]);
  }
  if ((label(section).match(/\bFull details\s*:/gi)?.length ?? 0) !== details.size) {
    return { ok: false, error: "Unreadable CodeRabbit pre-merge details" };
  }
  const names = new Set<string>();
  const findings: Omit<CodeRabbitFinding, "generation">[] = [];
  // Keep detail content in the identity, but out of the check-table scan. Advancing
  // the cursor by the furthest end also handles overlapping or nested body ranges.
  let rowText = "", cursor = 0;
  for (const [from, to] of bodyRanges.sort((a, b) => a[0] - b[0])) {
    if (from > cursor) rowText += section.slice(cursor, from);
    cursor = Math.max(cursor, to);
  }
  rowText += section.slice(cursor);
  for (const line of rowText.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((cell) => cell.trim());
    const name = label(cells[0] ?? "");
    if (name.toLowerCase() === "check name" || cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    const status = cells[1]?.match(/!\[(Error|Warning|Failed|Passed|Skipped)\]\([^)]*\)|<img\b[^>]*\balt=["'](Error|Warning|Failed|Passed|Skipped)["'][^>]*>/i);
    if (!name || names.has(name) || cells.length < 3 || !status) {
      return { ok: false, error: "Unrecognized or repeated CodeRabbit pre-merge check" };
    }
    names.add(name);
    const state = (status[1] ?? status[2])!.toLowerCase();
    findings.push({
      id: `pre-merge:${comment.id}:${digest(name)}`, rootId: comment.id,
      url: comment.url, path: null, resolved: state === "passed" || state === "skipped",
      // Per-check content, including unabridged resolutions, owns change identity.
      identity: digest(JSON.stringify([name, state, cells.slice(2), details.get(name) ?? ""])),
    });
  }
  if ([...details.keys()].some((name) => !names.has(name))) {
    return { ok: false, error: "CodeRabbit pre-merge details do not match a check" };
  }
  return findings.length ? { ok: true, value: findings }
    : { ok: false, error: "No readable CodeRabbit pre-merge checks in marked section" };
}
