import { homedir } from "node:os";
import path from "node:path";
import { OPEN_TARGET_INFO } from "@shared/open-targets.ts";
import type { OpenDeps, OpenResolution, OpenTargetImpl } from "./types.ts";

/**
 * The first "Open in" target: the browser the human has actually chosen, holding a file
 * out of a session's checkout.
 *
 * **It resolves the browser rather than shelling the file at the platform's default
 * handler, and that is the whole design.** `open <file>` / `xdg-open <file>` route by FILE
 * TYPE: they land an `.html` mockup in the default browser (which is why that shortcut
 * looks right at first) and land `routes.ts` in whatever editor claims `.ts`. A menu row
 * that says "Browser" and opens Xcode is not a degradation, it is a lie, and the files
 * view lists every file in the checkout - not just the previewable ones. So each platform
 * branch answers the question the row asks, "which application handles the WEB", and a
 * platform that cannot answer it refuses by name instead of guessing.
 *
 * What this buys over the sandboxed preview beside it: the iframe is deliberately
 * `script-src` locked and has its local CSS inlined (see `FileWorkspace.tsx`), so a mockup
 * with any JavaScript at all can only be seen for real in a real browser. From `file://`
 * the document also resolves its own relative assets, which the srcDoc sandbox cannot.
 */

/**
 * Where LaunchServices records the handler the human picked, and what every
 * default-browser lookup on macOS reads.
 *
 * There is no public CLI for "the default browser" - `open` exposes only `-a` (a name) and
 * `-b` (a bundle id), both of which require already knowing the answer. This preference is
 * how the OS itself stores it, and reading it is what `default-browser-id` and friends do.
 * Read-only, and a miss is not an error: see `macBundle`.
 */
const LAUNCH_SERVICES_PLIST =
  "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist";

/**
 * The https handler when nothing has overridden it.
 *
 * LaunchServices writes an `LSHandlers` entry only once a human CHANGES the default
 * browser, so an absent entry means the shipped one rather than "no browser". Naming it
 * is the one place a vendor string is unavoidable, because it is the operating system's
 * own answer and there is nowhere else to read it from.
 */
const MAC_SYSTEM_BROWSER = "com.apple.Safari";

interface LaunchServicesHandler {
  LSHandlerURLScheme?: string;
  LSHandlerRoleAll?: string;
  LSHandlerRoleViewer?: string;
}

/** The bundle id LaunchServices hands `https` (then `http`) to, or null if it says nothing. */
function handlerBundle(plist: string): string | null {
  let parsed: { LSHandlers?: LaunchServicesHandler[] };
  try {
    parsed = JSON.parse(plist) as { LSHandlers?: LaunchServicesHandler[] };
  } catch {
    return null;
  }
  const handlers = Array.isArray(parsed.LSHandlers) ? parsed.LSHandlers : [];
  // https first: a machine can carry a stale `http` row from an older default, and https
  // is what a browser is actually chosen for.
  for (const scheme of ["https", "http"]) {
    for (const handler of handlers) {
      if (handler?.LSHandlerURLScheme !== scheme) continue;
      const bundle = handler.LSHandlerRoleAll ?? handler.LSHandlerRoleViewer;
      if (bundle) return bundle;
    }
  }
  return null;
}

/**
 * A human-readable name for a bundle id: `com.google.chrome` -> "Chrome".
 *
 * Derived rather than looked up, deliberately. The alternatives both cost more than the
 * label is worth: `mdfind` needs a live Spotlight index and a second spawn on every menu
 * draw, and asking the app its own name over Apple Events LAUNCHES it - which is exactly
 * the thing the human has not clicked yet. The bundle id remains the authority; this only
 * decides what the row reads.
 */
