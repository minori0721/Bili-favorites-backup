/** External adapter failure used by transport contract tests. */
export class HttpFailure extends Error {
  status?: number;
  headers?: Record<string, string>;
}
