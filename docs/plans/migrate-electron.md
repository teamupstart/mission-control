# Migration plan: Fleet Control → native macOS (Electron) app

**Status:** proposed · **Target:** Apple Silicon macOS only · **Scope:** full one-shot
migration that preserves 100% of current functionality and keeps a near-identical
developer experience.

This document is written to be executed in a single, sequenced effort. The daemon and
the web UI keep working standalone at every step; Electron is **purely additive** until
the final cutover, so the migration is safe to land incrementally and revert at any phase.

---

## 1. Goals & non-goals

### Goals
- Ship a single double-clickable **Fleet Control.app** that lives in the menu bar and
  the Dock.
- **Deliver alerts (notification + chime) with no browser tab open** - the one thing the
  web version structurally cannot do (README: *"Delivery needs the tab open… a closed tab
  can't receive one"*).
- **Self-contained**: the app runs without requiring a system `node` on `PATH`. The daemon
  runs on Electron's bundled Node.
- **Zero functional regressions.** Discovery, actions, reviews, dispatch, reports,
  no-mistakes, transcripts, diffs, hooks, and the MCP review channel all keep working.
- **Preserve the dev loop**: Vite HMR / React Fast Refresh in the window; `tsx watch`
  server reload; the plain browser workflow still available.

### Non-goals (explicitly out of scope)
- Windows / Linux builds. macOS `arm64` only.
- Auto-update (Squirrel / electron-updater).
- Apple notarization / Developer ID signing. We use **ad-hoc signing** so the local app
  launches without Gatekeeper friction; notarization can be added later if it's ever
  distributed.
- Rewriting any daemon logic in Rust/native. The Node daemon is reused verbatim.

---

## 2. Why this is low-risk (current architecture recap)

The app is already a **loopback client/server web app**, which is exactly the shape that
wraps cleanly:

- **Daemon** (`src/server`, Hono on `127.0.0.1:7317`): discovery, actions, reviews,
  dispatch, reports, SSE. Pure-JS deps + `node:sqlite`. **No compiled native deps** in the
  runtime path.
- **Web UI** (`src/web`, React + Vite): talks to the daemon over **same-origin relative
  URLs** (`fetch("/api/…")`, `new EventSource("/events")`).
- **OS integration** is entirely **shelling out** (`ps` / `tmux` / `wezterm cli` / `git` /
  `no-mistakes` / `treehouse`) from the daemon - works identically from any Node process.
- **Satellites**: two external processes that Claude Code launches, not us -
  `hooks/harness-hook.mjs` (status bridge) and `dist/mcp/server.mjs` (review channel). Both
  reach the daemon over loopback HTTP + a shared token in `~/.fleet-control/token`.

The migration touches **four** things: (1) the SQLite driver, (2) how the daemon is
started, (3) where notifications are delivered, and (4) how the two satellites are packaged
and registered. Everything else is reused unchanged.

---

## 3. Target architecture

```
┌──────────────────────────── Fleet Control.app ────────────────────────────┐
│                                                                            │
│  Electron main process (Node)                                              │
│   ├─ daemon supervisor ── utilityProcess.fork(dist/server) ──┐            │
│   │     • adopt if :7317 already healthy, else spawn          │            │
│   │     • inject login-shell PATH + FLEET_WEB_DIR             │            │
│   │     • restart w/ backoff; logs → ~/.fleet-control/daemon.log         │
│   ├─ BrowserWindow ── loadURL(http://127.0.0.1:7317) ────────┼──┐        │
│   │     • close → hide (app stays resident); real quit tears down        │
│   ├─ Tray ── live "N need you · M working · K idle" (own SSE read)       │
│   ├─ window-open/navigate handler → shell.openExternal for external URLs │
│   └─ integrations installer (write hooks + `claude mcp add`)             │
│                                                              │  │        │
│  preload (contextBridge: openExternal, version, quit)        │  │        │
└──────────────────────────────────────────────────────────────┼──┼────────┘
                                                                │  │
                              ┌─────────────────────────────────┘  │ loopback http
                              ▼                                     ▼
                   Node daemon  ::7317  ◀──── SSE / /api ──── React UI (renderer)
                   (discovery, dispatch,          ▲            (Vite HMR in dev)
                    reviews, SSE, SQLite)         │
                                                  │ loopback http + token
                              ┌───────────────────┴────────────────┐
                              │  Satellites (launched by Claude)    │
                              │  • hook bridge   (Resources/…/hook.mjs)
                              │  • MCP server    (Resources/…/mcp.mjs)
                              └─────────────────────────────────────┘
```

Key invariant: **the window loads the daemon over `http://127.0.0.1:7317`, never
`file://`.** That preserves same-origin relative URLs, the SSE stream, and the
`requireLoopback` DNS-rebind defense (`routes.ts:66`) - an Electron window at a loopback
host passes it natively, so **no security code changes**.

---

## 4. Key design decisions (with rationale)

### D1 — SQLite: keep `node:sqlite` (verified working in Electron 43 / Node 24)
Originally this called for swapping to `better-sqlite3` out of caution about whether
`node:sqlite` is compiled into Electron's Node. **A spike settled it empirically: Electron
43.1.0 bundles Node 24.18.0 and `node:sqlite` works unflagged** (`DatabaseSync`, `.exec`,
`.prepare().run/.get/.all` all functional). So we **keep `node:sqlite` and change nothing in
`db.ts`.**

- **Zero native modules** → the simplest possible packaging: no `@electron/rebuild`, no
  `asarUnpack` for a `.node`, no ABI-mismatch risk. The esbuild server bundle keeps
  `node:sqlite` external (it's a builtin) and it resolves under Electron's Node at runtime.
- Dev/standalone under system Node 24/25 is unchanged (that's how it already runs).
- *Re-verify* only if the pinned Electron major is ever downgraded below the Node-24 line;
  the `better-sqlite3` swap remains the documented fallback (it would touch only `db.ts`).

### D2 — Daemon hosting: `utilityProcess.fork` of a bundled server (adopt-or-spawn)
The daemon runs as an Electron **`utilityProcess`** (the recommended API for long-lived Node
services - real Node runtime, outside the renderer sandbox), executing an esbuild **bundle**
of `src/server/index.ts` (no `tsx` in production).

- **Adopt-or-spawn:** on launch, `GET /api/health`. If a daemon already answers (someone ran
  the LaunchAgent or `make up`), **adopt** it and do not spawn. Otherwise spawn our own. On
  quit, only stop a daemon **we** spawned. This makes the app coexist with the existing
  headless/dev daemon rather than fighting over `:7317`.
- **Supervision:** restart on unexpected exit with backoff; surface a tray error if it can't
  bind. Pipe daemon stdout/stderr to `~/.fleet-control/daemon.log`.

### D3 — Inject a real `PATH` (critical)
A GUI app launched from Finder inherits a **minimal** `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`).
`git`/`ps` are there, but **`tmux`, `wezterm`, `no-mistakes`, `treehouse` are not** - discovery
and dispatch would silently break. On startup, main resolves the user's **login-shell PATH**
(`$SHELL -lc 'command -v … / echo $PATH'`, à la the `fix-path` pattern used by VS Code) and
injects it into the daemon's env. This mirrors what `scripts/install-service.mjs` already
hardcodes for the LaunchAgent, done properly.

### D4 — Notifications: keep the window alive, hidden (primary strategy)
The alert logic (`useNotifier.ts`, `alerts.ts`), the synthesized Web-Audio **chime**
(`chime.ts`), and the persisted **settings** (`alertSettings.ts`, localStorage) are already
correct and tested. To deliver alerts with no *visible* window while preserving them
**byte-for-byte**, we make **close = hide** (macOS convention) instead of destroy, and set
`backgroundThrottling: false`. The renderer keeps its SSE connection and keeps firing
`new Notification(...)` + the chime; Electron routes those to the OS even when hidden.

- Zero changes to `useNotifier` / `chime` / `alertSettings` → **no behavior drift** (exact
  tones, exact de-dupe, exact AFK digest, settings stay in the app's `localStorage`
  partition). This is the strongest guarantee of functional parity, which the brief demands.
- The **tray** summary is driven by a small, independent read-only SSE subscription in main
  (counts computed inline from the snapshot) - it does not depend on the renderer.
- *Alternative (documented future hardening):* move alert **detection + delivery** into the
  main process (main-side SSE, native `Notification`, chime played from a bundled WAV via
  `afplay`, settings promoted to a daemon-persisted store). Survives even a fully destroyed
  window and drops the resident renderer's memory, at the cost of reimplementing sound
  (tone-fidelity risk) and migrating settings. Not required for parity; deferred.

### D5 — Satellites stay bare-`node`-runnable, path-resolved at install
Claude Code launches the hook and MCP server itself, so they must be plain files an external
process can execute. We esbuild each into a **self-contained** bundle (no repo-relative
imports) shipped as **`extraResources`** (plain files, not inside the asar). An in-app
**"Install Claude integrations"** action writes the concrete absolute command into
`~/.claude/settings.json` and runs `claude mcp add`.

- **Which runtime runs a satellite?** Prefer a resolved **system `node`** (hooks fire on
  every tool use; bare-node cold start is the lowest-latency option, matching today). If no
  `node` is found, fall back to the app binary in Node mode
  (`ELECTRON_RUN_AS_NODE=1 "…/Fleet Control" hook.mjs …`) so it still works self-contained,
  accepting slightly higher per-event overhead. The install action resolves this once and
  writes a concrete command.

### D6 — Security posture unchanged, plus Electron hardening
`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` on the window; a strict
`Content-Security-Policy`; and a navigation handler that sends **external** links to
`shell.openExternal` while blocking the window from navigating away from the daemon origin.
The daemon's loopback bind + `requireLoopback` + token auth are untouched. `react-markdown`
is used **without `rehype-raw`**, so agent-provided plan/diff markdown can't inject HTML -
verified; keep it that way.

---

## 5. Repository layout changes

```
src/
  main/                 NEW  Electron main process
    index.ts              app lifecycle, wiring
    daemon.ts             adopt-or-spawn + supervise the utilityProcess daemon
    window.ts             BrowserWindow, hide-on-close, external-link handling
    tray.ts               tray icon + menu; live summary from its own SSE read
    path-env.ts           login-shell PATH resolution (D3)
    integrations.ts       install/remove Claude hooks + MCP registration (D5)
  preload/
    index.ts            NEW  contextBridge: openExternal, appVersion, quit, install-integrations
  server/               (unchanged, except db.ts driver swap + FLEET_WEB_DIR support)
  web/                  (unchanged; renderer keeps useNotifier/chime as-is)
  shared/               (unchanged)
  mcp/                  (unchanged source; now also emitted as a satellite bundle)

build/                  NEW  packaging assets
  icon.icns               app icon (generated from src/web/public/favicon.svg)
  trayTemplate.png        + trayTemplate@2x.png (macOS template image)
  entitlements.mac.plist  minimal entitlements (JIT etc.) for ad-hoc signing

electron-builder.yml    NEW  packaging config
dist/
  web/    server/    main/    preload/    mcp/    satellites/   (build outputs)
release/                NEW  electron-builder output (.app/.dmg) — gitignored
```

---

## 6. Phased implementation

Each phase lists the concrete changes and an **acceptance** check. Phases 0–2 leave the
project a normal web app that still runs via `npm run dev` / `npm start`.

### Phase 0 — Tooling & project config
- **Deps** (`package.json`):
  - `devDependencies`: add `electron`, `electron-builder`, `electronmon`. (No
    `better-sqlite3` / `@electron/rebuild` - `node:sqlite` is used, see D1.)
- **`"main"` field**: set to `dist/main/index.mjs` (Electron's entry). The existing
  `"bin"` entry stays for the standalone daemon.
- **tsconfig**: kept as a **single** config. `src/main` and `src/preload` already fall under
  the included `src`, and Electron ships its own module types, so a project-reference split
  (which drags in `composite`/build-mode friction) proved unnecessary. `typecheck` stays
  `tsc --noEmit`. (If DOM-global leakage into main ever bites, revisit the split then.)
- **`.gitignore`**: add `release/`, `*.dmg`, `*.app/`, `.electron-cache/`.
- **Acceptance:** `npm run typecheck` passes; `npm run dev` unchanged.

### Phase 1 — SQLite: no code change (spike-confirmed)
`node:sqlite` works in Electron 43's Node 24 (see D1), so `src/server/db.ts` is left
untouched. The only requirement is that the esbuild server bundle keeps `node:sqlite`
external (automatic for `node:` builtins under `--platform=node`).
- **Acceptance:** the server bundle run under Electron's Node opens
  `~/.fleet-control/harness.db`, and a dispatch/restart round-trips the backlog/reviews.

### Phase 2 — Production server & satellite bundles (esbuild)
- **`build:server`**: esbuild `src/server/index.ts` → `dist/server/index.mjs`,
  `--platform=node --format=esm --alias:@shared=./src/shared` (`node:sqlite` stays external
  automatically). Ensure `routes.ts`'s version read resolves from the bundle location (ship
  `package.json`, which the app already includes).
- **`FLEET_WEB_DIR`**: teach `src/server/index.ts` to resolve the static root from
  `process.env.FLEET_WEB_DIR` (absolute) when set, falling back to the current
  `import.meta.url`-relative `dist/web` for dev. Serve with an **absolute** root, not the
  CWD-relative `"./dist/web"`, so it works regardless of the app's working directory.
- **`build:hook`**: esbuild `hooks/harness-hook.mjs` → `dist/satellites/hook.mjs`
  (inlines `harness-runtime.mjs`, so the satellite is a single self-contained file).
- **`build:mcp`** (existing) also copies its output to `dist/satellites/mcp.mjs`.
- **Acceptance:** `node dist/server/index.mjs` serves the built UI on `:7317` with an
  explicit `FLEET_WEB_DIR`; `node dist/satellites/hook.mjs SessionStart </dev/null` exits 0
  and (with a running daemon) reports a session.

### Phase 3 — Electron shell: window + daemon supervisor
- `src/main/daemon.ts`: adopt-or-spawn (D2) via `utilityProcess.fork(dist/server/index.mjs)`
  with env `{ ...loginShellEnv, FLEET_WEB_DIR }`; health-poll `/api/health`; restart w/
  backoff; log to `daemon.log`.
- `src/main/path-env.ts`: resolve login-shell PATH (D3), cached.
- `src/main/window.ts`: create `BrowserWindow` (hardened webPreferences), **retry
  `loadURL(http://127.0.0.1:7317)`** until health passes (brief "Connecting…" state);
  `close` → `hide` unless `app.isQuitting`; `setWindowOpenHandler` + `will-navigate` →
  `shell.openExternal` for non-loopback URLs.
- `src/main/index.ts`: `whenReady` → resolve PATH → start/adopt daemon → create window;
  `before-quit` sets `isQuitting` and tears down a spawned daemon; `activate` → show window.
- `src/preload/index.ts`: minimal `contextBridge` surface (`openExternal`, `appVersion`,
  `quit`, `installIntegrations`).
- **Acceptance:** `npm run build && npx electron .` opens a native window showing the live
  grid; killing the daemon child auto-restarts it; closing the window keeps the process
  alive (Dock icon click reopens it).

### Phase 4 — Tray / menu bar
- `src/main/tray.ts`: `Tray` with `build/trayTemplate.png` (template image → adapts to
  light/dark). Its own read-only SSE subscription updates the tooltip/title to
  `"N need you · M working · K idle"`.
- Menu: **Open Dashboard**, live counts, **Dispatch…** (show window; optional deep-link),
  **Start at login** toggle (`app.setLoginItemSettings`), **Install Claude integrations…**,
  **Quit**. Clicking the tray icon toggles the window.
- **Acceptance:** counts in the tray track the grid; "Start at login" persists across reboot;
  Quit fully exits and stops a spawned daemon.

### Phase 5 — Alerts with no visible window
- Apply D4: `close → hide`, `backgroundThrottling: false`. No changes to `useNotifier` /
  `chime` / `alertSettings`.
- Verify the Electron notification path: the renderer's `Notification.requestPermission()`
  (the "Enable desktop alerts" button) resolves `granted`; if the platform needs it, add a
  `session.setPermissionRequestHandler` that auto-grants `notifications` for the loopback
  origin. Confirm the app appears under **System Settings → Notifications**.
- **Acceptance:** with the **window hidden**, drive a session to `needs-input` (or land a
  review) → a native notification + chime fire; clicking the notification reveals the window.

### Phase 6 — Claude integrations installer (satellites)
- `src/main/integrations.ts`: port the logic of `hooks/install.mjs` into the app, but write
  the **packaged** absolute paths (`process.resourcesPath/satellites/hook.mjs`) and the
  resolved runtime (D5: system `node`, else `ELECTRON_RUN_AS_NODE`). Register/unregister the
  MCP server by shelling `claude mcp add/remove -s user fleet-control -- <runtime> <mcp.mjs>`.
  Reuse the existing surgical `jsonc-parser` merge so the user's other hooks/comments are
  preserved. Provide **Install** and **Remove** menu items + a first-run prompt.
- Keep `npm run install-hooks` (repo paths) working for the dev/self-hosted flow.
- **Acceptance:** from a clean `~/.claude/settings.json`, "Install integrations" wires all 9
  hook events + the MCP server; a **new** Claude session flips grey→blue within ~1s and can
  `request_review`; "Remove" cleanly reverts.

### Phase 7 — Packaging (`electron-builder`)
- `electron-builder.yml`:
  - `appId: com.fleet-control.app`, `productName: Fleet Control`,
    `mac.target: [dmg, dir]`, `mac.category: public.app-category.developer-tools`,
    `mac.arch: arm64`, `icon: build/icon.icns`.
  - `files`: `dist/main`, `dist/preload`, `dist/web`, `dist/server`, `package.json`.
  - `extraResources`: `dist/satellites/**` (hook + MCP must be plain, executable files).
  - `mac.identity: null` (ad-hoc sign) + `build/entitlements.mac.plist`. **No native rebuild
    or `asarUnpack` needed** - there are no native modules (D1).
- `package.json` script `package`: `electron-builder --mac` (output → `release/`).
- **Acceptance:** `npm run package` produces `release/Fleet Control.dmg`; installing to
  `/Applications` and launching from Finder yields a working app - **daemon spawns on
  Electron's Node, PATH is injected (tmux/wezterm/no-mistakes resolve), discovery + dispatch
  + reviews + alerts all work** with no terminal and no system `node` required to run.

### Phase 8 — Developer experience (HMR-preserving)
- Add `dev:electron` (electronmon watches `dist/main`+`dist/preload`; loads
  `http://localhost:5173`) and a top-level:
  ```jsonc
  "dev:desktop": "concurrently -n server,web,shell -c blue,magenta,green \
     \"npm:dev:server\" \"npm:dev:web\" \"npm:dev:electron\""
  ```
- In **dev**, the daemon supervisor detects the `tsx watch` daemon via `/api/health` and
  **adopts** it (never spawns), so the fast server loop is preserved. The window loads Vite
  → **full React HMR / Fast Refresh inside the Electron window**, identical to the browser.
  Main/preload edits trigger a ~1-2s electronmon restart. The plain browser workflow
  (`npm run dev` + open `:5173`) still works untouched.
- DevTools (`Cmd+Opt+I`) available; document a VS Code `--inspect` attach config for main.
- **Acceptance:** editing a `.tsx` hot-updates the Electron window with state preserved;
  editing `src/main/*` restarts only the shell; `npm run dev` (browser-only) is unchanged.

### Phase 9 — Supporting infra (Makefile, CI, scripts, docs)
See §7 and §8 for the concrete diffs.

### Phase 10 — Parity verification
Run the acceptance matrix in §9 end-to-end in the packaged app before declaring done.

---

## 7. Supporting-infra changes (consolidated)

### `package.json` (scripts)
```jsonc
{
  "main": "dist/main/index.mjs",
  "scripts": {
    // renderer (unchanged)
    "dev:web": "vite",
    "build:web": "vite build",
    // daemon
    "dev:server": "tsx watch src/server/index.ts",
    "build:server": "esbuild src/server/index.ts --bundle --platform=node --format=esm --target=node22 --alias:@shared=./src/shared --outfile=dist/server/index.mjs",
    // electron
    "build:main": "esbuild src/main/index.ts src/preload/index.ts --bundle --platform=node --format=esm --target=node22 --external:electron --alias:@shared=./src/shared --outdir=dist --out-extension:.js=.mjs --entry-names=[dir]/index",
    "dev:electron": "electronmon .",
    "dev:desktop": "concurrently -n server,web,shell \"npm:dev:server\" \"npm:dev:web\" \"npm:dev:electron\"",
    // satellites
    "build:mcp": "esbuild src/mcp/server.ts --bundle --platform=node --format=esm --target=node22 --alias:@shared=./src/shared --outfile=dist/satellites/mcp.mjs",
    "build:hook": "esbuild hooks/harness-hook.mjs --bundle --platform=node --format=esm --target=node22 --outfile=dist/satellites/hook.mjs",
    // aggregate + package
    "build": "npm run build:web && npm run build:server && npm run build:main && npm run build:mcp && npm run build:hook",
    "package": "npm run build && electron-builder --mac",
    "start": "tsx src/server/index.ts",             // standalone daemon still works
    "typecheck": "tsc -b",
    "test": "node --test --import tsx 'test/**/*.test.ts'"
  }
}
```
> Note the `dist/mcp/server.mjs` path referenced by `README`/`hooks/install.mjs` moves under
> `dist/satellites/`; update both references (or keep a copy) so the dev-flow MCP command
> still resolves.

### `Makefile`
Keep every existing target (the standalone daemon lifecycle is still valid for headless dev).
Add:
```make
desktop: ## Electron shell + daemon + Vite, all auto-reload (Ctrl-C to stop)
	npm run dev:desktop

app: ## Build and package the macOS app into release/
	npm run package

install-app: app ## Build, package, and copy Fleet Control.app into /Applications
	@rm -rf "/Applications/Fleet Control.app"
	@cp -R "release/mac-arm64/Fleet Control.app" /Applications/ && echo "installed to /Applications"
```
`make up`/`down` (which `pkill -f src/server/index.ts`) still manage the **dev** daemon; the
packaged app supervises its own, so they don't collide.

### `scripts/install-service.mjs`
Keep it for a **headless** daemon deployment, but it's superseded by the app's **Start at
login** toggle for desktop use. Add a one-line note to its output and the README that the two
mechanisms coexist safely (the app **adopts** a LaunchAgent daemon rather than double-binding
`:7317`); recommend picking one to avoid confusion.

### `README.md`
Add a "Desktop app" section: `make app` / install to `/Applications`, "Install Claude
integrations" from the menu, and `make desktop` for development. Keep the existing
web/daemon docs (still valid).

---

## 8. CI changes (`.github/workflows/ci.yml`)

Keep the existing `check` matrix (typecheck + test + build) - now it also exercises the
new bundles. Two adjustments + one new job:

- **`check` job (ubuntu, node 24/25):** `npm run build` now builds web + server + main + mcp
  + hook bundles (no native deps to compile). The daemon still runs under system Node here.
- **New `package` job (macOS, gated):** on `push` tags / `workflow_dispatch` only (Electron
  packaging is slow), run on `macos-14` (arm64):
  ```yaml
  package:
    if: startsWith(github.ref, 'refs/tags/') || github.event_name == 'workflow_dispatch'
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: '22', cache: npm }   # match Electron's Node line
      - run: npm ci
      - run: npm run package            # esbuild bundles + electron-builder (no native rebuild)
      - uses: actions/upload-artifact@v4
        with: { name: fleet-control-dmg, path: release/*.dmg }
  ```
  This verifies native rebuild + packaging on every release without burdening PR CI.

> `permissions: contents: read` stays; the packaging job needs no extra scopes (ad-hoc sign,
> no notarization).

---

## 9. Functionality-parity acceptance matrix

Verify each in the **packaged** app (launched from Finder, no terminal, no system `node` on
`PATH` for the app itself):

| Capability | How to verify | Depends on |
|---|---|---|
| Passive discovery + names + branch/uptime | live sessions appear grey "running" | daemon PATH (D3) |
| Live SSE grid transitions | start/stop a session → card updates | window loads loopback URL |
| Send / focus / kill | act on a card; focus raises the wezterm/tmux tab | daemon PATH |
| Precise status (hooks) | new Claude session flips grey→blue in ~1s | integrations installer (D5) |
| Review channel (MCP) | `request_review` shows a diff; decision returns | MCP satellite + token |
| Dispatch (worktree + detached tmux) | dispatch a task; agent appears with intent chip | daemon PATH + treehouse |
| no-mistakes strip + approve/fix/skip | gated repo shows pipeline; respond to a gate | daemon PATH |
| Fleet report / copy-as-markdown | Report panel; clipboard copy works | loopback = secure context |
| Transcript stream / diff view | expand a card | EventSource over loopback |
| Persistence across restart | dispatch, quit app, relaunch → backlog intact | node:sqlite (D1) |
| **Alerts with window hidden** | hide window; trigger needs-input → OS notif + chime | hide-on-close (D4) |
| AFK digest | enable AFK; wait one interval → digest notif | renderer stays alive |
| External links | click a PR link in a report → opens default browser | navigation handler (D6) |
| Start at login | toggle; reboot → app returns to the tray | `setLoginItemSettings` |

---

## 10. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `node:sqlite` missing from a future Electron/Node line | low | Spike-confirmed present in Electron 43 / Node 24; pin the Electron major; `better-sqlite3` is the documented one-file fallback |
| GUI app can't find `tmux`/`wezterm`/`no-mistakes` (minimal Finder PATH) | **high if unhandled** | D3 login-shell PATH injection into the daemon env; existing `resolveWeztermBin`/`*_BIN` overrides as backstop |
| Satellites can't resolve a runtime after install | med | D5: prefer resolved system `node`, fall back to `ELECTRON_RUN_AS_NODE`; installer writes a concrete absolute command |
| Hidden renderer throttled → missed alerts | low | `backgroundThrottling: false`; hide (not minimize); verify AFK digest timer fires while hidden |
| Window navigates away from daemon origin (dead app) | med | `will-navigate`/`setWindowOpenHandler` restrict in-window nav to the loopback origin, route the rest to `shell.openExternal` |
| Gatekeeper blocks an unsigned app | med | Ad-hoc sign in `electron-builder`; document `xattr -dr com.apple.quarantine` for the local install |
| Daemon startup race → blank window | low | Retry `loadURL` until `/api/health` passes; show a "Connecting…" state |
| Double daemon (LaunchAgent + app) | low | Adopt-or-spawn (D2): app adopts a healthy `:7317` and never double-binds |
| `routes.ts` version read / static root break when bundled | med | esbuild `--define` the version; serve static from an absolute `FLEET_WEB_DIR` (Phase 2) |

---

## 11. Coexistence & rollback

- Through Phases 0–2 the project is still a normal web app: `npm run dev`, `npm start`, and
  the LaunchAgent all behave exactly as before. There is no runtime-visible change to the
  daemon (D1 keeps `node:sqlite`); only new build scripts and bundles are added.
- Electron (Phases 3–8) is additive - new files under `src/main`, `src/preload`, and new
  scripts. Deleting those and reverting `"main"` returns the repo to the web app.
- The packaged app and the headless daemon share the same `~/.fleet-control` state dir, port,
  and token, so you can switch between "app" and "browser + LaunchAgent" freely without data
  migration.

---

## 12. Effort estimate

| Phase | Focus | Est. |
|---|---|---|
| 0 | Tooling, tsconfig split, deps | 0.5 d |
| 1 | SQLite driver swap | 0.5 d |
| 2 | Server + satellite bundling, `FLEET_WEB_DIR` | 0.5–1 d |
| 3 | Electron shell + daemon supervisor + PATH | 1.5 d |
| 4 | Tray / menu bar | 0.5 d |
| 5 | Alerts-while-hidden + verification | 0.5 d |
| 6 | Integrations installer (satellites) | 1 d |
| 7 | `electron-builder` packaging, native rebuild, icons, ad-hoc sign | 1–1.5 d |
| 8 | Dev experience (electronmon, HMR wiring) | 0.5 d |
| 9 | Makefile / CI / scripts / README | 0.5 d |
| 10 | Parity verification pass | 0.5 d |
| | **Total** | **~7–8 focused days** |

A runnable end-to-end prototype (Phases 1–4: window + supervised daemon + tray, dev-loaded)
lands in **~2 days**; the remaining time is the productionization that makes it a real,
self-contained, integration-installing app with no regressions.
```
