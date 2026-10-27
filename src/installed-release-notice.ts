import type { AppInfo } from './app-info.js';

export const INSTALLED_RELEASE_MARKER = 'installed_release_seen_v1';

/** UI acknowledgement follows the current database connection and never owns backup state. */
export function createInstalledReleaseNotice(deps: {
  current: Pick<AppInfo, 'version' | 'revision' | 'buildRef'>;
  newInstallation: boolean;
  firstRun(): boolean;
  read(): string | null;
  write(build: string): void;
}) {
  const build = deps.current.version + ':' + (deps.current.revision || deps.current.buildRef);
  return {
    initialize() { if (deps.newInstallation || deps.firstRun()) deps.write(build); },
    pending() { return deps.newInstallation || deps.firstRun() || deps.read() === build ? null : build; },
    acknowledge(expected = build) {
      if (expected !== build) return false;
      deps.write(build); return true;
    },
  };
}
