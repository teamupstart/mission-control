// The timeout changes the explanation, not the daemon's opportunity to become ready.
export const WINDOW_STARTUP_TIMEOUT_MS = 60_000;
export type StartupScreen = "starting" | "slow" | "error";

interface WindowStartupPort {
  now(): number;
  show(screen: StartupScreen, signal: AbortSignal): Promise<void>;
  ready(signal: AbortSignal): Promise<boolean>;
  load(signal: AbortSignal): Promise<void>;
  pause(signal: AbortSignal): Promise<void>;
  loaded(): void;
  log(error: unknown): void;
}

/** One initial navigation owner per window, including Retry and teardown. */
export class WindowStartup {
  private attempt: AbortController | null = null;
  private finished = false;
  private stopped = false;

  constructor(private readonly port: WindowStartupPort) {}

  async start(): Promise<void> {
    if (this.finished || this.stopped) return;
    this.attempt?.abort();
    const attempt = new AbortController();
    this.attempt = attempt;
    try {
      await this.run(attempt.signal);
    } catch (error) {
      if (!attempt.signal.aborted) this.port.log(error);
    }
  }

  stop(): void {
    this.stopped = true;
    this.attempt?.abort();
  }

  private async show(screen: StartupScreen, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.port.show(screen, signal);
        return;
      } catch (error) {
        if (signal.aborted) return;
        this.port.log(error);
        await this.port.pause(signal);
      }
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    const began = this.port.now();
    let explained = false;
    await this.show("starting", signal);
    while (!signal.aborted) {
      const ready = await this.port.ready(signal);
      if (signal.aborted) return;
      if (ready) {
        try {
          await this.port.load(signal);
        } catch (error) {
          if (signal.aborted) return;
          this.port.log(error);
          await this.show("error", signal);
          explained = true;
          if (!signal.aborted) await this.port.pause(signal);
          continue;
        }
        if (signal.aborted) return;
        this.finished = true;
        this.port.loaded();
        return;
      }
      if (!explained && this.port.now() - began >= WINDOW_STARTUP_TIMEOUT_MS) {
        await this.show("slow", signal);
        explained = true;
      }
      if (!signal.aborted) await this.port.pause(signal);
    }
  }
}
