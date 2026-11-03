import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

// The colour the desktop window paints before the dashboard has loaded, remembered across
// launches in the state home, beside the database.
//
// The shell reads it in `createWindow` (`src/main/window.ts`), because the daemon may not be up
// yet when the window is created, so the value cannot be read from `app_config`. Two writers
// keep it, and both write the same value - the stored skin's `--bg`:
//  - the daemon (`syncWindowBackground` in `ui-config.ts`), on every `ui.skin` write, after a
//    settings restore and at startup, so a skin chosen in a browser tab with no desktop bridge
//    still decides the next desktop launch;
//  - the shell's `mission:set-window-background` handler, which the renderer's skin module
//    (`src/web/lib/skin.ts`) calls with the computed `--bg`, so the live window repaints too.
// Here rather than in `src/main` because both processes import it.

/** The pre-skin window colour, used until a skin has ever been applied. */
export const WINDOW_BACKGROUND_FALLBACK = "#0e1116";

const COLOR = /^#[0-9a-f]{6}$/i;

const WindowBackgroundSchema = z.object({
  color: z.string().regex(COLOR),
}).strict();

export function windowBackgroundPath(stateDirectory: string): string {
  return join(stateDirectory, "window-background.json");
}

/** A `#rrggbb` colour from the renderer, normalised to lower case, or null if it is not one. */
export function parseWindowBackground(value: unknown): string | null {
  return typeof value === "string" && COLOR.test(value) ? value.toLowerCase() : null;
}

/** The remembered colour, or the fallback for a missing, unreadable or hand-edited file. */
export function readWindowBackground(path: string): string {
  try {
    return WindowBackgroundSchema.parse(JSON.parse(readFileSync(path, "utf8"))).color.toLowerCase();
  } catch {
    return WINDOW_BACKGROUND_FALLBACK;
  }
}

/** Persist a colour only when it differs from what is remembered. Returns whether it wrote. */
export function rememberWindowBackground(path: string, value: unknown): boolean {
  const color = parseWindowBackground(value);
  if (!color) throw new Error("window background must be a #rrggbb colour");
  try {
    if (WindowBackgroundSchema.parse(JSON.parse(readFileSync(path, "utf8"))).color.toLowerCase() === color) return false;
  } catch {
    // Missing or unreadable: write it.
  }
  writeWindowBackground(path, color);
  return true;
}

/** Whether a remembered background is a light one, for the shell's own startup page. */
export function windowSchemeFor(color: string): "dark" | "light" {
  const channel = (offset: number): number => {
    const c = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.4 ? "light" : "dark";
}

/** Persist a colour atomically, so a launch never reads a half-written file. */
export function writeWindowBackground(path: string, value: unknown): string {
  const color = parseWindowBackground(value);
  if (!color) throw new Error("window background must be a #rrggbb colour");
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ color })}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return color;
}

/** The slice of Electron the handler needs, so a test can drive the real handler without one. */
export interface WindowBackgroundIpc {
  handle(channel: string, listener: (event: { sender: unknown }, color: unknown) => unknown): void;
}
export interface WindowBackgroundTarget {
  webContents: unknown;
  setBackgroundColor(color: string): void;
}

/**
 * Serve `mission:set-window-background`: the dashboard reports the applied skin's `--bg`
 * (`src/web/lib/skin.ts`). Only the main window's own contents may set it; anything but a
 * `#rrggbb` colour is refused before it reaches `BrowserWindow`. The live window repaints at
 * once, and the colour is written - only when it changed - so the next launch opens in it.
 */
export function registerWindowBackgroundIpc(
  ipc: WindowBackgroundIpc,
  mainWindow: () => WindowBackgroundTarget | null,
  path: () => string,
): void {
  let remembered: string | null = null;
  ipc.handle("mission:set-window-background", (event, color) => {
    const window = mainWindow();
    if (!window || event.sender !== window.webContents) return;
    const background = parseWindowBackground(color);
    if (!background) throw new Error("window background must be a #rrggbb colour");
    window.setBackgroundColor(background);
    if (background === remembered) return;
    writeWindowBackground(path(), background);
    remembered = background;
  });
}
