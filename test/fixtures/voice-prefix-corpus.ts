// Labeled utterances for prefix recovery (`voice-prefix-recovery`), shared by the routing unit test
// and the native audio spec. Data and scoring only: no audio, nothing that reads the disk.
//
// The development set is the scout's written corpus ("Recovering a voice address after a noise
// or filler prefix", archived with its report), verbatim. The rules were shaped on it. The holdout
// was written afterwards, for this change, with other wording, other names, other voices and real
// or synthesized noise in place of a spoken noise word. Its labels say what the speaker meant.

/** `route:<name>` the speaker addressed that agent; `none` nobody; `ambiguous` the right action is to ask or drop; `cancel` a spoken Cancel of the card before it. */
export type PrefixGold = `route:${string}` | "none" | "ambiguous" | "control" | "cancel";

export interface PrefixCase {
  id: string;
  category: string;
  /** What is spoken. A noise case speaks only what follows its noise. */
  text: string;
  gold: PrefixGold;
}

/** The scout's invented roster. The holdout adds Carol and Max. */
export const PREFIX_SCOUT_ROSTER = ["Steve", "Will", "Willow", "Luna", "Atlas", "Nova", "Quinn", "Rowan", "Sage", "Release Captain"] as const;
export const PREFIX_AUDIO_ROSTER = [...PREFIX_SCOUT_ROSTER, "Carol", "Max"] as const;

