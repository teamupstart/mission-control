export const MIN_NODE_MAJOR: number;

export function nodeMajor(version: string): number | null;
export function nodePrerequisiteMessage(version: string): string | null;
export function chromiumPrerequisiteMessage(): string;

export const REQUIRED_ARCH: string;
export function archPrerequisiteMessage(arch: string): string | null;
export function gitPrerequisiteMessage(installed: boolean): string | null;
export function ghPrerequisiteMessage(state: {
  installed: boolean;
  authenticated: boolean;
}): string | null;
export function xcodeToolsPrerequisiteMessage(state: {
  platform: string;
  installed: boolean;
}): string | null;
