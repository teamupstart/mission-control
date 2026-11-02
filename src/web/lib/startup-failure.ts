export type StartupPhase = "load" | "render";

/** Independent of React and the dashboard import graph, so even a failed import can explain itself. */
export function showStartupFailure(root: HTMLElement, phase: StartupPhase): void {
  const doc = root.ownerDocument;
  const panel = doc.createElement("section");
  panel.setAttribute("role", "alert");
  // Inline because a failed application chunk may also mean its stylesheet never arrived.
  panel.setAttribute("style", "max-width: 48rem; margin: 4rem auto; padding: 1rem; font-family: system-ui, sans-serif");
  const title = doc.createElement("h1");
  title.textContent = "Mission Control could not start";
  const reason = doc.createElement("p");
  reason.textContent = phase === "load"
    ? "The dashboard JavaScript could not load or initialize."
    : "The dashboard encountered an unexpected rendering error.";
  const help = doc.createElement("p");
  help.textContent = "Reload this page. If it still fails, open Chrome DevTools and check Console and Network. For an SSM or SSH tunnel, forward the daemon port and open http://localhost:<local-port>/, not the EC2 hostname. Check that the Linux build completed and the daemon serves its matching assets.";
  // Deliberately do not print the exception, which can contain private local paths or session data.
  panel.append(title, reason, help);
  root.replaceChildren(panel);
}
