import { parseDiff, Diff, Hunk, type FileData } from "react-diff-view";
import "react-diff-view/style/index.css";

/**
 * Render a unified/git diff. Falls back to raw text if the diff can't be parsed
 * (agents don't always produce a clean `git diff`).
 */
export function DiffView({ diff }: { diff: string }): React.JSX.Element {
  let files: FileData[] = [];
  try {
    files = parseDiff(diff);
  } catch {
    files = [];
  }
  if (files.length === 0) {
    return <pre className="raw-diff">{diff}</pre>;
  }

  let added = 0;
  let removed = 0;
  for (const f of files)
    for (const h of f.hunks)
      for (const c of h.changes) {
        if (c.type === "insert") added++;
        else if (c.type === "delete") removed++;
      }

  return (
    <div className="diffview">
      <div className="diff-stats">
        <span>{files.length} file{files.length > 1 ? "s" : ""}</span>
        <span className="add">+{added}</span>
        <span className="del">-{removed}</span>
      </div>
      {files.map((file, i) => (
        <div className="diff-file" key={i}>
          <div className="diff-file-head mono">
            {file.oldPath && file.oldPath !== file.newPath ? `${file.oldPath} → ` : ""}
            {file.newPath || file.oldPath}
          </div>
          <Diff viewType="unified" diffType={file.type} hunks={file.hunks}>
            {(hunks) => hunks.map((h) => <Hunk key={h.content} hunk={h} />)}
          </Diff>
        </div>
      ))}
    </div>
  );
}
