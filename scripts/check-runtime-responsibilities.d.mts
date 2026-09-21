export interface RuntimeResponsibilityFinding {
  line: number;
  symbol: string;
}

export function inspectRuntimeResponsibilityFixture(
  source: string,
  forbiddenModules: readonly string[],
  reexports?: Readonly<Record<string, string>>,
): RuntimeResponsibilityFinding[];
