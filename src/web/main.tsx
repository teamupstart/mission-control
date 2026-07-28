import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { hydrateUiConfig } from "./lib/uiConfig.ts";
import "@xyflow/react/dist/style.css";
// Global vendor CSS belongs at the browser entry rather than inside `DiffView`: the latter is
// reached by reusable review cards, including server-rendered component tests, while this file
// is the one surface that actually boots the stylesheet-aware Vite application.
import "react-diff-view/style/index.css";
import "./styles.css";

// In the Electron shell the window has no native title bar (titleBarStyle:
// "hiddenInset"), so the topbar doubles as it: this flag turns on the traffic-
// light inset and the drag region. In a plain browser tab neither applies.
if (window.missionDesktop?.isDesktop) document.documentElement.classList.add("is-desktop");

// Reconcile the dashboard's preferences with the daemon, which owns them. Fired here
// rather than from an effect in App because it is not App's state: the layout, the
// keybindings, the alert toggles and the rich-text switch all read one module store, and
// three of those four are used outside the tree. The first paint has already happened
// from the local cache by the time this resolves, so there is nothing to wait for.
void hydrateUiConfig();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
