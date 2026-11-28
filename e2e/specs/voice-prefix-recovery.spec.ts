import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";
import { say } from "../fixtures/voice.ts";
import { captureCard, runningAgent, setupCards } from "../fixtures/voice-cards.ts";
import { openVoiceTab } from "../fixtures/voice-settings.ts";
import { prefixPlaylist, type PrefixWindow } from "../fixtures/voice-prefix-fixtures.ts";
import {
  PREFIX_AUDIO_ROSTER, PREFIX_HOLDOUT_CASES, PREFIX_SCOUT_CASES, UNSAFE_SCORES, scorePrefixOutcome,
  type PrefixAudioCase, type PrefixOutcome, type PrefixScore,
} from "../../test/fixtures/voice-prefix-corpus.ts";

const FLAG = "voice-prefix-recovery";
const execute = promisify(execFile);

async function setFlag(daemon: DaemonHandle, enabled: boolean) {
  const response = await fetch(daemon.baseURL + "/api/feature-flags", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "flag", id: FLAG, enabled }),
  });
  expect(response.ok).toBe(true);
}

interface Heard {
  id: string; time: number; text: string; matchedName: string | null; rule: string; outcome: string; detail: string;
  prefix?: string; suggested?: string[];
}

async function heard(page: Page, daemon: DaemonHandle): Promise<Heard[]> {
  return (await (await page.request.get(daemon.baseURL + "/api/voice/heard")).json()).entries;
}

test("prefix recovery is an off-by-default preview: with it on, a filler before the call sign routes, an unclear word asks, a mention stays unrouted and Uh, cancel cancels",
  async ({ dashboard: page, daemon }) => {
    await setupCards(page, daemon, 30);
    for (const name of ["Steve", "Luna"]) await runningAgent(page, daemon, name);
    await openVoiceTab(page, "Recently heard", daemon.baseURL);
    const table = page.getByRole("region", { name: "Recently heard" });
    const row = (text: string) => table.getByRole("row").filter({ has: page.getByRole("cell", { name: text, exact: true }) });

    await test.step("off: the filler leaves the address unrouted, as it does today", async () => {
      await say(daemon, "Um, Steve, check the build.");
      await expect(row("Um, Steve, check the build.")).toContainText("no opening name");
      await expect(row("Um, Steve, check the build.")).toContainText("Not routed");
    });

    await page.goto(daemon.baseURL + "/#/settings/feature-flags");
    await page.getByRole("textbox", { name: "Filter feature flags" }).fill("call sign");
    const toggle = page.getByRole("button", { name: /^Voice prefix recovery:/ });
    await expect(toggle).toHaveAccessibleName("Voice prefix recovery: off");
    await expect(page.getByText(/When a stray word comes before the call sign/)).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAccessibleName("Voice prefix recovery: on");
    await page.goto(daemon.baseURL + "/#/fleet");

    await test.step("on: a known filler and a delimited exact name route to that agent, without the filler", async () => {
      await say(daemon, "Um, Steve, check the build.", { id: "recovered" });
      const card = page.getByRole("status").filter({ hasText: "check the build." }).filter({ hasText: "Steve" });
      await expect(card.getByRole("button", { name: "Send now", exact: true })).toBeVisible();
      await expect(card).not.toContainText("Um");
      await captureCard(card, "prefix-recovered");
      await test.step("Uh, cancel withdraws it", async () => {
        await say(daemon, "Uh, cancel.");
        await expect(page.getByRole("status").filter({ hasText: "Cancelled" })).toBeVisible();
      });
    });

    await test.step("on: an unknown word before the name asks who it is for and sends only after a pick", async () => {
      await say(daemon, "Fish. Steve, check the build.", { id: "suggested" });
      const unsure = page.getByRole("status").filter({ hasText: "Who is this for?" });
      await expect(unsure).toContainText("Not sent: something came before the name.");
      await expect(unsure.locator("s")).toHaveText("Fish. ");
      await expect(unsure.locator("u")).toHaveText("Steve,");
      await expect(unsure.getByRole("button", { name: /Steve/ })).toBeVisible();
      await expect(unsure.getByRole("button", { name: /Luna/ })).toHaveCount(0);
      await page.mouse.move(0, 0);
      await captureCard(unsure, "prefix-suggested");
      await unsure.getByRole("button", { name: /Steve/ }).click();
      const card = page.getByRole("status").filter({ hasText: "check the build." }).filter({ hasText: "Steve" });
      await expect(card.getByRole("button", { name: "Send now", exact: true })).toBeVisible();
      await card.getByRole("button", { name: "Cancel", exact: true }).click();
    });

    await test.step("on: two names after a filler offer both, and a mention is left alone", async () => {
      await say(daemon, "Um, Steve and Luna, check the build.");
      const unsure = page.getByRole("status").filter({ hasText: "Who is this for?" }).filter({ hasText: "Steve and Luna" });
      await expect(unsure.getByRole("button", { name: /Steve/ })).toBeVisible();
      await expect(unsure.getByRole("button", { name: /Luna/ })).toBeVisible();
      await unsure.getByRole("button", { name: "Cancel", exact: true }).click();
      await say(daemon, "So Steve said the build is fine.");
    });

    await openVoiceTab(page, "Recently heard", daemon.baseURL);
    await expect(row("Um, Steve, check the build.").filter({ hasText: "name after a filler" }).getByRole("cell", { name: "Steve, after “Um”" })).toBeVisible();
    await expect(row("Um, Steve, check the build.").filter({ hasText: "name after a filler" }).locator("mark")).toHaveText("Steve");
    await expect(row("Fish. Steve, check the build.")).toContainText("possible name after another word");
    await expect(row("Um, Steve and Luna, check the build.").getByRole("cell", { name: "Asked: Steve or Luna" })).toBeVisible();
    await expect(row("Uh, cancel.")).toContainText("spoken cancel");
    await expect(row("So Steve said the build is fine.")).toContainText("no opening name");
    await expect(row("So Steve said the build is fine.")).toContainText("Not routed");
    await captureCard(table, "prefix-recently-heard");
  });

