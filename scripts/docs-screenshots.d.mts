// Types for the parts of `docs-screenshots.mjs` that `test/docs-screenshots.test.ts` imports
// under `noImplicitAny`. Same convention as `scripts/demo/launch.d.mts`: the capture script
// itself stays plain JavaScript, because it runs with no build step.
import type { SetupFamilyId } from "@shared/setup-catalog.ts";
import type { UpdateSnapshot } from "@shared/update.ts";

/**
 * A Playwright `Page` and `Locator`, narrowed to what the registry's own callbacks ask of one.
 *
 * Typed structurally rather than imported from `@playwright/test`: this declaration is read by
 * a `test/` file, and `test/` runs against `src/` with no browser anywhere in it.
 *
 * It has to cover EVERY member `ready`, `prepare` and `cleanup` reach for, not just the ones a
 * test happens to exercise. These are the parameter types of exported callbacks, so anything
 * omitted is a method a caller can satisfy the declaration without providing and then have a
 * callback invoke - a missing-method failure at runtime that typechecked cleanly. `capture()`'s
 * own calls (`goto`, `addStyleTag`, `addInitScript`, `screenshot`, `mouse`) are deliberately
 * absent: it is handed a real Playwright page and is not part of this contract.
 */
export interface CaptureLocator {
  waitFor(options?: { state?: string }): Promise<void>;
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  isVisible(): Promise<boolean>;
  first(): CaptureLocator;
  scrollIntoViewIfNeeded(): Promise<void>;
}

export interface CapturePage {
  getByRole(role: string, options?: Record<string, unknown>): CaptureLocator;
  getByPlaceholder(text: string): CaptureLocator;
  getByText(text: string, options?: Record<string, unknown>): CaptureLocator;
  locator(selector: string): CaptureLocator;
  keyboard: { press(key: string): Promise<void> };
  waitForTimeout(ms: number): Promise<void>;
}

/** What `prepare` is handed about the run it is part of. */
export interface CaptureRunContext {
  /** The demo's seeded workspace repositories, as absolute paths. */
  repos: string[];
}

export interface Screenshot {
  /** The committed file's basename under `docs/images`, without the extension. */
  name: string;
  /** The dashboard hash route the frame is taken on. */
  route: string;
  /** Whether this frame needs the seeded fleet behind it. */
  needsFleet?: boolean;
  /** Whether this frame is of the first-run reminder, and so precedes its dismissal. */
  beforeBannerDismissal?: boolean;
  /** Page source evaluated before the bundle loads. Forces its own browser context. */
  init?: () => string;
  ready(page: CapturePage): CaptureLocator;
  prepare?(page: CapturePage, context: CaptureRunContext): Promise<void>;
  cleanup?(page: CapturePage): Promise<void>;
}

export const SCREENSHOTS: readonly Screenshot[];

/** Absolute path of the directory the committed figures are written to. */
export const OUTPUT_DIR: string;

/** The `available` snapshot `update-available.png` is a picture of. */
export const AVAILABLE_UPDATE: Extract<UpdateSnapshot, { phase: "available" }>;

/** `SCREENSHOTS`, or the subset a trailing `--only a,b` names. Throws on an unknown name. */
export function requestedScreenshots(argv: string[]): readonly Screenshot[];

/** Select one Setup family in the rail and wait for its pane to be the one showing. */
export function openSetupFamily(
  page: CapturePage,
  family: SetupFamilyId,
  label: string,
): Promise<void>;

/** Source for a stand-in Electron preload bridge publishing one update snapshot. */
export function desktopUpdateBridgeScript(snapshot: UpdateSnapshot): string;

/**
 * One Trust grant cell's accessible name, as `TrustPanel` builds it:
 * `${action}: ${column title} for ${repository path}`.
 */
export function trustCell(action: "Grant" | "Revoke", column: string, repo: string): RegExp;
