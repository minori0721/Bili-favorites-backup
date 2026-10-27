export interface TestEvidenceOptions {
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

export function findTestEvidence(options: TestEvidenceOptions): Promise<number | null>;
