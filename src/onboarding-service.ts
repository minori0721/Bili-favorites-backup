import fs from 'node:fs';

export function isNewInstallation(dataDirectory: string) {
  const files = new Set(fs.readdirSync(dataDirectory));
  return !['config.json','users.json','state.json','bfb.sqlite','bfb.sqlite-wal','bfb.sqlite-shm','auth-sessions.sqlite'].some(file => files.has(file));
}

/** The marker belongs to this installation; browser storage only remembers local dismissal. */
export function createOnboardingService(deps: {
  newInstallation: boolean;
  read(): string | null;
  write(value: 'pending' | 'complete'): void;
}) {
  return {
    initialize() { if (deps.read() === null) deps.write(deps.newInstallation ? 'pending' : 'complete'); },
    status() {
      const marker = deps.read();
      if (marker !== null && marker !== 'pending' && marker !== 'complete') throw new Error('使用引导标记损坏');
      return { autoStart: marker === 'pending' };
    },
    finish() { deps.write('complete'); },
  };
}
