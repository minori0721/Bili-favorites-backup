export type PostCommitReconciliationResult =
  | { ok: true }
  | { ok: false; error: unknown };

/** A committed operation cannot be rolled back by optional convergence work. */
export async function runPostCommitReconciliation(
  work: () => Promise<unknown>,
): Promise<PostCommitReconciliationResult> {
  try {
    await work();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}
