import type ts from "typescript";

export interface BoundaryFinding {
  rule: string;
  line: number;
  signature: string;
}

export interface FailureBoundaryOptions {
  test?: boolean;
  critical?: boolean;
  route?: boolean;
  privateMembers?: string[];
  sourceFile?: ts.SourceFile;
  checker?: ts.TypeChecker;
}

export function inspectFailureBoundaries(text: string, options?: FailureBoundaryOptions): BoundaryFinding[];
