import {
  formatConversationTimestamp,
  formatConversationTimestampLong,
} from "../lib/format.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * One transcript instant, compact on the page and complete to assistive technology.
 * Zero is the wire contract's explicit "unknown" value, so an undated turn gets no
 * placeholder that could be mistaken for a real observation.
 */
export function ConversationTimestamp({
  at,
  className,
}: {
  at: number;
  className?: string;
}): React.JSX.Element | null {
  if (!Number.isFinite(at) || at <= 0) return null;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  const long = formatConversationTimestampLong(at);
  return (
    <Tooltip label={long}>
      <time
        className={className ? `conversation-time ${className}` : "conversation-time"}
        dateTime={date.toISOString()}
      >
        {formatConversationTimestamp(at)}
      </time>
    </Tooltip>
  );
}
