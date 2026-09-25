// Mounts the REAL `DispatchLayer` in the browser, handed an opening the app itself can no
// longer produce.
//
// This file is loaded by the development dashboard through Vite's `/@fs/` route, never by the
// app and never by the build: it lives in `e2e/` precisely so the product carries no hook for
// it. It exists for one reason. A contradictory dispatch opening is unreachable through any
// control - that is the fix under test - so the only way a browser can show what the form
// does with one is to be given one directly, by the same component, under the same providers,
// in the same document as the running dashboard.
//
// Nothing here stands in for product code. The overlay registry is the app's own
// `useOverlayHost`, the catalog provider is the app's own, and the component is imported from
// `src/` rather than copied.
import { StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { DispatchLayer } from "../../src/web/components/DispatchModal.tsx";
import { OverlayHost, useOverlayHost } from "../../src/web/components/Overlay.tsx";
import { ModelCatalogProvider } from "../../src/web/model-catalog.tsx";
import type { DispatchOpening } from "../../src/web/lib/dispatch-mode.ts";

function Mounted({
  initial,
  expose,
}: {
  initial: unknown;
  expose: (set: (opening: unknown) => void) => void;
}): React.JSX.Element {
  const overlays = useOverlayHost();
  const [opening, setOpening] = useState<unknown>(initial);
  expose(setOpening);
  return (
    <OverlayHost value={overlays}>
      {/* Cast on purpose: the whole point is a value that did not come through the compiler. */}
      <DispatchLayer opening={opening as DispatchOpening | null} onClose={() => setOpening(null)} />
    </OverlayHost>
  );
}

export interface DispatchMount {
  /** Hand the SAME mounted layer a different opening, the way App re-renders it. */
  reopen(opening: unknown): void;
  unmount(): void;
}

export function mountDispatchLayer(opening: unknown): DispatchMount {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  let reopen: (next: unknown) => void = () => {};
  root.render(
    <StrictMode>
      <ModelCatalogProvider>
        <Mounted initial={opening} expose={(set) => (reopen = set)} />
      </ModelCatalogProvider>
    </StrictMode>,
  );
  return {
    reopen: (next) => reopen(next),
    unmount: () => {
      root.unmount();
      host.remove();
    },
  };
}
