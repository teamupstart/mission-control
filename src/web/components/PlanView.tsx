import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Render an agent-shared plan as GitHub-flavored markdown. */
export function PlanView({ markdown }: { markdown: string }): React.JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </div>
  );
}
