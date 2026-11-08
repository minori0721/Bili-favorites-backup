export interface SqliteCacheRuntime {
  platform: string; arch: string; abi: string; libc: string;
}
export function sqlitePrebuildPlan(
  lock: {packages?: Record<string, {version?: string}>}, runtime: SqliteCacheRuntime,
): {key: string; filename: string; version: string; asset: string};
export function prepareSqlitePrebuilt(
  plan: {version: string; asset: string}, archive: string,
  source?: {release(version: string): unknown; download(id: number, destination: string): void},
): {source: 'cache' | 'github-api' | 'npm'; reason?: string};
export function sqliteInstallReport(
  log: string, timers: Record<string, number>, succeeded: boolean, archiveExists: boolean,
): {method: 'cache' | 'download' | 'compiled' | 'unknown'; save: boolean; totalMs: number | null; sqliteMs: number | null};
