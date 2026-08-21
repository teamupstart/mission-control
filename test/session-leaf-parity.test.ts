import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsoleDetail } from "../src/web/components/layouts/ConsoleDetail.tsx";
import { RailRow } from "../src/web/components/layouts/RailRow.tsx";
import { SessionTile } from "../src/web/components/layouts/SessionTile.tsx";
import {
  AgentDot,
  EnsembleChip,
  EnsembleRailMark,
  EnsembleTileFlag,
  InspectorChip,
  InspectorRailMark,
  InspectorTileFlag,
  RuntimeMetaRow,
  RuntimeTileFlag,
  ScheduleOriginChip,
  ScheduleOriginRailMark,
  ScheduleOriginTileFlag,
  SessionWhere,
  ensembleMemberStateLabel,
  ensembleMemberTone,
  runtimeRailMark,
} from "../src/web/components/session-bits.tsx";
import type { Session } from "../src/shared/types.ts";
import {
  meta,
  mkEnsembleLink,
  mkEnsembleSummary,
  mkSession,
  mkTaskSummary,
} from "./helpers/session-fixture.ts";
import { mkSessionView } from "./helpers/session-view.ts";
import { containsMarkup } from "./helpers/markup.ts";

function detail(session: Session, over: Parameters<typeof mkSessionView>[1] = {}): string {
  return renderToStaticMarkup(createElement(ConsoleDetail, {
    session,
    view: mkSessionView(session, over),
  }));
}

function tile(
  session: Session,
  over: Partial<Parameters<typeof SessionTile>[0]> = {},
): string {
  return renderToStaticMarkup(createElement(SessionTile, {
    session,
    onOpen: () => {},
    draggingRepo: null,
    onDropped: () => {},
    onDropError: () => {},
    onDropConfirm: () => {},
    ...over,
  }));
}

function rail(
  session: Session,
  over: Partial<Parameters<typeof RailRow>[0]> = {},
): string {
  return renderToStaticMarkup(createElement(RailRow, {
    session,
    selected: false,
    onSelect: () => {},
    ...over,
  }));
}

function bit<P extends object>(
  component: (props: P) => React.JSX.Element | null,
  props: P,
): string {
  return renderToStaticMarkup(createElement(component, props));
}

test("the shared detail and Board tile use the common agent and runtime leaves", () => {
  const session = mkSession({ meta: meta({ contextPct: 73 }) });
  assert.ok(containsMarkup(detail(session), bit(AgentDot, { agent: session.agent })));
  assert.ok(containsMarkup(detail(session), bit(RuntimeMetaRow, { meta: session.meta!, session })));
  assert.ok(containsMarkup(tile(session), bit(AgentDot, { agent: session.agent })));
  assert.ok(containsMarkup(tile(session), bit(RuntimeTileFlag, { session })));
});

test("Inspector state reaches detail, tile, and rail through shared leaves", () => {
  const session = mkSession({
    inspector: {
      prKey: "o/r#7",
      url: "https://example.test/pr/7",
      mode: "dry-run",
      open: 2,
      postedOpen: 0,
      round: 1,
      lastReviewedAt: 1,
      failed: false,
    },
  });
  assert.ok(containsMarkup(detail(session), bit(InspectorChip, { session })));
  assert.ok(containsMarkup(tile(session), bit(InspectorTileFlag, { session })));
  assert.ok(containsMarkup(rail(session), bit(InspectorRailMark, { session })));
});

test("scheduled task provenance reaches every surviving session surface", () => {
  const task = mkTaskSummary({
    scheduleId: "sched-1",
    scheduleOccurrenceId: "occ-1",
    scheduledFor: 1_753_600_000_000,
  });
  const session = mkSession({ task });
  const scheduleNames = new Map([["sched-1", "Dependency audit"]]);
  const props = { task, scheduleNames };
  assert.ok(containsMarkup(
    detail(session, { onOpenSchedule: () => {}, scheduleNameById: scheduleNames }),
    bit(ScheduleOriginChip, props),
  ));
  assert.ok(containsMarkup(
    tile(session, { onOpenSchedule: () => {}, scheduleNameById: scheduleNames }),
    bit(ScheduleOriginTileFlag, props),
  ));
  assert.ok(containsMarkup(
    rail(session, { onOpenSchedule: () => {}, scheduleNameById: scheduleNames }),
    bit(ScheduleOriginRailMark, props),
  ));
});

test("ensemble membership reaches every surviving session surface", () => {
  const link = mkEnsembleLink({ ordinal: 2, maxMembers: 5, status: "active" });
  const summary = mkEnsembleSummary({ maxMembers: 5, launchedMembers: 3, membersReady: 1 });
  const session = mkSession({ task: mkTaskSummary({ ensemble: link }) });
  assert.ok(containsMarkup(
    detail(session, { ensembleSummaryByRun: new Map([[summary.id, summary]]) }),
    bit(EnsembleChip, { link, summary }),
  ));
  assert.ok(containsMarkup(tile(session), bit(EnsembleTileFlag, { link })));
  assert.ok(containsMarkup(rail(session), bit(EnsembleRailMark, { link })));
});

test("a blocked ensemble member has one state decision in every vocabulary", () => {
  const blocked = mkEnsembleLink({ status: "submitted", resultLabel: "rank 1", needsInput: true });
  assert.equal(ensembleMemberStateLabel(blocked), "needs an answer");
  assert.equal(ensembleMemberTone(blocked), "blocked");
  for (const fragment of [
    bit(EnsembleChip, { link: blocked }),
    bit(EnsembleTileFlag, { link: blocked }),
    bit(EnsembleRailMark, { link: blocked }),
  ]) {
    assert.match(fragment, /ensemble-blocked/);
  }
});

test("embedded runtime provenance reaches detail, tile, and rail", () => {
  const session = mkSession({ runtime: "sdk", nameSource: "sdk", terminals: [] });
  assert.ok(containsMarkup(detail(session), bit(SessionWhere, { session })));
  assert.ok(containsMarkup(tile(session), bit(RuntimeTileFlag, { session })));
  assert.match(rail(session), new RegExp(runtimeRailMark(session)!));
});
