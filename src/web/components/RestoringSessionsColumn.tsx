import type { RestoringSession } from "@shared/types.ts";
import { repoLeaf } from "../lib/format.ts";
import { repoColor } from "../lib/repo-color.ts";
import { Tooltip } from "./Tooltip.tsx";

function card(session: RestoringSession): React.JSX.Element {
  const context = session.repoRoot ?? session.cwd;
  return (
    <article
      className="restoring-tile"
      key={session.id}
      role="status"
      aria-label={`Restoring ${session.name}`}
      data-session-id={session.id}
    >
      <div className="restoring-tile-head">
        <span className="restoring-tile-spinner" aria-hidden="true" />
        <strong>{session.name}</strong>
      </div>
      <Tooltip label={context}>
        <span className="restoring-tile-meta">
          {session.agent ?? "unknown agent"} · {repoLeaf(context)}
        </span>
      </Tooltip>
      <span className="restoring-tile-state">Restoring</span>
    </article>
  );
}

/**
 * The Board-only home for persisted SDK rows whose drivers are still restoring.
 *
 * It is a separate column and separate component so none of the ordinary tile behaviors are
 * reachable: no selection, drag target, action bar, composer, workflow disclosure, live fleet
 * count, or fleet tone. Repository grouping is presentation only and carries no real-session
 * totals. The hook suppresses any row whose stable id has already appeared in `sessions`.
 */
export function RestoringSessionsColumn({
  sessions,
  groupByRepo,
}: {
  sessions: RestoringSession[];
  groupByRepo: boolean;
}): React.JSX.Element | null {
  if (sessions.length === 0) return null;
  const ordered = [...sessions].sort(
    (a, b) =>
      (a.repoRoot ?? "\uffff").localeCompare(b.repoRoot ?? "\uffff") ||
      a.name.localeCompare(b.name) ||
      a.createdAt - b.createdAt,
  );

  const groups = new Map<string | null, RestoringSession[]>();
  for (const session of ordered) {
    const key = groupByRepo ? session.repoRoot : null;
    const group = groups.get(key) ?? [];
    group.push(session);
    groups.set(key, group);
  }

  return (
    <section className="board-col restoring-col" aria-label="Restoring sessions">
      <header className="board-col-head">
        <span className="board-swatch" aria-hidden="true" />
        <h2>restoring</h2>
        <span className="restoring-col-note">not live yet</span>
      </header>
      <div className="board-col-body">
        {[...groups].map(([repoRoot, rows]) =>
          repoRoot ? (
            <div
              className="restoring-repo"
              key={repoRoot}
              style={{ "--repo-c": repoColor(repoRoot) } as React.CSSProperties}
            >
              <Tooltip label={repoRoot}>
                <div className="restoring-repo-head">
                  <span aria-hidden="true" />
                  <strong>{repoLeaf(repoRoot)}</strong>
                </div>
              </Tooltip>
              {rows.map(card)}
            </div>
          ) : (
            rows.map(card)
          ),
        )}
      </div>
    </section>
  );
}
