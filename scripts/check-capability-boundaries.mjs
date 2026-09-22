import ts from 'typescript';

function resolvedSymbol(checker, node) {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
  return symbol;
}

function isSyncRuntimeFactory(symbol) {
  if (!symbol || symbol.getName() !== 'createSyncRuntime') return false;
  return (symbol.declarations || []).some(declaration => /[/\\]scheduler[/\\]sync-runtime\.[cm]?[jt]s$/i.test(
    declaration.getSourceFile().fileName,
  ));
}

function returnTypeFactoryExpression(node) {
  if (!ts.isTypeReferenceNode(node) || node.typeName.getText() !== 'ReturnType' || node.typeArguments?.length !== 1) return undefined;
  const query = node.typeArguments[0];
  return ts.isTypeQueryNode(query) ? query.exprName : undefined;
}

/** Rejects consumers that reconstruct a workflow's complete factory result type. */
export function findWorkflowCapabilityViolations(sourceFile, checker) {
  const findings = [];
  function visit(node) {
    const expression = returnTypeFactoryExpression(node);
    if (expression && isSyncRuntimeFactory(resolvedSymbol(checker, expression))) {
      findings.push({
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        symbol: 'createSyncRuntime',
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return findings;
}

function importMatchesFactoryModule(moduleName, reexports) {
  const resolved = reexports[moduleName] || moduleName;
  return /(?:^|\/)sync-runtime(?:\.[cm]?[jt]s)?$/.test(resolved.replaceAll('\\', '/'));
}

/** Small parser used by rule tests, including syntax that does not need a module resolver. */
export function inspectWorkflowCapabilityFixture(source, reexports = {}) {
  const tree = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const factories = new Set();
  const namespaces = new Set();
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || !importMatchesFactoryModule(statement.moduleSpecifier.text, reexports)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName?.text || element.name.text) === 'createSyncRuntime') factories.add(element.name.text);
      }
    }
  }
  const findings = [];
  function visit(node) {
    if (ts.isTypeReferenceNode(node) && node.typeName.getText(tree) === 'ReturnType' && node.typeArguments?.length === 1) {
      const compact = node.typeArguments[0].getText(tree).replace(/\s+/g, '');
      const direct = [...factories].some(name => compact === `typeof${name}`);
      const namespace = [...namespaces].some(name => compact === `typeof${name}.createSyncRuntime`
        || compact === `typeof${name}['createSyncRuntime']`
        || compact === `typeof${name}[\"createSyncRuntime\"]`);
      if (direct || namespace) {
        findings.push({
          line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
          symbol: 'createSyncRuntime',
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return findings;
}

function isRawDatabaseProviderCall(node) {
  if (!ts.isCallExpression(node)) return false;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text === 'getDatabase';
  return ts.isElementAccessExpression(node.expression)
    && ts.isStringLiteral(node.expression.argumentExpression)
    && node.expression.argumentExpression.text === 'getDatabase';
}

export function findRawDatabaseProviderAccesses(sourceFile) {
  const findings = [];
  function visit(node) {
    if (isRawDatabaseProviderCall(node)) {
      findings.push({line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1});
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return findings;
}

export function inspectRawDatabaseProviderFixture(source) {
  const tree = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return findRawDatabaseProviderAccesses(tree);
}
