export const MIN_NODE_MAJOR: number;

export function nodeMajor(version: string): number | null;
export function nodePrerequisiteMessage(version: string): string | null;
export function chromiumPrerequisiteMessage(): string;
