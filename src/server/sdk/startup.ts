/**
 * Keep the first terminal discovery sweep behind the complete SDK restore pass.
 *
 * Kept as a small coordinator instead of an inline promise chain so the startup gate can be
 * proven directly: restore failure is best-effort and still opens discovery, while shutdown
 * settles the restore owner without starting a new recurring subsystem on the way out.
 */
export async function startDiscoveryAfterSdkRestore(
  restore: Promise<void>,
  startDiscovery: () => () => void,
  shuttingDown: () => boolean,
  onRestoreError: (error: unknown) => void,
): Promise<(() => void) | null> {
  try {
    await restore;
  } catch (error) {
    onRestoreError(error);
  }
  if (shuttingDown()) return null;
  return startDiscovery();
}
