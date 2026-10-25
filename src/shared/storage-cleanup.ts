/** The browser and execution boundary use the same admission policy. */
export function cleanupItemRequiresIdle(key: string) {
  return !['memory-cache','logs','debug-logs','exports','backups'].includes(key);
}
