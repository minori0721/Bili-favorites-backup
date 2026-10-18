export interface DevBuild {
  ref: string;
  repository: string;
  revision: string;
}

export interface DevPreviewBuild extends DevBuild {
  image: string;
  digest: string;
  runId: string;
  runAttempt: string;
  updatedAt: string;
}

export type GitHubCommand = (args: string[]) => string;

export function isCurrentDevBuild(build: DevBuild, gh?: GitHubCommand): boolean;
export function publishDevPreview(
  build: DevPreviewBuild,
  changelog: string,
  version: string,
  notesFile: string,
  operations?: { gh: GitHubCommand; inspect: (reference: string) => string },
): string;
