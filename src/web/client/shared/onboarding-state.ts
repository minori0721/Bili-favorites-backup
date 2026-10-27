/** Public, credential-free observations used by the getting-started checklist. */
export type OnboardingAccountsState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; total: number; usable: number; folders: number; needsLogin: number };

export type OnboardingStorageState = 'loading' | 'unavailable' | 'missing' | 'unchecked' | 'checking' | 'passed' | 'failed';
