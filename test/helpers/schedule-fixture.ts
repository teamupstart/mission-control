import type {
  MissionSchedule,
  ScheduleOccurrence,
  ScheduleOccurrenceSummary,
  ScheduleTemplate,
} from "../../src/shared/schedules.ts";

/**
 * A representative live schedule for the Recurring Missions render tests, and the one
 * place a required `MissionSchedule` field is added when the type grows. Every field is
 * overridable so a test that cares about one says so and stays readable.
 */

export function mkScheduleTemplate(over: Partial<ScheduleTemplate> = {}): ScheduleTemplate {
  return {
    title: "Run dependency audit",
    intent: "Audit dependencies and open a PR if anything changed.",
    repoRoot: "/Users/dev/workspace/mission-control",
    kind: "ship",
    agent: "claude",
    priority: null,
    labels: [],
    model: null,
    effort: null,
    ...over,
  };
}

export function mkOccurrenceSummary(
  over: Partial<ScheduleOccurrenceSummary> = {},
): ScheduleOccurrenceSummary {
  return {
    id: "occ-1",
    scheduledFor: 1_753_600_000_000,
    claimedAt: 1_753_600_000_000,
    finishedAt: 1_753_600_001_000,
    status: "created",
    triggerKind: "scheduled",
    taskId: "task-1",
    delayMs: 0,
    error: null,
    ...over,
  };
}

export function mkSchedule(over: Partial<MissionSchedule> = {}): MissionSchedule {
  return {
    id: "sched-1",
    name: "Dependency audit",
    enabled: true,
    archivedAt: null,
    expression: "0 8 * * 1",
    timezone: "America/New_York",
    overlapPolicy: "skip-active",
    missedPolicy: "coalesce-latest",
    executionMode: "local-catchup",
    runnerId: null,
    revision: 1,
    template: mkScheduleTemplate(),
    nextRunAt: 1_753_600_000_000,
    lastOccurrence: mkOccurrenceSummary(),
    unreadable: null,
    health: "healthy",
    healthReasons: [],
    createdAt: 1_753_000_000_000,
    updatedAt: 1_753_000_000_000,
    ...over,
  };
}

export function mkOccurrence(over: Partial<ScheduleOccurrence> = {}): ScheduleOccurrence {
  return {
    ...mkOccurrenceSummary(),
    scheduleId: "sched-1",
    scheduleRevision: 1,
    decisionKind: "create_task",
    coveredById: null,
    blockingTaskId: null,
    createdAt: 1_753_600_000_000,
    ...over,
  };
}
