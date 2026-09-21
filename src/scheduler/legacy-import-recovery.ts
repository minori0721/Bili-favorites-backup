import { LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER, LEGACY_TEMP_CACHE_MARKER } from '../database.js';
import type { StateDatabase } from '../database.js';

export interface LegacyRecoveryMarkers { quality: string | null | undefined; temp: string | null | undefined; }
interface Dependencies {
  database(): Pick<StateDatabase, 'getMeta' | 'setMeta' | 'deleteMeta'>;
  recoverState(): Promise<void>;
  recoverTemp(): void;
  wake(): void;
}

/** The maintenance caller has already rebound all adapters before recovery resumes. */
export function createLegacyImportRecovery(deps: Dependencies) {
  let tempRecoveryPending = false;
  return {
    capture(): LegacyRecoveryMarkers {
      const database = deps.database();
      return {quality: database.getMeta(LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER), temp: database.getMeta(LEGACY_TEMP_CACHE_MARKER)};
    },
    async resume(restored: string[], previous: LegacyRecoveryMarkers) {
      const database = deps.database();
      const state = restored.includes('state');
      const temp = restored.includes('temp');
      if (state) {
        database.deleteMeta(LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER);
        if (!temp) {
          if (previous.temp === 'complete') database.setMeta(LEGACY_TEMP_CACHE_MARKER, 'complete');
          else database.deleteMeta(LEGACY_TEMP_CACHE_MARKER);
        }
      }
      if (temp) database.deleteMeta(LEGACY_TEMP_CACHE_MARKER);
      tempRecoveryPending = database.getMeta(LEGACY_TEMP_CACHE_MARKER) !== 'complete';
      if (state) await deps.recoverState();
    },
    afterAdmissionResumed() {
      if (tempRecoveryPending) {
        tempRecoveryPending = false;
        deps.recoverTemp();
      }
      deps.wake();
    },
  };
}