function bundleDisplayName(bundle: string): string {
  const last = bundle.split(".").filter(Boolean).at(-1) ?? bundle;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

async function macBundle(deps: OpenDeps): Promise<string> {
  const home = deps.env.HOME || homedir();
  const plist = await deps.run(
    "plutil",
    ["-convert", "json", "-o", "-", path.join(home, LAUNCH_SERVICES_PLIST)],
    { timeoutMs: 4000, env: deps.env },
  );
  // Every failure here means the same thing - nobody has overridden the default - so a
  // missing plist, a missing `plutil` and an unparseable blob all fall through to the
  // system browser rather than refusing. The one way to get this wrong is to treat an
  // unreadable preference as "no browser installed", which is never true on macOS.
  const bundle = plist.code === 0 ? handlerBundle(plist.stdout) : null;
  return bundle ?? MAC_SYSTEM_BROWSER;
}

/**
 * Linux, in the order the desktop itself would ask.
 *
 * `xdg-settings get default-web-browser` is the structured question - it answers with a
 * desktop id (`firefox.desktop`) rather than a command line - and `gtk-launch` is what
 * takes a desktop id plus a file. When either is missing we fall back to `xdg-open`, which
 * routes by file type and so keeps the row's promise only for web documents; it reports a
 * null `detail` because it genuinely cannot say which application will answer.
 *
 * `$BROWSER` is deliberately not consulted: its entries are command TEMPLATES
 * (`firefox %s`), and honouring one means implementing shell word-splitting to get an
 * argv, which is a parser this feature should not own.
 */
async function linuxLauncher(deps: OpenDeps): Promise<OpenResolution> {
  const gtkLaunch = deps.resolveBin?.("gtk-launch", deps.env)
    ?? (deps.installed("gtk-launch", deps.env) ? "gtk-launch" : null);
  const xdgSettings = deps.resolveBin?.("xdg-settings", deps.env)
    ?? (deps.installed("xdg-settings", deps.env) ? "xdg-settings" : null);
  if (gtkLaunch && xdgSettings) {
    const setting = await deps.run(xdgSettings, ["get", "default-web-browser"], {
      timeoutMs: 4000,
      env: deps.env,
    });
    const desktop = setting.code === 0 ? setting.stdout.trim() : "";
    if (/^[\w.+-]+\.desktop$/.test(desktop)) {
      return {
        ok: true,
        launcher: {
          detail: desktop.replace(/\.desktop$/, ""),
          command: (file) => ({ bin: gtkLaunch, args: [desktop, file] }),
        },
      };
    }
  }
  const xdgOpen = deps.resolveBin?.("xdg-open", deps.env)
    ?? (deps.installed("xdg-open", deps.env) ? "xdg-open" : null);
  if (xdgOpen) {
    return {
      ok: true,
      launcher: { detail: null, command: (file) => ({ bin: xdgOpen, args: [file] }) },
    };
  }
  return {
    ok: false,
    reason: "no launcher found - install xdg-utils, or gtk-launch for an exact browser",
  };
}

export const browserTarget: OpenTargetImpl = {
  ...OPEN_TARGET_INFO.browser,
  async resolve(deps) {
    if (deps.platform === "darwin") {
      const bundle = await macBundle(deps);
      const open = deps.resolveBin?.("open", deps.env) ?? "open";
      return {
        ok: true,
        launcher: {
          detail: bundleDisplayName(bundle),
          // The path is passed as-is rather than as a `file://` URL: it is absolute, so it
          // can never be read as a flag, and it needs no percent-encoding to survive.
          command: (file) => ({ bin: open, args: ["-b", bundle, file] }),
        },
      };
    }
    if (deps.platform === "linux") return linuxLauncher(deps);
    // Refused by NAME rather than attempted, because there is no candidate to try: the
    // desktop build is macOS-only (`electron-builder.yml`) and the daemon runs on Linux
    // for development. A Windows branch is a `start`-shaped command and a registry read,
    // and it goes here.
    return { ok: false, reason: `opening files in a browser is not supported on ${deps.platform} yet` };
  },
};
