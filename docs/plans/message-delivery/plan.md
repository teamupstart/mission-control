# Conversation delivery choices and deadlines

The operator approved the message-delivery scout and requested implementation in this session.

> **Superseded.** The composer no longer offers a delivery selector. Every message now
> follows one policy - wait for the turn, steer at one minute, interrupt at two - and the
> explicit **Steer now** and **Interrupt and deliver** actions remain on each queued row.
> See [sessions](../../sessions.md) for the behavior as it ships.

## Behavior

Keep the existing After this turn behavior. Embedded harnesses with steering support also offer Steer now and Steer after 1 minute. A separate, explicitly selected Interrupt after 2 minutes policy and Interrupt and deliver action stop active work while preserving the outbox. Messages with possible prior delivery are never automatically replayed. Show queue age and the blocking reason after 30 seconds.

Deadlines belong to individual durable messages and survive daemon restart. The composer remembers its choice for this browser session; every submitted row snapshots that choice. A message intentionally marked After this turn never acquires an automatic deadline. Automatic interruption is an alternative policy for still-unsent messages, not a retry of messages already accepted by the runtime. Neither driver provides a reliable model-read acknowledgement through the current adapter.

## Technical approach

Extend the existing pending-turn row with a delivery mode and deadline. Reuse its revision checks, single in-flight claim, uncertain recovery, session ownership checks and supervisor. Add an explicit mode-aware claim that may pass earlier next-turn messages only for operator-requested steering, while preserving FIFO among eligible messages and never passing an unresolved delivery. Keep terminal steering unavailable until native pickup can be verified; terminal interruption can use the existing Escape transport and must await a confirmed idle observation before delivery.

Flow: composer -> durable outbox -> idle delivery, deadline steering, or preserved-queue interruption -> existing driver or terminal injector. Interrupt completion must precede the subsequent send. Permission/review dialogs, reset, ending sessions and ownership changes continue to block delivery.

## Work and acceptance

1. Add shared delivery vocabulary, capability checks and durable row migration. Existing rows retain next-turn behavior; malformed stored modes fail closed. Tests cover deadlines, revisions, eligible FIFO, recovery and older database upgrade.
2. Add deadline scheduling and explicit steer/interrupt delivery to the pending-turn manager. Test busy steering, idle races, dialogs, failed or unconfirmed interruption, reset, ownership changes, restart and no duplicate sends after ambiguous acceptance.
3. Expose validated send-mode and queued-message action contracts. Exercise both send routes and stale or unsupported requests through in-process HTTP tests.
4. Add shared composer choices and queued-message controls on both conversation surfaces. Add Playwright coverage using only fake agents, including a message received while the original turn remains active and preserved messages after interruption. Cover elapsed waiting and automatic policy behavior.
5. Update session documentation and README; run focused tests, typecheck, lint, build, smoke and browser verification. Review the diff for state races and unnecessary duplication.

Dependencies: 1 -> 2 -> 3 -> 4 -> 5. No runtime or release configuration changes. Scout reports and evidence artifacts remain uncommitted.
