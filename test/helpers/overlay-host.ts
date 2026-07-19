import { createElement } from "react";
import { OverlayHost, type OverlayHostValue } from "../../src/web/components/Overlay.tsx";

/**
 * A host for rendering an overlay in a test.
 *
 * `<Overlay>` refuses to render without one, deliberately: an overlay that isn't
 * registered isn't counted as open, which leaves App's global key handler live behind it.
 * So tests get a real host rather than an opt-out - the contract is the same one the app
 * runs under.
 *
 * Inert because `renderToStaticMarkup` never runs effects, so nothing would register
 * anyway; these tests are about what an overlay RENDERS. The registry's own behaviour is
 * covered in overlay-registry.test.ts.
 */
export const INERT_OVERLAY_HOST: OverlayHostValue = {
  openIds: [],
  anyOpen: false,
  onlyOpen: () => true,
  register: () => () => {},
};

export function withOverlayHost(children: React.ReactNode): React.JSX.Element {
  return createElement(OverlayHost, { value: INERT_OVERLAY_HOST, children });
}
