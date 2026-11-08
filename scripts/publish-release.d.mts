export interface ReleaseSummary {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
}

export function shouldMakeLatest(tag: string, releases: readonly ReleaseSummary[]): boolean;
export function publishRelease(
  tag: string,
  notesFile: string,
  gh?: (args: string[]) => string,
  repository?: string,
): "Existing release preserved" | "Release created";

export interface StableBuild {
  ref: string; repository: string; revision: string; tag: string;
}
export function checkStablePublication(build: StableBuild, gh?: (args: string[]) => string): boolean;
export function publishStableRelease(
  build: StableBuild & { image: string; digest: string }, notesFile: string,
  operations?: { gh(args: string[]): string; inspect(reference: string): string | null },
): string;
