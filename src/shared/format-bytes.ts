/**
 * A byte count for a reader, in BINARY units.
 *
 * KiB/MiB/GiB rather than KB/MB/GB, because the places these numbers are compared against
 * anything - the scout archive's limits, and Settings > Storage's limits and free-space floor -
 * are specified and enforced in binary units: 32 MiB for a report, 512 MiB for a whole bundle.
 * Printing a 536,870,912 byte bundle as "537 MB" beside a "512 MiB" limit reads as a bundle
 * comfortably under a cap it has in fact exactly hit.
 *
 * Shared, and browser-safe, so a size the daemon writes into a warning reads exactly as the
 * same size does on the page beside it.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  // One decimal below 10 so "1.2 MiB" keeps its precision, none above it so a rail of
  // sizes stays a column rather than a ragged edge.
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
