export interface PiManagedRuntimePrerequisites {
  piCliInstalled: boolean;
  piExtensionInstalled: boolean;
}

/** The single readiness policy for selecting or dispatching Pi's managed runtime. */
export function piManagedRuntimeReady(facts: PiManagedRuntimePrerequisites): boolean {
  return facts.piCliInstalled && facts.piExtensionInstalled;
}
