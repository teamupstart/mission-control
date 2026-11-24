import { fleetRows, type FleetColumn, type FleetRow } from "./fleet-order.ts";

type SectionKind = Extract<FleetRow, { kind: "section" }>["section"] | "blocked";
type SessionRow = Exclude<FleetRow, { kind: "section" }>;

interface IdleRailSection {
  key: string;
  kind: SectionKind;
  rows: SessionRow[];
  sessionIds: string[];
}

export interface IdleRailSections {
  sections: readonly (IdleRailSection & { expanded: boolean })[];
  onToggle: (key: string, expanded: boolean) => void;
}

/** Keep the fleet's section boundaries, repository frames, and run clusters in their drawn order. */
export function idleRailSections(column: FleetColumn): IdleRailSection[] {
  const sections: IdleRailSection[] = [];
  const start = (kind: SectionKind, key: string = kind): IdleRailSection => {
    const section = {
      key,
      kind,
      rows: [],
      sessionIds: [],
    };
    sections.push(section);
    return section;
  };
  if (column.blocked.length) {
    const blocked = start("blocked");
    blocked.sessionIds = column.blocked.map((session) => session.id);
    blocked.rows = column.blocked.map((session) => ({ kind: "session", session }));
  }
  const group = column.group;
  if (!group) return sections;
  let section: IdleRailSection | undefined;
  for (const row of fleetRows(group)) {
    if (row.kind === "section") {
      // A Free rule before the Awaiting span belongs to pinned residents.
      const pinnedFree = row.section === "free" && group.awaiting && !sections.some((item) => item.key === "awaiting");
      section = start(row.section, pinnedFree ? "pinned-free" : row.section);
      continue;
    }
    // Before the first rule, rows are either the unsplit Free group or pinned Awaiting residents.
    section ??= group.awaitingCount > (group.awaiting?.length ?? 0)
      ? start("awaiting", "pinned-awaiting")
      : start("free");
    section.rows.push(row);
    const blocks = row.kind === "repo" ? row.blocks : [row];
    for (const block of blocks) {
      section.sessionIds.push(...(block.kind === "session" ? [block.session.id] : block.sessions.map((session) => session.id)));
    }
  }
  return sections;
}
