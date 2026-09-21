import ts from 'typescript';

function resolvedSymbol(checker, expression) {
  let symbol = checker.getSymbolAtLocation(expression);
  if (!symbol && (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))) {
    symbol = checker.getSymbolAtLocation(expression.name || expression.argumentExpression);
  }
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
  return symbol;
}

function isTopLevelCallableDeclaration(declaration) {
  if (ts.isFunctionDeclaration(declaration)) return ts.isSourceFile(declaration.parent);
  if (!ts.isVariableDeclaration(declaration)) return false;
  const statement = declaration.parent?.parent;
  return Boolean(statement && ts.isVariableStatement(statement) && ts.isSourceFile(statement.parent));
}

export function findRuntimeResponsibilityViolations({ runtimeClass, checker, forbiddenSourceFiles }) {
  const forbidden = new Set([...forbiddenSourceFiles].map(value => value.replaceAll('\\', '/').toLowerCase()));
  const violations = [];
  for (const member of runtimeClass?.members || []) {
    if (ts.isConstructorDeclaration(member)) continue;
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const symbol = resolvedSymbol(checker, node.expression);
        const declaration = symbol?.declarations?.find(isTopLevelCallableDeclaration);
        const fileName = declaration?.getSourceFile().fileName.replaceAll('\\', '/').toLowerCase();
        if (fileName && forbidden.has(fileName)) {
          violations.push({
            line: runtimeClass.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1,
            symbol: symbol.getName(),
          });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(member);
  }
  return violations;
}

export function inspectRuntimeResponsibilityFixture(source, forbiddenModules, reexports = {}) {
  const tree = ts.createSourceFile('runtime.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const direct = new Map();
  const namespaces = new Set();
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const importedModule = statement.moduleSpecifier.text;
    if (!forbiddenModules.includes(importedModule) && !forbiddenModules.includes(reexports[importedModule])) continue;
    const clause = statement.importClause;
    if (!clause?.namedBindings) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) namespaces.add(clause.namedBindings.name.text);
    if (ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) direct.set(element.name.text, element.propertyName?.text || element.name.text);
    }
  }
  const runtimeClass = tree.statements.find(statement => ts.isClassDeclaration(statement) && statement.name?.text === 'SchedulerRuntime');
  const findings = [];
  for (const member of runtimeClass?.members || []) {
    if (ts.isConstructorDeclaration(member)) continue;
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        let symbol;
        if (ts.isIdentifier(expression)) symbol = direct.get(expression.text);
        if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && namespaces.has(expression.expression.text)) {
          symbol = expression.name.text;
        }
        if (ts.isElementAccessExpression(expression) && ts.isIdentifier(expression.expression) && namespaces.has(expression.expression.text)
          && ts.isStringLiteral(expression.argumentExpression)) symbol = expression.argumentExpression.text;
        if (symbol) findings.push({line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1, symbol});
      }
      ts.forEachChild(node, visit);
    }
    visit(member);
  }
  return findings;
}
