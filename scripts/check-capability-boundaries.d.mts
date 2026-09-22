import type ts from 'typescript';

export interface CapabilityBoundaryFinding {
  line: number;
  symbol?: string;
}

export function findWorkflowCapabilityViolations(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): CapabilityBoundaryFinding[];

export function inspectWorkflowCapabilityFixture(
  source: string,
  reexports?: Readonly<Record<string, string>>,
): CapabilityBoundaryFinding[];

export function findRawDatabaseProviderAccesses(sourceFile: ts.SourceFile): CapabilityBoundaryFinding[];
export function inspectRawDatabaseProviderFixture(source: string): CapabilityBoundaryFinding[];
