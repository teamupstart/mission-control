import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { RichTextProvider } from "./lib/rich-text.tsx";
import "./styles.css";

// In the Electron shell the window has no native title bar (titleBarStyle:
// "hiddenInset"), so the topbar doubles as it: this flag turns on the traffic-
// light inset and the drag region. In a plain browser tab neither applies.
if (window.missionDesktop?.isDesktop) document.documentElement.classList.add("is-desktop");

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <RichTextProvider>
      <App />
    </RichTextProvider>
  </StrictMode>,
);
