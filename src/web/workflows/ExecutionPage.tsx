import type { ReactNode } from "react";

/**
 * The frame the two execution pages share: an eyebrow, a title, and a link out.
 *
 * What is left of `WorkflowPage` after its tab strip retired. The strip is what that page
 * WAS - two tabs holding the execution surfaces while the Library took the authoring ones -
 * and with Runs and Ensembles now hung off the Line as top-level routes there is nothing for
 * it to switch between. The header survived because it is doing a different job: the eyebrow
 * says which half of the product you are in, and an operator arriving from a bookmark has no
 * strip above them to say it.
 *
 * A frame rather than two hand-written headers, so the two pages cannot drift into two
 * spellings of "Execution" - which is exactly what a tab strip used to prevent for free.
 */
export function ExecutionPage({
  title,
  /** One line under the title: what this page is for, in the operator's terms. */
  blurb,
  /** The trailing link out - Workflow settings, and nothing that mutates. */
  actions = null,
  children,
}: {
  title: string;
  blurb: string;
  actions?: ReactNode;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <main className="workflow-page">
      <header className="workflow-page-head">
        <div>
          <p className="workflow-eyebrow">Execution</p>
          <h2>{title}</h2>
        </div>
        <p className="workflow-page-blurb">{blurb}</p>
        {actions}
      </header>
      {children}
    </main>
  );
}
