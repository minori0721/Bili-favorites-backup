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
): "Existing release preserved" | "Release created";
