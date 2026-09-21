export interface DevEvidenceOptions {
  ref?: string;
  event?: string;
  sha?: string;
  workflowSha?: string;
  repository?: string;
  token?: string;
  apiUrl?: string;
  fetchImpl?: (input: URL, init?: RequestInit) => Promise<Response>;
  report?: (...values: unknown[]) => void;
}

export function findDevTestEvidence(options: DevEvidenceOptions): Promise<number | null>;
