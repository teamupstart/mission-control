/** Names a process as a fake-shaper helper; its pid file follows it in the argv. */
export declare const HELPER_MARKER: "shaping-fixture-helper";
/** How long a helper runs at most, whatever else happens. */
export declare const HELPER_LIFETIME_MS: number;
/**
 * The argv of a helper recorded in `pidFile`, which exits once `helperStopFile(pidFile)` appears,
 * once the directory holding `pidFile` is gone, or after `HELPER_LIFETIME_MS`.
 */
export declare function helperArgv(pidFile: string): string[];
/** The file whose appearance stops the helper recorded in `pidFile`. */
export declare function helperStopFile(pidFile: string): string;
