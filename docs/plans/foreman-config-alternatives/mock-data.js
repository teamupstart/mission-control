/**
 * The one source of truth for every mockup on this page set.
 *
 * Verified against the code, not remembered:
 *   - roles + blurbs      src/shared/foreman-models.ts  (FOREMAN_MODEL_SPECS)
 *   - role tiers          review/verify = deep, triage = cheap, backlog = balanced
 *   - provider defaults   src/shared/model.ts           (providerModelDefault)
 *   - safeguards          src/web/components/ForemanSettingsPanel.tsx
 *   - live repositories   src/web/components/TrustPanel.tsx (TrustGrantSummary)
 *   - option lists        read off the running daemon's own <select> elements
 *
 * TRUST IS NOT A FOREMAN SETTING. The Foreman panel shows a read-only grant COUNT and a
 * "Manage in Trust" deep link into the separate Trust category; the repo allowlist is
 * edited there and nowhere else. An earlier draft of these mockups gave Foreman a "Trust"
 * tab, which invented a control the panel does not have. Live repositories may appear here
 * only as a summary line that navigates away.
 */

// Provider is Codex in this snapshot, so every model list below is a CODEX list and every
// "Default - x" names the codex fallback for that role's tier. Switching the provider in
// the real panel clears all four role overrides and re-lists these, which is why a mockup
// may not mix a Claude model id into a Codex list.
const CODEX_MODELS = [
  "GPT-5.6 Sol - most capable",
  "GPT-5.6 Terra - balanced",
  "GPT-5.6 Luna - fastest",
  "GPT-5.5 - previous generation",
];

/* A classic script, deliberately not an ES module: these pages are opened straight off
   disk with file://, where module scripts fail the CORS check and silently render nothing.

   Assigned onto `window` rather than declared with `const`, for the same reason mock.js is
   wrapped in an IIFE: classic scripts share one global lexical scope, and a `const` here
   would make a page that declares the same name die with an uncaught SyntaxError before it
   rendered anything. */
window.FOREMAN = {
  posture: {
    tone: "danger",
    line: "Live - replying in sessions on your behalf",
    // What the topbar owns, not this panel. Listed so a mockup can say so accurately.
    ownedByTopbar: ["enabled", "mode", "work queues", "on-drain wrap-up"],
  },

  cheapTier: {
    value: "on",
    options: [
      { id: "off", short: "Off", label: "Off - full review for every prompt" },
      { id: "shadow", short: "Shadow", label: "Shadow - run the cheap tier alongside, measure it" },
      { id: "on", short: "On", label: "On - cheap tier answers the easy ones" },
    ],
  },

  provider: {
    value: "Codex",
    options: ["Claude Code", "Codex"],
    blurb:
      "Runs every Foreman model role through this provider. Foreman spawns a fresh, isolated call for each. Review and Verify are the expensive ones; Triage and Backlog are deliberately cheaper.",
  },

  // FOREMAN_MODEL_ROLES, in order, with the blurbs verbatim from FOREMAN_MODEL_SPECS.
  roles: [
    {
      id: "review",
      label: "Review",
      value: "GPT-5.6 Terra - balanced",
      fallback: "Default - gpt-5.6-sol",
      options: CODEX_MODELS,
      blurb: "Judges a stuck session's pending question - answer, escalate, or leave it.",
      cost: "expensive",
    },
    {
      id: "verify",
      label: "Verify",
      value: "GPT-5.6 Terra - balanced",
      fallback: "Default - gpt-5.6-sol",
      options: CODEX_MODELS,
      blurb: "Reads the diff and decides whether a queued work item is actually done.",
      cost: "expensive",
    },
    {
      id: "triage",
      label: "Triage",
      value: "GPT-5.6 Luna - fastest",
      fallback: "Default - gpt-5.6-luna",
      options: CODEX_MODELS,
      blurb: "The cheap Tier 1 router in front of Review. Buckets the ask; never solves it.",
      cost: "cheap",
    },
    {
      id: "backlog",
      label: "Backlog",
      value: "GPT-5.6 Luna - fastest",
      fallback: "Default - gpt-5.6-terra",
      options: CODEX_MODELS,
      blurb: "Reads the backlog once per change and orders it by what depends on what.",
      cost: "cheap",
    },
  ],

  safeguards: {
    blurb:
      "Choose which finished work Foreman retires without showing Ship it, running No-Mistakes Review, or typing Straight to PR. A task matching either enabled safeguard is kept out of every automatic completion action.",
    rows: [
      {
        id: "scout",
        label: "Skip automatic completion for Scout tasks",
        desc: "Uses the task's durable Kind. The scout's findings remain the finished output.",
        on: true,
      },
      {
        id: "artifact",
        label: "Skip automatic completion for mockups and review artifacts",
        desc: "Reads the resolved objective and artifact-only changed paths. Mixed work that also requests implementation still follows the normal completion action.",
        on: true,
      },
    ],
  },

  // A backlog launch runs the TASK's harness, not Foreman's provider, so these are three
  // independent per-harness lists and a Codex id here is not interchangeable with a Claude one.
  backlogLaunch: {
    blurb:
      "When Foreman starts a fresh backlog task, this selects its model unless the task already names one. Handing work to an existing session leaves that session's model unchanged.",
    rows: [
      {
        id: "claude",
        label: "Claude backlog tasks",
        value: "Opus 5 - strong all-rounder",
        options: [
          "Default - the Harnesses default",
          "Fable 5 - most capable, hardest work",
          "Opus 5 - strong all-rounder",
          "Opus 4.8 - previous-generation Opus",
          "Sonnet 5 - near-Opus, cheaper",
          "Haiku 4.5 - fastest, simple tasks",
        ],
        blurb: "Used when Foreman launches an unpinned Claude task from the backlog.",
      },
      {
        id: "codex",
        label: "Codex backlog tasks",
        value: "GPT-5.6 Sol - most capable",
        options: ["Default - the Harnesses default", ...CODEX_MODELS],
        blurb: "Used when Foreman launches an unpinned Codex task from the backlog.",
      },
      {
        id: "pi",
        label: "Pi backlog tasks",
        value: "GPT-5.5 - strong all-rounder",
        options: [
          "Default - the Harnesses default",
          "GPT-5.5 Pro - most capable, 1M context",
          "GPT-5.5 - strong all-rounder",
          "GPT-5 Codex - coding-tuned",
          "GPT-5 Mini - fastest, cheaper",
        ],
        blurb: "Used when Foreman launches an unpinned Pi task from the backlog.",
      },
    ],
  },

  // READ ONLY on this panel. Rendered as a count plus a link out; never as an editor.
  liveRepos: {
    count: 2,
    blurb:
      "When Foreman is Live it only sends on your behalf in these repos - their worktrees count too, wherever they live on disk.",
    summary: "Foreman may send live in 2 repositories. Grants live in one place now -",
    link: "Manage in Trust",
  },

  // ForemanStatus - scoped to sessions that exist right now, deliberately NOT the same
  // population as the ledger tallies below.
  health: [
    { label: "Worker", value: "running", ok: true },
    { label: "Sessions needing you", value: "0" },
    { label: "Last decision", value: "15m ago" },
    { label: "Backlog autopilot", value: "on - 7/8 agents, 0 ready" },
  ],

  // Folded out of the ledger rows, fleet-wide and historical.
  tallies: [
    { id: "escalated", count: 30, label: "escalated", tone: "attention" },
    { id: "pending", count: 1, label: "drafted", tone: "attention" },
    { id: "answered", count: 49, label: "answered", tone: "ok" },
    { id: "skipped", count: 20, label: "left alone", tone: "plain" },
  ],
};