/** What one heard entry did, in the corpus's terms. */
function outcomeOf(entry: Heard): PrefixOutcome {
  if (entry.outcome === "control") return entry.rule === "cancel" && entry.detail ? "cancelled" : "control";
  if (entry.rule === "suggested-prefix") return `ask:${(entry.suggested ?? []).join("/")}`;
  // The opening rule's own ambiguous name: a who card whose rows the history does not record.
  if (entry.rule === "ambiguous-name") return "ask:?";
  // A later name asks split or mention with the first target fixed: the address itself is settled.
  if (["exact", "phonetic", "recovered-prefix", "second-name", "picked"].includes(entry.rule) && entry.matchedName) return `route:${entry.matchedName}`;
  return "drop";
}

/** The production Swift listener loop, fed the playlist at microphone callback pace into this daemon. */
async function nativeListener(daemon: DaemonHandle, models: string, wav: string): Promise<number> {
  const { stdout } = await execute("swift", ["test", "-c", "release", "--package-path", "native/voice-listener",
    "--filter", "ContinuousSpeechTests.testContinuousDesktopCapture"], {
    env: { ...process.env, MISSION_LONG_VOICE_NATURAL: "1", MISSION_LONG_VOICE_HELD: "0", MISSION_LONG_VOICE_WAV: wav,
      MISSION_VOICE_MODEL_DIR: models, MISSION_VOICE_LISTENER_INSTANCE: "desktop-cpu", MISSION_VOICE_DAEMON_URL: daemon.baseURL,
      MISSION_VOICE_TOKEN_FILE: join(daemon.home, "token") }, timeout: 1_200_000, maxBuffer: 16 * 1024 * 1024,
  });
  const fedAt = Number(stdout.match(/feed started at Unix ms (\d+)/u)?.[1]);
  expect(fedAt, stdout).toBeGreaterThan(0);
  return fedAt;
}

interface Row {
  id: string; category: string; gold: string; said: string; heard: string[]; rules: string[];
  /** The Recently heard entries scored for this case, by ID. */
  entryIds: string[];
  outcome: PrefixOutcome; score: PrefixScore; extra: PrefixOutcome[];
}

function score(windows: PrefixWindow[], entries: Heard[], fedAt: number): Row[] {
  return windows.map(window => {
    // An entry is dated by its speech onset; noise before the speech can open the phrase a little earlier.
    const inside = entries.filter(entry => entry.time - fedAt >= window.startMs - 300 && entry.time - fedAt < window.endMs - 300);
    const outcomes = inside.map(outcomeOf);
    const decisive = outcomes.find(outcome => outcome !== "drop") ?? "drop";
    return { id: window.case.id, category: window.case.category, gold: window.case.gold, said: window.case.text,
      heard: inside.map(entry => entry.text), rules: inside.map(entry => entry.rule), entryIds: inside.map(entry => entry.id), outcome: decisive,
      score: scorePrefixOutcome(window.case.gold, decisive),
      extra: outcomes.filter((outcome, index) => outcome !== "drop" && index !== outcomes.indexOf(decisive)) };
  });
}

