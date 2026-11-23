import { mergeLandedOnDefault } from "@shared/stacking.ts";
import { getInspectorPr, loadOpenInspectorPrs } from "../db.ts";
import { parsePrUrl } from "../inspector/github.ts";
import type { StackGitHub } from "./github.ts";
import { correctStackBase } from "./lineage.ts";

// What the PR poller asks of Stacked pull requests when it observes a merge.
//
// The poller and the Inspector tick are two loops on two clocks (20s and 90s). Before this,
// only the Inspector tick read a stacked pull request's base, so for up to its whole interval a
// child kept pointing at a parent branch that had just merged - long enough for a person to
// merge the child into that finished branch on GitHub - and the poller, which reads only state
// and merge time, then recorded that merge as the task's outcome. Both halves live here:
//
//  - `landing`: a stacked pull request's merge completes work only when it reached the
//    repository's default branch. Read through the stacking seam (one small GraphQL call that
//    names both the base and the default branch) and remembered, because a merged pull
//    request's base can never change again.
//  - `retargetChildren`: when the poller sees a parent merge, its open stacked children are
//    pointed at the default branch right then - unless that parent's own merge missed the
//    default branch, in which case `correctStackBase` leaves them where they are - through the same `correctStackBase` the
//    adoption-time correction uses, so `withRetarget`'s single-flight guard still holds. A
//    failure is left to the Inspector tick, which retries every tick and shows *Retarget
//    failed* with GitHub's reason.

/** Whether one merge reached the default branch, as far as GitHub could say. */
export type MergeLanding = "landed" | "stray" | "unknown";

/** What the poller needs from the Registry to tell a stacked pull request from any other. */
export interface StackedPrLookup {
  /**
   * Whether `url` is a stacked child: its Inspector row carries stack lineage, or it belongs to
   * a stacked task's primary repository. `taskId` names the task when the caller knows it.
   */
  isStackedTaskPr(url: string, taskId: string | null): boolean;
}

export class StackMergeWatch {
  /** Settled verdicts by lowercased URL. Only `landed` and `stray` are final. */
  private readonly verdicts = new Map<string, Exclude<MergeLanding, "unknown">>();
  /** `child key \0 parent url` pairs already retargeted from a merge observation. */
  private readonly retargeted = new Set<string>();

  /**
   * Whether a merged stacked pull request reached the default branch. `unknown` (GitHub could
   * not be read, or does not report the pull request merged yet) holds the merge for this tick
   * exactly as a merge with no reported instant is held: the next poll asks again.
   */
  async landing(url: string, cwd: string | null, github: StackGitHub): Promise<MergeLanding> {
    const key = url.toLowerCase();
    const known = this.verdicts.get(key);
    if (known) return known;
    const read = await github.prRefs(cwd, url);
    if (!read.ok || !read.value || read.value.state !== "MERGED") return "unknown";
    const landed = mergeLandedOnDefault(read.value.baseRefName, read.value.defaultBranch);
    if (landed === null) return "unknown";
    const verdict = landed ? "landed" : "stray";
    this.verdicts.set(key, verdict);
    if (verdict === "stray") {
      console.warn(`[pr] ${url} merged into ${read.value.baseRefName}, not ${read.value.defaultBranch}: its task stays open until its work reaches ${read.value.defaultBranch}`);
    }
    return verdict;
  }

  /**
   * True when this merge must not complete anything: a stacked pull request whose merge did
   * not (or cannot yet be shown to) reach the default branch. Every other pull request is
   * unchanged and answers false without a GitHub read.
   */
  async holds(url: string, cwd: string | null, taskId: string | null, lookup: StackedPrLookup, github: StackGitHub): Promise<boolean> {
    return (await this.held(url, cwd, taskId, lookup, github)) !== null;
  }

  /**
   * Why a merge is held, or null when it is not: `stray` when GitHub says it missed the
   * default branch, `unknown` while that cannot be read yet.
   */
  async held(url: string, cwd: string | null, taskId: string | null, lookup: StackedPrLookup, github: StackGitHub): Promise<Exclude<MergeLanding, "landed"> | null> {
    if (!lookup.isStackedTaskPr(url, taskId)) return null;
    const landing = await this.landing(url, cwd, github);
    return landing === "landed" ? null : landing;
  }

  /**
   * Point every open stacked child of a just-merged parent at the default branch now, rather
   * than on the next Inspector tick. Once per child and parent: a merge the poller keeps seeing
   * (a session chip stays `merged`) does not cost two GitHub reads per child every poll.
   */
  async retargetChildren(mergedUrls: Iterable<string>, github: StackGitHub, now: number): Promise<void> {
    const parents = new Set<string>();
    for (const url of mergedUrls) {
      const key = parsePrUrl(url)?.key.toLowerCase();
      if (key) parents.add(key);
    }
    if (parents.size === 0) return;
    for (const row of loadOpenInspectorPrs()) {
      const parentUrl = row.stack?.parentPrUrl;
      const parentKey = parentUrl ? parsePrUrl(parentUrl)?.key.toLowerCase() : undefined;
      if (!parentUrl || !parentKey || !parents.has(parentKey)) continue;
      const pair = `${row.key}\0${parentUrl}`;
      if (this.retargeted.has(pair)) continue;
      this.retargeted.add(pair);
      try {
        // Read again: the row may have retired or changed parent while earlier ones ran.
        if (getInspectorPr(row.key)?.stack?.parentPrUrl !== parentUrl) continue;
        await correctStackBase(row.key, github, now);
      } catch (error) {
        console.error("[pr] could not retarget a stacked child after its parent merged:", row.key, error);
      }
    }
  }
}