/** The scout's 70 written cases, unchanged. Its noise cases spell the noise as a word. */
export const PREFIX_SCOUT_CASES: readonly PrefixCase[] = [
  { id: "c01", category: "control", text: "Steve, check the build.", gold: "route:Steve" },
  { id: "c02", category: "control", text: "Will you grab the door?", gold: "route:Will" },
  { id: "c03", category: "control", text: "Please ask Will to check the build.", gold: "none" },
  { id: "c04", category: "control", text: "Release Captain, tag the release.", gold: "route:Release Captain" },
  { id: "c05", category: "control", text: "Cancel.", gold: "control" },
  { id: "c06", category: "control", text: "Luna, ask Steve about the build.", gold: "route:Luna" },
  { id: "c07", category: "control", text: "Steve, check the build, and Luna, run the tests.", gold: "route:Steve" },
  { id: "c08", category: "control", text: "Steve and Luna, check the build.", gold: "ambiguous" },
  { id: "f01", category: "filler", text: "Um, Steve, check the build.", gold: "route:Steve" },
  { id: "f02", category: "filler", text: "Uh Steve, check the build.", gold: "route:Steve" },
  { id: "f03", category: "filler", text: "Uh, Luna, run the tests.", gold: "route:Luna" },
  { id: "f04", category: "filler", text: "Hmm. Atlas, deploy staging.", gold: "route:Atlas" },
  { id: "f05", category: "filler", text: "Mm, Nova, summarize the pull request.", gold: "route:Nova" },
  { id: "f06", category: "filler", text: "Uh, um, Quinn, rebase on main.", gold: "route:Quinn" },
  { id: "f07", category: "filler", text: "Er Rowan, what is the status?", gold: "route:Rowan" },
  { id: "f08", category: "filler", text: "Um Release Captain, tag the build.", gold: "route:Release Captain" },
  { id: "f09", category: "filler", text: "Huh. Sage, open the report.", gold: "route:Sage" },
  { id: "f10", category: "filler", text: "Uh Steve check the build", gold: "route:Steve" },
  { id: "f11", category: "filler", text: "Ah, Willow, update the docs.", gold: "route:Willow" },
  { id: "l01", category: "lexical", text: "Okay, Steve, check the build.", gold: "route:Steve" },
  { id: "l02", category: "lexical", text: "So, Luna, run the tests.", gold: "route:Luna" },
  { id: "l03", category: "lexical", text: "Hey Atlas, deploy staging.", gold: "route:Atlas" },
  { id: "l04", category: "lexical", text: "Oh, Nova, summarize the pull request.", gold: "route:Nova" },
  { id: "l05", category: "lexical", text: "Right. Quinn, rebase on main.", gold: "route:Quinn" },
  { id: "l06", category: "lexical", text: "And Rowan, also check CI.", gold: "route:Rowan" },
  { id: "l07", category: "lexical", text: "Yeah, Sage, open the report.", gold: "route:Sage" },
  { id: "l08", category: "lexical", text: "Okay so Will, grab the logs.", gold: "route:Will" },
  { id: "l09", category: "lexical", text: "Hey Steve check the build", gold: "route:Steve" },
  { id: "n01", category: "noise", text: "The Steve, check the build.", gold: "route:Steve" },
  { id: "n02", category: "noise", text: "You. Luna, run the tests.", gold: "route:Luna" },
  { id: "n03", category: "noise", text: "I Atlas, deploy staging.", gold: "route:Atlas" },
  { id: "n04", category: "noise", text: "A Nova, summarize the pull request.", gold: "route:Nova" },
  { id: "n05", category: "noise", text: "Fish. Steve, check the build.", gold: "route:Steve" },
  { id: "n06", category: "noise", text: "Bye Quinn, rebase on main.", gold: "route:Quinn" },
  { id: "n07", category: "noise", text: "Two, Rowan, what is the status?", gold: "route:Rowan" },
  { id: "n08", category: "noise", text: "Cheers. Sage, open the report.", gold: "route:Sage" },
  { id: "n09", category: "noise", text: "The the Luna, run the tests.", gold: "route:Luna" },
  { id: "n10", category: "noise", text: "Uh, Steven, check the build.", gold: "route:Steve" },
  { id: "n11", category: "noise", text: "Um, Stevie, run lint.", gold: "route:Steve" },
  { id: "n12", category: "noise", text: "Honestly, Steve, that is fine.", gold: "route:Steve" },
  { id: "n13", category: "noise", text: "Wait, Luna, stop.", gold: "route:Luna" },
  { id: "m01", category: "mention", text: "So Steve said the build is fine.", gold: "none" },
  { id: "m02", category: "mention", text: "Oh Steve is going to love this.", gold: "none" },
  { id: "m03", category: "mention", text: "Okay Steve's pull request is merged.", gold: "none" },
  { id: "m04", category: "mention", text: "I think Steve broke the build.", gold: "none" },
  { id: "m05", category: "mention", text: "Tell Steve to check the build.", gold: "none" },
  { id: "m06", category: "mention", text: "Ask Luna about it later.", gold: "none" },
  { id: "m07", category: "mention", text: "Did Atlas finish the deploy?", gold: "none" },
  { id: "m08", category: "mention", text: "Hey, has Nova pushed yet?", gold: "none" },
  { id: "m09", category: "mention", text: "Um, I told Steve, check the build.", gold: "none" },
  { id: "m10", category: "mention", text: "And Will you grab the door?", gold: "none" },
  { id: "m11", category: "mention", text: "Uh Steve broke it again.", gold: "none" },
  { id: "m12", category: "mention", text: "So will we ship today?", gold: "none" },
  { id: "m13", category: "mention", text: "Yeah, Luna and I talked about it.", gold: "none" },
  { id: "m14", category: "mention", text: "Okay, Atlas is the deploy box.", gold: "none" },
  { id: "m15", category: "mention", text: "The Sage advice is to wait.", gold: "none" },
  { id: "m16", category: "mention", text: "Thanks, Steve.", gold: "none" },
  { id: "m17", category: "mention", text: "Tell Steve, check the build.", gold: "none" },
  { id: "s01", category: "similar", text: "Um, Wil, check the build.", gold: "route:Will" },
  { id: "s02", category: "similar", text: "Uh, Willow, check the docs.", gold: "route:Willow" },
  { id: "s03", category: "similar", text: "Um, Noah, check the build.", gold: "ambiguous" },
  { id: "s04", category: "similar", text: "Uh, Release, tag the build.", gold: "ambiguous" },
  { id: "s05", category: "similar", text: "So Willow's docs are stale.", gold: "none" },
  { id: "a01", category: "ambiguous", text: "Um, Steve and Luna, check the build.", gold: "ambiguous" },
  { id: "a02", category: "ambiguous", text: "Uh, Steve or Luna, whoever is free, check the build.", gold: "ambiguous" },
  { id: "a03", category: "ambiguous", text: "The Luna Steve, check the build.", gold: "ambiguous" },
  { id: "a04", category: "ambiguous", text: "Um, Steve, check the build, and Luna, run the tests.", gold: "route:Steve" },
  { id: "a05", category: "ambiguous", text: "Okay, Steve, tell Luna the build is green.", gold: "route:Steve" },
  { id: "a06", category: "ambiguous", text: "Hey, Luna, Steve, run the tests.", gold: "ambiguous" },
  { id: "k01", category: "control-prefix", text: "Uh, cancel.", gold: "control" },
];

