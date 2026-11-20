import { AGENT_IDENTITY } from "./agent.ts";
import type { AgentType } from "./types.ts";

/**
 * The start-up banner of headless mode (spec 7.21): three lines, written in one place.
 *
 * `dispatchBanner` is pure. It returns each line as plain text plus the spans a surface may
 * colour, so the mod draws colour through its own text styles and never writes an escape code,
 * and Codex and Pi can print the same lines by passing their own harness name. Browser safe: no
 * `node:` imports.
 */

/** The widest a banner line may be (columns). Nothing wraps or pads to the window. */
export const BANNER_MAX_COLUMNS = 72;

/**
 * Q12, decided here. The two marks are single-width characters, so colour never shifts the
 * layout and a terminal without colour still reads the same: a diamond for Mission Control and
 * a dot for the harness running the session.
 */
export const MISSION_CONTROL_MARK = "◆";

/**
 * The harness mark, keyed by the harness registry's own ids. A `Record<AgentType, ...>` is the
 * enforcement: a harness added to the registry does not compile here until it has a mark, and
 * no `if (harness === ...)` branch exists. Each is the same dot today; the colour is the
 * harness's brand accent from `AGENT_IDENTITY`.
 */
export const HARNESS_BANNER_MARKS: Record<AgentType, string> = {
  claude: "●",
  codex: "●",
  pi: "●",
};

/**
 * What a span is, so a surface can pick a text style for it. Colours (Q12): the Mission Control
 * mark takes the surface's accent, the harness mark takes the harness's brand colour
 * (`color`), a running count takes success, and a waiting count takes warning.
 */
export const BANNER_SPAN_ROLES = ["mission-mark", "harness-mark", "running", "waiting"] as const;
export type BannerSpanRole = (typeof BANNER_SPAN_ROLES)[number];

export interface BannerSpan {
  /** Offset of the first character in the line's text. */
  start: number;
  /** Offset after the last character. */
  end: number;
  role: BannerSpanRole;
  /** A literal CSS colour, for the harness mark only. */
  color?: string;
}

export interface BannerLine {
  text: string;
  spans: BannerSpan[];
}

export interface DispatchBannerInput {
  harness: AgentType;
  counts: { running: number; waiting: number };
  /** True when the launcher will open (7.4), so the hint says Mission Control will ask. */
  menuOffered: boolean;
  /** True when the mod's version differs from the daemon's. */
  versionMismatch: boolean;
}

const TAGLINE = "Dispatch, check on and answer tasks without leaving this session";
const HINT_ASKS = "I will ask how you want to start";
const HINT_COMMAND = "/mission-dispatch opens the menu";
const MISMATCH = "mod and daemon versions differ | run mctl doctor";

function countText(n: number): string {
  const whole = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  return whole > 999 ? "999+" : String(whole);
}

function isZero(n: number): boolean {
  return !Number.isFinite(n) || Math.floor(n) <= 0;
}

class LineBuilder {
  text = "";
  spans: BannerSpan[] = [];
  add(text: string, role?: BannerSpanRole, color?: string): this {
    if (role) this.spans.push({ start: this.text.length, end: this.text.length + text.length, role, ...(color ? { color } : {}) });
    this.text += text;
    return this;
  }
  done(): BannerLine {
    return { text: this.text, spans: this.spans };
  }
}

/** The three banner lines. */
export function dispatchBanner(input: DispatchBannerInput): BannerLine[] {
  const identity = AGENT_IDENTITY[input.harness];
  const first = new LineBuilder()
    .add(MISSION_CONTROL_MARK, "mission-mark")
    .add(" Mission Control   ")
    .add(HARNESS_BANNER_MARKS[input.harness], "harness-mark", identity.accent)
    .add(` ${identity.label}`)
    .done();
  const second = new LineBuilder().add(TAGLINE).done();

  const third = new LineBuilder();
  if (input.versionMismatch) {
    third.add(MISMATCH);
  } else {
    if (isZero(input.counts.running) && isZero(input.counts.waiting)) {
      third.add("nothing running");
    } else {
      third.add(countText(input.counts.running), "running").add(" running | ")
        .add(countText(input.counts.waiting), "waiting").add(" waiting on you");
    }
    third.add(` | ${input.menuOffered ? HINT_ASKS : HINT_COMMAND}`);
  }
  return [first, second, third.done()];
}

/** The banner with no styling: one string per line. */
export function dispatchBannerPlain(input: DispatchBannerInput): string[] {
  return dispatchBanner(input).map((line) => line.text);
}
