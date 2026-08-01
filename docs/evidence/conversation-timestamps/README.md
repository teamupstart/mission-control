# Conversation timestamp visual evidence

This capture renders the production `TranscriptPanel`, `ConversationTimestamp`, and
`src/web/styles.css` in Electron. The seeded conversation uses fixed local times so the
image demonstrates Option 1's full per-row format and its placement beside each speaker:
`You · Jul 31, 9:42 AM` and `Claude · Jul 31, 9:43 AM`.

![Conversation rows with timestamps beside each speaker](conversation-timestamps.png)

To regenerate the capture from the repository root:

```sh
node_modules/.bin/electron scripts/conversation-timestamp-evidence.cjs
```

The capture script waits until both expected timestamped speaker rows exist in the live
DOM before taking the screenshot. Its browser harness is
`scripts/conversation-timestamp-evidence.tsx`.
