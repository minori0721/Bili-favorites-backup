/** A live connection observes only its own administrator session. */
export interface AdminSessionInvalidationPort {
  observe(sessionId: string, invalidated: () => void): () => void;
}
