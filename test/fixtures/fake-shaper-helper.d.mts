/** Names a process as a fake-shaper helper; its pid file follows it in the argv. */
export declare const HELPER_MARKER: "shaping-fixture-helper";
/** The argv of a helper recorded in `pidFile`, which exits once `helperStopFile(pidFile)` appears. */
export declare function helperArgv(pidFile: string): string[];
/** The file whose appearance stops the helper recorded in `pidFile`. */
export declare function helperStopFile(pidFile: string): string;
