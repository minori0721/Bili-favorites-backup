export const minimumNodeVersion: string;
export function imageRebuildPlan(env?: Record<string, string | undefined>): { rebuildOnly: boolean; tags: string[] };
export function verifyNodeRuntime(version: string | undefined): string;
export function isCurrentImageRebuild(env: Record<string, string | undefined>, gh?: (args: string[]) => string): boolean;