function summarize(rows: Row[]) {
  const count = (filter: (row: Row) => boolean) => rows.filter(filter).length;
  const prefixed = rows.filter(row => row.gold.startsWith("route:") && !["clean", "control"].includes(row.category));
  return {
    cases: rows.length,
    prefixedAddresses: prefixed.length,
    recovered: prefixed.filter(row => row.score === "routed").length,
    asked: prefixed.filter(row => row.score === "asked").length,
    dropped: prefixed.filter(row => row.score === "dropped").length,
    wrongRecipients: count(row => row.score === "wrong-recipient"),
    unintendedSends: count(row => row.score === "unintended-send" || row.score === "unintended-control"),
    silentGuesses: count(row => row.score === "silent-guess"),
    needlessAsks: count(row => row.score === "needless-ask"),
    extraActions: count(row => row.extra.some(outcome => outcome !== "drop")),
    byScore: Object.fromEntries([...new Set(rows.map(row => row.score))].map(key => [key, count(row => row.score === key)])),
  };
}

test("native Always-on audio through recognition and the router: prefix recovery on the scout's set and an independent holdout, flag off then on",
  async ({ dashboard: page, daemon }) => {
    const models = process.env.MISSION_LONG_VOICE_MODELS;
    test.skip(process.platform !== "darwin" || !models, "Requires installed macOS FluidAudio models");
    test.setTimeout(5_400_000);
    // The operator's consented recording from the first-preview hold (docs/voice.md), if supplied. Never committed.
    const human = process.env.MISSION_PREFIX_RECOVERY_HUMAN_WAV ?? process.env.MISSION_PREVIEW_HOLD_HUMAN_WAV;
    const sets = (process.env.MISSION_PREFIX_RECOVERY_SETS ?? "dev,holdout").split(",");
    const variants = (process.env.MISSION_PREFIX_RECOVERY_VARIANTS ?? "off,on").split(",") as ("off" | "on")[];
    await setupCards(page, daemon, 12);
    expect((await page.request.put(daemon.baseURL + "/api/voice/config", {
      data: { endOfSpeechMs: 2000, listeningMode: "always-on", transcriptWords: 100, showTranscript: true },
    })).ok()).toBe(true);
    for (const name of PREFIX_AUDIO_ROSTER) await runningAgent(page, daemon, name);
    await page.goto(daemon.baseURL + "/#/fleet");
    const report: Record<string, unknown> = { roster: PREFIX_AUDIO_ROSTER, human: !!human };
    // Counts, labels and recognized text only, never audio. Rewritten after every pass, so a long run can be read early.
    const dir = artifactsDir("voice-prefix-recovery");
    mkdirSync(dir, { recursive: true });
    const out = join(dir, `audio-${Date.now()}.json`);
    let first = true;
    const results: Record<string, Partial<Record<"off" | "on", Row[]>>> = {};
    const unmatchedByRun: Record<string, { id: string; text: string; rule: string; outcome: PrefixOutcome; ms: number }[]> = {};
    for (const set of sets) {
      const cases: readonly PrefixAudioCase[] = set === "dev" ? PREFIX_SCOUT_CASES : PREFIX_HOLDOUT_CASES;
      const playlist = prefixPlaylist(daemon.home, set, cases, human);
      results[set] = {};
      for (const variant of variants) {
        await setFlag(daemon, variant === "on");
        if (!first) {
          // The previous listener process has exited; let its hello lapse so the next one may take capture.
          await expect.poll(async () => (await (await page.request.get(daemon.baseURL + "/api/voice/mute")).json()).state.mode,
            { timeout: 60_000 }).toBe("unavailable");
        }
        first = false;
        const known = new Set((await heard(page, daemon)).map(entry => entry.id));
        // Recently heard keeps only the 50 newest captures, fewer than a playlist has, so collect them as they arrive.
        const seen = new Map<string, Heard>();
        const collect = async () => { for (const entry of await heard(page, daemon)) if (!known.has(entry.id)) seen.set(entry.id, entry); };
        let playing = true;
        const collecting = (async () => { while (playing) { await collect(); await new Promise(resolve => setTimeout(resolve, 1000)); } })();
        let fedAt: number;
        try {
          fedAt = await nativeListener(daemon, models!, playlist.wav);
          await expect.poll(async () => (await heard(page, daemon)).filter(entry => !known.has(entry.id) && entry.outcome === "pending").length,
            { timeout: 60_000 }).toBe(0);
        } finally {
          playing = false;
          await collecting;
        }
        await collect();
        const entries = [...seen.values()].toSorted((a, b) => a.time - b.time);
        // Clear every card this run left asking, so the next run's Cancel cannot reach it.
        for (const entry of entries.filter(e => e.outcome === "unsure" || e.outcome === "resolving")) {
          await page.request.post(`${daemon.baseURL}/api/voice/cards/${encodeURIComponent(entry.id)}/cancel`);
        }
        const rows = score(playlist.windows, entries, fedAt);
        results[set]![variant] = rows;
        // Every heard entry is either scored in a case's window or accounted for here, by ID: one in the lead-in,
        // the tail or between windows could otherwise act unseen.
        const scored = new Set(rows.flatMap(row => row.entryIds));
        const unmatched = entries.filter(entry => !scored.has(entry.id))
          .map(entry => ({ id: entry.id, text: entry.text, rule: entry.rule, outcome: outcomeOf(entry), ms: entry.time - fedAt }));
        unmatchedByRun[`${set}-${variant}`] = unmatched;
        report[`${set}-${variant}`] = { summary: summarize(rows), skipped: playlist.skipped, rows, unmatched };
        writeFileSync(out, JSON.stringify(report, null, 1));
      }
    }
    console.log(`Prefix recovery audio report: ${out}`);
    for (const set of sets) {
      const { off, on } = results[set]!;
      if (!on) continue;
      console.log(set, JSON.stringify(summarize(on)));
      // The bar for recommending default enablement, absolute rather than relative to the flag off: with the flag on
      // nothing goes to the wrong agent, nothing is sent or cancelled that nobody addressed, and no second action
      // in a case's window routes anything beyond the one scored.
      const { wrongRecipients, unintendedSends } = summarize(on);
      expect({ wrongRecipients, unintendedSends }, `${set}: unsafe sends with the flag on`).toEqual({ wrongRecipients: 0, unintendedSends: 0 });
      // A second entry in a case's window may only be dropped speech: no second route, ask, Cancel or control.
      expect(on.filter(row => row.extra.length > 0).map(row => ({ id: row.id, extra: row.extra })),
        `${set}: extra actions with the flag on`).toEqual([]);
      // A spoken Cancel the router recognized as a Cancel must withdraw the card before it. One the recognizer
      // did not hear as a Cancel ("Uh, cancel." as "Uh can see what") is a recognition miss, the same with
      // the flag off, and is checked by the flag-off comparison below.
      expect(on.filter(row => row.gold === "cancel" && row.rules.some(rule => rule === "cancel" || rule === "nothing-pending") && row.score !== "control")
        .map(row => ({ id: row.id, heard: row.heard, rules: row.rules })), `${set}: recognized Cancels that withdrew nothing`).toEqual([]);
      // Nothing outside the scored windows may act either: no route, ask, Cancel or other control.
      expect(unmatchedByRun[`${set}-on`]!.filter(entry => entry.outcome !== "drop"),
        `${set}: actions outside every case's window with the flag on`).toEqual([]);
      // The holdout was written after the rules: no silent guess there at all. The scout set keeps one the
      // opening rule already makes without a prefix ("Steve and Luna, check the build."), checked against the flag off below.
      if (set === "holdout") expect(on.filter(row => row.score === "silent-guess").map(row => row.id)).toEqual([]);
      if (!off) continue;
      // Recovery adds no unsafe outcome to the same audio...
      const unsafe = (rows: Row[]) => rows.filter(row => UNSAFE_SCORES.has(row.score)).map(row => row.id);
      expect(unsafe(on).filter(id => !unsafe(off).includes(id)), `${set}: unsafe with the flag on only`).toEqual([]);
      // ...and changes no route that works today, wherever the recognizer heard the same words.
      const changed = off.filter((row, i) => row.outcome !== "drop" && row.heard.join("|") === on[i]!.heard.join("|") && row.outcome !== on[i]!.outcome);
      expect(changed.map(row => row.id), `${set}: routes that changed`).toEqual([]);
    }
  });
