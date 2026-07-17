import { SessionCard } from "../SessionCard.tsx";
import { cardProps, type SessionViewProps } from "./types.ts";

/**
 * The original layout, unchanged: every session is a card in a responsive grid,
 * and one card expands in place into focus mode.
 *
 * `gridRef` goes back to App because this is the only layout whose navigation is
 * geometric - the arrow keys need the live column count, which is a resolved CSS
 * track list, not something either of us can know from the session list.
 */
export function GridView(
  props: SessionViewProps & { gridRef: React.Ref<HTMLElement> },
): React.JSX.Element {
  return (
    <main className="grid" ref={props.gridRef}>
      {props.sessions.map((s) => (
        <SessionCard key={s.id} {...cardProps(props, s)} />
      ))}
    </main>
  );
}
