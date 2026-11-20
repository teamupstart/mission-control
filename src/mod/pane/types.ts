import type { ModHost, ModPanePlacement, ModPaneTab } from "../host.ts";

/**
 * A pane view as plain data, so tests assert it without the engine. `register.ts` turns it into
 * the engine's elements (P8 for the seam, P12 for the content). Owner after P2: P12.
 */
export interface PaneButton {
  label: string;
  hotkey?: string;
  press: () => void | Promise<void>;
}

export interface PaneView {
  tab: ModPaneTab;
  placement: ModPanePlacement;
  lines: string[];
  buttons: PaneButton[];
}

/** What a `ui.render` on the pane gives the draw: `e.props.placement` and `e.props.bodyColumns`. */
export interface PaneProps {
  placement: ModPanePlacement;
  bodyColumns: number;
  tab: ModPaneTab;
}

export type TabRenderer = (host: ModHost, props: PaneProps) => PaneView;

export const PANE_NOT_IMPLEMENTED = "not implemented";

export function stubTab(tab: ModPaneTab): TabRenderer {
  return (_host, props) => ({ tab, placement: props.placement, lines: [PANE_NOT_IMPLEMENTED], buttons: [] });
}
