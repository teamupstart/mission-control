import type { StartupScreen } from "./window-startup.ts";
import { BASE_URL } from "@shared/harness-runtime.mjs";
import type { BinaryEnrollment } from "../shared/binary-enrollment.ts";

// Handled by this window's navigation guard only. The page needs no script or extra IPC.
export const STARTUP_RETRY_URL = `${BASE_URL}/__mission-startup-retry`;
export const BINARY_INSTALL_CONFIRM_URL = "https://mission-control.invalid/install";
export const BINARY_INSTALL_CANCEL_URL = "https://mission-control.invalid/quit";

const COPY: Record<StartupScreen, { title: string; description: string }> = {
  starting: {
    title: "Starting Mission Control",
    description: "Getting your workspace ready. Your dashboard will open automatically.",
  },
  slow: {
    title: "Still starting Mission Control",
    description: "The local service is taking longer than expected. We will keep trying, or you can retry now.",
  },
  error: {
    title: "Reconnecting to Mission Control",
    description: "The dashboard could not load. We will keep trying, or you can retry now.",
  },
};

/** Built into the shell: it must render before the daemon can serve any assets. */
export function startupPage(screen: StartupScreen, launchWarning: string | null = null): string {
  const warning = launchWarning ? escapeText(launchWarning) : null;
  const { title, description } = COPY[screen];
  return localShellPage(`<div class="mark" aria-hidden="true"></div><div role="status"><h1>${title}</h1><p>${description}</p></div>
${warning ? `<p class="warning" role="alert">${warning}</p>` : ""}
${screen === "starting" ? "" : `<a href="${STARTUP_RETRY_URL}">Retry now</a><p class="hint">If this continues, quit and reopen Mission Control.</p>`}`);
}

/** An installation choice cannot start the daemon just to draw its confirmation. */
export function binaryInstallationPage(enrollment: BinaryEnrollment): string {
  return localShellPage(`<div class="mark idle" aria-hidden="true"></div>
<h1 id="installation-title">Install Mission Control</h1>
<p>${escapeText(enrollment.message)}</p>
<p class="destination">Destination: ${escapeText(enrollment.destination)}</p>
<div class="actions"><a href="${BINARY_INSTALL_CONFIRM_URL}">Install Mission Control</a><a class="secondary" href="${BINARY_INSTALL_CANCEL_URL}">Quit</a></div>
<p class="hint">Installation progress is saved in binary-install.log in your state home.</p>`, true);
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function localShellPage(content: string, installation = false): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Mission Control</title><style>
:root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e6edf3;background:#0e1116}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:80px 32px 40px}
header{position:fixed;inset:0 0 auto;height:76px;-webkit-app-region:drag;border-bottom:1px solid #232b35}
header span{display:block;margin:29px 0 0 108px;font-size:12px;letter-spacing:.12em;color:#98a8bb}
main{width:min(100%,440px)}.mark{width:48px;height:48px;border:1px solid #315749;border-radius:14px;display:grid;place-items:center;margin-bottom:28px;color:#67d9ac;background:#152b24}
.mark:after{content:"";width:16px;height:16px;border:2px solid currentColor;border-radius:50%;border-right-color:transparent;animation:spin 1.4s linear infinite}
h1{font-size:26px;line-height:1.2;letter-spacing:-.025em;margin:0 0 16px;font-weight:600}
p{margin:0;color:#acb8c8;line-height:1.65;font-size:15px}a{display:inline-block;margin-top:26px;color:#d0f7e5;background:#203f32;border:1px solid #416f59;border-radius:7px;padding:9px 17px;text-decoration:none;font-size:14px;font-weight:600;-webkit-app-region:no-drag}
a:hover{background:#2a5040}a:focus-visible{outline:2px solid #86e4bc;outline-offset:4px}.warning{white-space:pre-wrap;overflow-wrap:anywhere;color:#ffb4ab;margin-top:24px}.hint{font-size:13px;margin-top:24px;color:#98a8bb}
main.installation{width:min(100%,536px);padding:28px;border:1px solid #232b35;border-radius:14px;background:#12171e}.mark.idle:after{content:"↓";animation:none;border:0;width:auto;height:auto;font-size:26px}.destination{margin-top:20px;overflow-wrap:anywhere;color:#e6edf3}.actions{display:flex;gap:12px;flex-wrap:wrap}.secondary{background:transparent;border-color:#384352;color:#acb8c8}
@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.mark:after{animation:none}}
</style></head><body><header><span>MISSION CONTROL</span></header><main${installation ? ' class="installation" role="dialog" aria-labelledby="installation-title"' : ""}>
${content}
</main></body></html>`;
}
