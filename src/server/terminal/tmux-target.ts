import { z } from "zod";

/** A tmux id is stable only within the server which allocated it. */
const AddressSchema = z.object({
  socket: z.string().startsWith("/"),
  pid: z.string().regex(/^[1-9]\d*$/),
  started: z.string().regex(/^[1-9]\d*$/),
  id: z.string().regex(/^\$\d+$/),
});

export type TmuxAddress = z.infer<typeof AddressSchema>;
const PREFIX = "tmux:";

export const TMUX_ADDRESS_FORMAT = ["#{socket_path}", "#{pid}", "#{start_time}", "#{session_id}"];

/** Opaque backend address; the human label stays in sessionName. */
export function tmuxAddress(fields: readonly string[]): string | null {
  if (fields.length !== 4) return null;
  const [socket, pid, started, id] = fields;
  const parsed = AddressSchema.safeParse({ socket, pid, started, id });
  return parsed.success ? PREFIX + JSON.stringify(parsed.data) : null;
}

export function readTmuxAddress(value: string): TmuxAddress | null {
  if (!value.startsWith(PREFIX)) return null;
  try {
    const parsed = AddressSchema.safeParse(JSON.parse(value.slice(PREFIX.length)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Raw names are exact names, including a name that happens to start with '$'. */
export function tmuxSessionTarget(value: string): string {
  return readTmuxAddress(value)?.id ?? `=${value}`;
}

/** Every operation on a captured handle must reach the server which supplied it. */
export function tmuxScopedArgs(session: string, args: string[]): string[] {
  const address = readTmuxAddress(session);
  return address ? ["-S", address.socket, ...args] : args;
}

export function tmuxIdentityCondition(address: TmuxAddress): string {
  return `#{&&:#{==:#{pid},${address.pid}},#{&&:#{==:#{start_time},${address.started}},#{==:#{session_id},${address.id}}}}`;
}
