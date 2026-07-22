/**
 * Start the daemon only when Electron owns the application stack.
 *
 * A Vite URL means the shell is part of `dev:desktop`, where `dev:server`
 * owns the daemon and restarts it independently. Treating a transiently
 * unhealthy dev daemon as absent would start Electron's supervised production
 * daemon, which then loses the port race and restarts forever.
 */
export async function startElectronOwnedDaemon<T>(
  devServerUrl: string | undefined,
  start: () => Promise<T>,
): Promise<T | null> {
  if (devServerUrl) return null;
  return start();
}