/**
 * Ledger rows. `purpose` first and the verbatim ask under it, which is the real panel's
 * ordering. No Cheap-tier column anywhere in these mockups: that column is keyed on the
 * SHADOW posture only, and this snapshot is On.
 */
window.ROWS = [
  {
    session: "c1c0dfa1",
    purpose:
      "The session measured a large content-width swing and found the threshold too tight to catch it, and is asking whether to step the measurement or re-tune",
    ask: "1. Measure and step (Recommended) 2. Re-tune thresholds only 3. Leave it and record the swing",
    outcome: "escalated",
    who: "cheap",
    why: "human-only",
    when: "12m ago",
  },
  {
    session: "ttys006:76",
    purpose:
      "The session was interrupted during validation after hook errors and is asking whether to resume the background tasks it left behind",
    ask: "3 background shell command task(s) from the previous session are still registered",
    outcome: "stale",
    who: "foreman · cheap",
    why: "human-only",
    when: "16m ago",
  },
  {
    session: "8bca61aa",
    purpose:
      "The session found that the existing workflow allowlist controls the repair path and wants to confirm before widening it",
    ask: "AskUserQuestion",
    outcome: "answered",
    who: "you · cheap",
    why: "human-only",
    when: "21m ago",
  },
  {
    session: "6475a779",
    purpose:
      'This session posted a plan-decisions review "Ship log: legibility" and is waiting on the option choice',
    ask: 'The child posted a plan-decisions titled "Ship log: legibility" with 3 open questions',
    outcome: "declined",
    who: "foreman · structural",
    why: "a review",
    when: "11h ago",
  },
  {
    session: "27670057",
    purpose:
      "The session found no drift in tracked dotfiles and is asking which of the untracked ones to adopt",
    ask: "AskUserQuestion",
    outcome: "escalated",
    who: "cheap",
    why: "human-only",
    when: "12h ago",
  },
  {
    session: "b90d4cd5",
    purpose: "PR #409 auto-closed after its base branch was deleted when the stack below it merged",
    ask: "1. Let me restore the base branch (Recommended) 2. Open a fresh PR against main",
    outcome: "escalated",
    who: "cheap",
    why: "human-only",
    when: "13h ago",
  },
  {
    session: "83c55830",
    purpose:
      "The session has resolved and revalidated PR #398, with only the changelog conflict left to land",
    ask: "AskUserQuestion",
    outcome: "answered",
    who: "you · cheap",
    why: "human-only, risky",
    when: "14h ago",
  },
];