/** Non-speech placed right before the speech of a noise case. `tap`, `typing` and `room` are cut from the operator's recording when it is available. */
export type PrefixNoise = "knock" | "double-knock" | "cough" | "thump" | "clicks" | "typing" | "breath" | "tap";

export interface PrefixAudioCase extends PrefixCase {
  /** The macOS voice that speaks `text`, or the operator's clip that replaces it. */
  voice?: string;
  human?: "max-stop" | "steve-build" | "carol-tests" | "cancel" | "tap-cancel" | "steve-stop-quiet";
  noise?: PrefixNoise;
  /** Silence between the noise and the speech. */
  gapMs?: number;
  /** Seconds of silence after this case; a short one keeps the next Cancel inside this card's window. */
  afterS?: number;
}

const S = "Shelley (English (US))", E = "Eddy (English (US))", F = "Flo (English (UK))", R = "Reed (English (UK))",
  T = "Tessa", Y = "Sandy (English (US))", K = "Kathy", I = "Rishi";
const CANCEL_GAP_S = 2.8;

/**
 * The holdout, written after the rules were fixed. No sentence repeats a scout case, and its voices
 * are not the four the development set is spoken in. `cancel` cases follow the card they cancel.
 */
export const PREFIX_HOLDOUT_CASES: readonly PrefixAudioCase[] = [
  // A Cancel with nothing of its own to cancel, first so no earlier card is pending.
  { id: "hk00", category: "cancel", text: "Okay, cancel.", gold: "control", voice: Y },
  // Clean call signs: the routes that work today and must not change.
  { id: "hc01", category: "clean", text: "Carol, run the tests.", gold: "route:Carol", voice: S },
  { id: "hc02", category: "clean", text: "Max, check the deploy logs.", gold: "route:Max", voice: E },
  { id: "hc03", category: "clean", text: "Release Captain, tag version two.", gold: "route:Release Captain", voice: R },
  { id: "hc04", category: "clean", text: "Will you rebase this branch?", gold: "route:Will", voice: K },
  { id: "hc05", category: "clean", text: "Luna, stop.", gold: "route:Luna", voice: I },
  { id: "hc06", category: "clean", text: "Nova, ask Carol about the flaky test.", gold: "route:Nova", voice: T },
  { id: "hh01", category: "clean", text: "Steve, check the build.", gold: "route:Steve", human: "steve-build" },
  { id: "hh02", category: "clean", text: "Max, stop.", gold: "route:Max", human: "max-stop" },
  { id: "hh03", category: "clean", text: "Steve, stop.", gold: "route:Steve", human: "steve-stop-quiet" },
  // Deliberate openers and fillers before a real address.
  { id: "ho01", category: "opener", text: "Um, Carol, rerun the failing job.", gold: "route:Carol", voice: S },
  { id: "ho02", category: "opener", text: "Uh, Max, pull the latest main.", gold: "route:Max", voice: E },
  { id: "ho03", category: "opener", text: "Okay, Nova, what changed since yesterday?", gold: "route:Nova", voice: F },
  { id: "ho04", category: "opener", text: "Hey Carol, open a pull request for this.", gold: "route:Carol", voice: R },
  { id: "ho05", category: "opener", text: "So, Max, are the logs clean?", gold: "route:Max", voice: T },
  { id: "ho06", category: "opener", text: "Alright, Steve, ship it.", gold: "route:Steve", voice: Y },
  { id: "ho07", category: "opener", text: "Well, Luna, try the other branch.", gold: "route:Luna", voice: I },
  { id: "ho08", category: "opener", text: "Oh, Atlas, restart the staging server.", gold: "route:Atlas", voice: K },
  { id: "ho09", category: "opener", text: "Hmm, Quinn, look at the flaky spec.", gold: "route:Quinn", voice: E },
  { id: "ho10", category: "opener", text: "Yeah, Rowan, go ahead and merge.", gold: "route:Rowan", voice: F },
  { id: "ho11", category: "opener", text: "Um, Release Captain, draft the release notes.", gold: "route:Release Captain", voice: S },
  { id: "ho12", category: "opener", text: "Uh Carol check the coverage report", gold: "route:Carol", voice: R },
  { id: "ho13", category: "opener", text: "Okay so Max, summarize the failures.", gold: "route:Max", voice: Y },
  { id: "ho14", category: "opener", text: "Hi Sage, write a reply to the reviewer.", gold: "route:Sage", voice: T },
  { id: "ho15", category: "opener", text: "Um, Luna, stop.", gold: "route:Luna", voice: K },
  { id: "ho16", category: "opener", text: "Er, Willow, update the changelog.", gold: "route:Willow", voice: I },
  // Noise right before a clean call sign: whatever the recognizer writes for it is the prefix.
  { id: "hn01", category: "noise", text: "Carol, run the linter.", gold: "route:Carol", voice: F, noise: "knock", gapMs: 120 },
  { id: "hn02", category: "noise", text: "Max, check the deploy.", gold: "route:Max", voice: R, noise: "cough", gapMs: 150 },
  { id: "hn03", category: "noise", text: "Nova, stop.", gold: "route:Nova", voice: S, noise: "thump", gapMs: 100 },
  { id: "hn04", category: "noise", text: "Steve, merge the fix.", gold: "route:Steve", voice: E, noise: "typing", gapMs: 200 },
  { id: "hn05", category: "noise", text: "Luna, open the dashboard.", gold: "route:Luna", voice: T, noise: "clicks", gapMs: 150 },
  { id: "hn06", category: "noise", text: "Atlas, roll back the deploy.", gold: "route:Atlas", voice: Y, noise: "breath", gapMs: 80 },
  { id: "hn07", category: "noise", text: "Quinn, rerun the build.", gold: "route:Quinn", voice: K, noise: "double-knock", gapMs: 150 },
  { id: "hn08", category: "noise", text: "Steve, check the build.", gold: "route:Steve", human: "steve-build", noise: "tap", gapMs: 120 },
  { id: "hn09", category: "noise", text: "Carol, run the tests.", gold: "route:Carol", human: "carol-tests", noise: "typing", gapMs: 150 },
  { id: "hn10", category: "noise", text: "Max, stop.", gold: "route:Max", human: "max-stop", noise: "cough", gapMs: 100 },
  // Ordinary speech that mentions an agent.
  { id: "hm01", category: "mention", text: "So Carol thinks the build is fine.", gold: "none", voice: S },
  { id: "hm02", category: "mention", text: "Okay, Max is on the deploy rotation.", gold: "none", voice: E },
  { id: "hm03", category: "mention", text: "Um, I asked Nova about it.", gold: "none", voice: F },
  { id: "hm04", category: "mention", text: "Yeah, Steve fixed that yesterday.", gold: "none", voice: R },
  { id: "hm05", category: "mention", text: "And Luna said it was flaky.", gold: "none", voice: T },
  { id: "hm06", category: "mention", text: "Hey, did Carol push already?", gold: "none", voice: Y },
  { id: "hm07", category: "mention", text: "Tell Max, the build is green.", gold: "none", voice: K },
  { id: "hm08", category: "mention", text: "Uh, so Steve's branch is merged.", gold: "none", voice: I },
  { id: "hm09", category: "mention", text: "The Atlas server, which we deploy to, is down.", gold: "none", voice: E },
  { id: "hm10", category: "mention", text: "Oh, will you look at that.", gold: "none", voice: S },
  { id: "hm11", category: "mention", text: "So will it rain today?", gold: "none", voice: F },
  { id: "hm12", category: "mention", text: "A Nova is a kind of star.", gold: "none", voice: R },
  { id: "hm13", category: "mention", text: "Thanks, Max.", gold: "none", voice: T },
  { id: "hm14", category: "mention", text: "Okay, Sage advice, as always.", gold: "none", voice: Y },
  { id: "hm15", category: "mention", text: "Honestly, Steve broke it again.", gold: "none", voice: K },
  { id: "hm16", category: "mention", text: "Hmm, Max is late again.", gold: "none", voice: I },
  // More than one possible recipient, or a name that is not quite on the roster.
  { id: "ha01", category: "ambiguous", text: "Um, Carol and Max, sync up on the release.", gold: "ambiguous", voice: S },
  { id: "ha02", category: "ambiguous", text: "Okay, Steve or Luna, can someone look?", gold: "ambiguous", voice: E },
  { id: "ha03", category: "ambiguous", text: "Hey Max, Carol, check the logs.", gold: "ambiguous", voice: F },
  { id: "ha04", category: "ambiguous", text: "Uh, Will, Willow, compare the docs.", gold: "ambiguous", voice: R },
  { id: "ha05", category: "ambiguous", text: "Um, Caroline, run the tests.", gold: "ambiguous", voice: T },
  { id: "ha06", category: "ambiguous", text: "Uh, Maxine, check the build.", gold: "ambiguous", voice: Y },
  // Spoken Cancel while the card before it is still in its cancel window.
  { id: "hk01", category: "cancel", text: "Max, run the tests.", gold: "route:Max", voice: K, afterS: CANCEL_GAP_S },
  { id: "hk02", category: "cancel", text: "Uh, cancel.", gold: "cancel", voice: K },
  { id: "hk03", category: "cancel", text: "Um, Carol, deploy to staging.", gold: "route:Carol", voice: I, afterS: CANCEL_GAP_S },
  { id: "hk04", category: "cancel", text: "Cancel.", gold: "cancel", voice: I },
  { id: "hk05", category: "cancel", text: "Carol, run the tests.", gold: "route:Carol", human: "carol-tests", afterS: CANCEL_GAP_S },
  { id: "hk06", category: "cancel", text: "Cancel.", gold: "cancel", human: "cancel" },
  { id: "hk07", category: "cancel", text: "Steve, check the build.", gold: "route:Steve", human: "steve-build", afterS: CANCEL_GAP_S },
  { id: "hk08", category: "cancel", text: "Cancel.", gold: "cancel", human: "tap-cancel" },
];

