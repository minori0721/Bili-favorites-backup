export interface SqliteCacheRuntime {
  platform: string; arch: string; abi: string; libc: string;
}
export function sqlitePrebuildPlan(
  lock: {packages?: Record<string, {version?: string}>}, runtime: SqliteCacheRuntime,
): {key: string; filename: string};
export function sqliteInstallReport(
  log: string, timers: Record<string, number>, succeeded: boolean, archiveExists: boolean,
): {method: 'cache' | 'download' | 'compiled' | 'unknown'; save: boolean; totalMs: number | null; sqliteMs: number | null};
