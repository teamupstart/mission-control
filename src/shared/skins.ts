/**
 * The dashboard's skins: one registry the picker renders from, the `ui.skin` schema validates
 * against, and the contrast and geometry tests iterate.
 *
 * A skin is CSS only. Default is `:root` in `src/web/styles.css`; every other entry has one
 * file, `src/web/skins/<id>.css`, that overrides tokens under `:root[data-skin="<id>"]`, and
 * `src/web/lib/skin.ts` is the only writer of that attribute. A skin changes how the dashboard
 * looks, never what it shows.
 *
 * APPEND-ONLY. An id is persisted in `app_config.ui.skin` on operators' machines, so a shipped
 * id is never renamed, reordered or removed. A stored id this build does not know reads as
 * Default (`UiConfigSchema`), so a downgrade never fails the whole `ui` record.
 *
 * `swatches` draw the picker's thumbnail and must equal the skin file's token values;
 * `test/skins.test.ts` holds them to that, and holds every skin to the contrast contract in
 * `docs/agent-guides/change-contracts.md`.
 *
 * Browser-safe: no `node:` imports.
 */

export interface SkinSwatches {
  /** `--bg` */
  bg: string;
  /** `--panel` */
  panel: string;
  /** `--fg` */
  fg: string;
  /** `--working` */
  working: string;
  /** `--idle` */
  idle: string;
  /** `--attention` */
  attention: string;
}

export interface Skin {
  id: string;
  label: string;
  description: string;
  /** Drives `color-scheme` on the document, so native controls and scrollbars match. */
  colorScheme: "dark" | "light";
  swatches: SkinSwatches;
}

export const SKINS = [
  {
    id: "default",
    label: "Default",
    description: "The original dark theme: graphite surfaces and bright state colours.",
    colorScheme: "dark",
    swatches: {
      bg: "#0a0c0f",
      panel: "#14181e",
      fg: "#e7ebf1",
      working: "#4a9eff",
      idle: "#35c08a",
      attention: "#f6a733",
    },
  },
  {
    id: "daylight",
    label: "Daylight",
    description: "Clean, neutral light theme for bright rooms and daytime work.",
    colorScheme: "light",
    swatches: {
      bg: "#f5f7fa",
      panel: "#ffffff",
      fg: "#141a22",
      working: "#0b63ce",
      idle: "#0f7f56",
      attention: "#9e5400",
    },
  },
  {
    id: "paper",
    label: "Paper",
    description: "Warm cream and ink with serif headings, tuned for long reading.",
    colorScheme: "light",
    swatches: {
      bg: "#f2ebde",
      panel: "#fbf7ef",
      fg: "#2a2318",
      working: "#2c5c99",
      idle: "#3a7334",
      attention: "#9a5300",
    },
  },
  {
    id: "blueprint",
    label: "Blueprint",
    description: "Engineering drawing: deep cobalt, drafting grid, crisp white linework.",
    colorScheme: "dark",
    swatches: {
      bg: "#0b2547",
      panel: "#10315e",
      fg: "#eef5ff",
      working: "#86ccff",
      idle: "#62e8b4",
      attention: "#ffc857",
    },
  },
  {
    id: "neon-dusk",
    label: "Neon Dusk",
    description: "Late-night synth palette: violet surfaces, magenta and cyan glow.",
    colorScheme: "dark",
    swatches: {
      bg: "#120a1f",
      panel: "#1e1233",
      fg: "#f4ecff",
      working: "#3fd0ff",
      idle: "#36f1a8",
      attention: "#ffb13d",
    },
  },
] as const satisfies readonly Skin[];

export type ShippedSkin = (typeof SKINS)[number];
export type SkinId = ShippedSkin["id"];

/** Every shipped id, in registry order. A tuple so `z.enum` can take it as-is. */
export const SKIN_IDS = SKINS.map((skin) => skin.id) as [SkinId, ...SkinId[]];

export const DEFAULT_SKIN: SkinId = "default";

/** The registry entry for an id, or Default for one this build does not ship. */
export function skinById(id: string | null | undefined): ShippedSkin {
  return SKINS.find((skin) => skin.id === id) ?? SKINS[0];
}

/** Whether a stored string names a skin this build ships. */
export function isSkinId(id: unknown): id is SkinId {
  return typeof id === "string" && (SKIN_IDS as readonly string[]).includes(id);
}
