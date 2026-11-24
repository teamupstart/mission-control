import type { ModHost, ModPanePlacement, ModPaneTab } from "../host.ts";
import type { PaneController } from "./controller.ts";

/**
 * A pane view as plain data, so tests assert it without the engine. `register.ts` turns it into
 * the engine's elements. Owner after P2: P12.
 *
 * `nodes` is the draw order, which is also the focus order: the engine's ring walks buttons and
 * inputs as they are drawn, so answer buttons sit above any text field and take focus first.
 * `lines`, `buttons` and `inputs` are the same content split by kind, for tests that ask one
 * question of one kind.
 */
export interface PaneButton {
  label: string;
  /** One digit or lowercase letter; pressed only while the pane holds the keyboard. */
  hotkey?: string;
  /** `tab` and `nav` are chrome; `row` opens an item; `action` (the default) answers or decides. */
  group?: "tab" | "nav" | "row" | "action";
  /** The engine's focus ring starts here when the pane takes the keyboard. */
  autoFocus?: true;
  press: () => void | Promise<void>;
}

export interface PaneInput {
  key: string;
  placeholder: string;
  value: string;
  submitLabel: string;
  onInput: (value: string) => void;
  onSubmit: (value: string) => void | Promise<void>;
}

export interface PaneLine {
  text: string;
  dim?: boolean;
  bold?: boolean;
  tone?: "ok" | "error";
}

export type PaneNode =
  | { kind: "text"; line: PaneLine }
  | { kind: "button"; button: PaneButton }
  | { kind: "input"; input: PaneInput };

export interface PaneView {
  tab: ModPaneTab;
  placement: ModPanePlacement;
  lines: string[];
  buttons: PaneButton[];
  inputs?: PaneInput[];
  nodes?: PaneNode[];
}

/** What a `ui.render` on the pane gives the draw: `e.props.placement` and `e.props.bodyColumns`. */
export interface PaneProps {
  placement: ModPanePlacement;
  bodyColumns: number;
  tab: ModPaneTab;
  /** The session's pane controller. Without one (the P2 skeleton) a tab draws its empty state. */
  ctl?: PaneController;
  /** The clock for ages, so a test draws the same frame twice. Default `Date.now()`. */
  now?: number;
}

export type TabRenderer = (host: PaneRenderHost, props: PaneProps) => PaneView;

/** What a renderer may be handed: any host. The controller in `props.ctl` holds the real one. */
export type PaneRenderHost = Pick<ModHost, "fetch">;

export const PANE_NOT_IMPLEMENTED = "not implemented";

export function stubTab(tab: ModPaneTab): TabRenderer {
  return (_host, props) => ({ tab, placement: props.placement, lines: [PANE_NOT_IMPLEMENTED], buttons: [] });
}