/** What one utterance did: routed to a name, asked with the names offered, a control, or nothing. */
export type PrefixOutcome = `route:${string}` | `ask:${string}` | "control" | "cancelled" | "drop";

export type PrefixScore =
  | "routed" | "asked" | "dropped" | "wrong-recipient" | "asked-wrong"
  | "kept-unrouted" | "needless-ask" | "unintended-send" | "unintended-control"
  | "safe-drop" | "silent-guess" | "control" | "control-missed";

/** Unsafe scores: a message, a stop or a control acted for someone it was not meant for. */
export const UNSAFE_SCORES: ReadonlySet<PrefixScore> = new Set(["wrong-recipient", "unintended-send", "unintended-control", "silent-guess"]);

export function scorePrefixOutcome(gold: PrefixGold, outcome: PrefixOutcome): PrefixScore {
  const asked = outcome.startsWith("ask:") ? outcome.slice(4).split("/") : null;
  if (gold.startsWith("route:")) {
    const name = gold.slice(6);
    if (outcome === gold) return "routed";
    // "?" marks an ask whose rows the record does not name, such as the opening rule's own ambiguous name.
    if (asked) return asked.includes(name) || asked.includes("?") ? "asked" : "asked-wrong";
    if (outcome.startsWith("route:")) return "wrong-recipient";
    return outcome === "drop" ? "dropped" : "unintended-control";
  }
  if (gold === "none") {
    if (outcome === "drop") return "kept-unrouted";
    if (asked) return "needless-ask";
    return outcome.startsWith("route:") ? "unintended-send" : "unintended-control";
  }
  if (gold === "ambiguous") {
    if (asked) return "asked";
    if (outcome === "drop") return "safe-drop";
    return outcome.startsWith("route:") ? "silent-guess" : "unintended-control";
  }
  // A Cancel counts when it withdrew a card; a bare control Cancel with nothing pending counts as the control.
  if (gold === "cancel") return outcome === "cancelled" ? "control" : outcome.startsWith("route:") ? "unintended-send" : "control-missed";
  return outcome === "control" || outcome === "cancelled" ? "control" : outcome.startsWith("route:") ? "unintended-send" : "control-missed";
}
