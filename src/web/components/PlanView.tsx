import { Markdown } from "./Markdown.tsx";

/** Render an agent-shared plan as GitHub-flavored markdown. */
export function PlanView({ markdown }: { markdown: string }): React.JSX.Element {
  return (
    <div className="markdown">
      <Markdown>{markdown}</Markdown>
    </div>
  );
}
