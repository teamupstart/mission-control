/** Only a positive backend refusal establishes that no terminal command was delivered. */
export class TerminalLaunchError extends Error {
  constructor(message: string, readonly outcomeUnknown: boolean) { super(message); }
}
