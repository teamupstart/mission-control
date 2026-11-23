/** Read the preview gate at the start of each model operation. */
export async function backgroundEffortEnabled(
  readSelection: () => Promise<{ backgroundReasoningEffort: boolean }>,
): Promise<boolean> {
  try {
    return (await readSelection()).backgroundReasoningEffort === true;
  } catch {
    return false;
  }
}
