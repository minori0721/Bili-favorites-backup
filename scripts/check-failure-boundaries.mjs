import ts from 'typescript';

/** AST rules deliberately inspect failure boundaries, not formatting or file length. */
export function inspectFailureBoundaries(text, {test = false, critical = false, route = false, privateMembers = [], sourceFile, checker} = {}) {
  const tree = sourceFile || ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true);
  const findings = [];
  const add = (rule, node) => findings.push({rule, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
    signature: node.getText(tree).replace(/\s+/g, ' ')});
  const emptyValue = node => node && ((ts.isIdentifier(node) && node.text === 'undefined')
    || node.kind === ts.SyntaxKind.NullKeyword || (ts.isArrayLiteralExpression(node) && node.elements.length === 0));
  // Optional fields are represented by undefined/null in a validated DTO. The
  // parser rule is specifically about silently turning an invalid collection
  // into an empty collection, which can erase a whole response. Keep that
  // distinction instead of flagging ordinary optional-field normalization.
  const parserEmptyValue = node => ts.isArrayLiteralExpression(node) && node.elements.length === 0;
  const outerFailurePropagates = node => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isCatchClause(parent) && containsDirectThrow(parent.block)) return true;
      if (ts.isFunctionLike(parent)) return false;
    }
    return false;
  };
  // A throw in a nested callback or nested catch does not propagate the
  // failure of the catch currently being inspected. Only inspect the current
  // statement tree up to those boundaries.
  const containsDirectThrow = node => {
    if (ts.isThrowStatement(node)) return true;
    if (ts.isBlock(node)) {
      for (const statement of node.statements) {
        if (containsDirectThrow(statement)) return true;
        if (ts.isReturnStatement(statement) || ts.isBreakStatement(statement) || ts.isContinueStatement(statement)) return false;
      }
    }
    if (ts.isIfStatement(node)) return Boolean(node.elseStatement
      && containsDirectThrow(node.thenStatement) && containsDirectThrow(node.elseStatement));
    if (ts.isTryStatement(node)) return Boolean(node.finallyBlock && containsDirectThrow(node.finallyBlock))
      || containsDirectThrow(node.tryBlock) && (!node.catchClause || containsDirectThrow(node.catchClause.block));
    return false;
  };
  const explicitFailureReturn = statement => {
    if (!ts.isReturnStatement(statement) || !statement.expression) return false;
    let expression = statement.expression;
    while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
      || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)) expression = expression.expression;
    if (expression.kind === ts.SyntaxKind.FalseKeyword || expression.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isStringLiteral(expression) && expression.text === 'unknown') return true;
    if (!ts.isObjectLiteralExpression(expression)) return false;
    return expression.properties.some(property => {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return false;
      const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : '';
      if (!['ok', 'assessment', 'error'].includes(name)) return false;
      if (ts.isShorthandPropertyAssignment(property)) return name !== 'ok';
      let value = property.initializer;
      while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value)
        || ts.isTypeAssertionExpression(value) || ts.isNonNullExpression(value)) value = value.expression;
      return name !== 'ok' || value.kind === ts.SyntaxKind.FalseKeyword;
    });
  };
  const explicitFailureOutcome = node => {
    if (ts.isBlock(node)) return node.statements.some(explicitFailureOutcome);
    if (explicitFailureReturn(node)) return true;
    if (ts.isIfStatement(node)) {
      if (node.expression.kind === ts.SyntaxKind.FalseKeyword) return Boolean(node.elseStatement && explicitFailureOutcome(node.elseStatement));
      if (node.expression.kind === ts.SyntaxKind.TrueKeyword) return explicitFailureOutcome(node.thenStatement);
      return explicitFailureOutcome(node.thenStatement)
        || Boolean(node.elseStatement && explicitFailureOutcome(node.elseStatement));
    }
    return false;
  };
  const guardedKnownAbsence = node => {
    let guarded = false;
    function inspect(current) {
      if (ts.isFunctionLike(current) && current !== node) return;
      if (ts.isIfStatement(current)) {
        const condition = current.expression.getText(tree);
        if (/\berrorCode\s*\(/.test(condition) && /["']ENOENT["']/.test(condition)) {
          const throwsForOtherErrors = /!==?\s*["']ENOENT["']/.test(condition)
            && containsDirectThrow(current.thenStatement);
          const absenceWithOtherErrorsThrown = /===?\s*["']ENOENT["']/.test(condition)
            && Boolean(current.elseStatement && containsDirectThrow(current.elseStatement));
          if (throwsForOtherErrors || absenceWithOtherErrorsThrown || explicitFailureOutcome(current.thenStatement)) guarded = true;
        }
      }
      ts.forEachChild(current, inspect);
    }
    inspect(node);
    return guarded;
  };
  const enclosingFunctionName = node => {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) return current.name?.getText(tree) || '';
      if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isVariableDeclaration(current.parent)) return current.parent.name.getText(tree);
    }
    return '';
  };
  const specificCriticalBoundary = node => {
    const file = String(tree.fileName || '').replace(/\\/g, '/');
    const symbol = enclosingFunctionName(node);
    return file.endsWith('/src/database-replacement.ts') && symbol === 'cleanup';
  };
  const unwrapExpression = node => {
    let current = node;
    while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
      || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current))) current = current.expression;
    return current;
  };
  const schedulerNames = new Set(['scheduler']);
  const emptyArrayFunctions = new Set();
  const functionAliases = new Map();
  // Collect declarations before inspecting calls: function hoisting and arrow
  // helpers must not change whether an invalid parser fallback is detected.
  function collect(node) {
    const name = ts.isFunctionDeclaration(node) ? node.name?.text
      : ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) ? node.name.text : undefined;
    const fn = ts.isFunctionDeclaration(node) ? node : ts.isVariableDeclaration(node) ? node.initializer : undefined;
    if (name && fn && (ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.body) {
      const body = fn.body;
      const expression = ts.isBlock(body) && body.statements.length === 1 && ts.isReturnStatement(body.statements[0])
        ? body.statements[0].expression : body;
      if (expression && ts.isArrayLiteralExpression(expression) && expression.elements.length === 0) emptyArrayFunctions.add(name);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const expression = unwrapExpression(node.initializer);
      if (ts.isIdentifier(expression)) functionAliases.set(node.name.text, expression.text);
    }
    ts.forEachChild(node, collect);
  }
  collect(tree);
  let aliasesChanged = true;
  while (aliasesChanged) {
    aliasesChanged = false;
    for (const [alias, target] of functionAliases) {
      if (emptyArrayFunctions.has(target) && !emptyArrayFunctions.has(alias)) {
        emptyArrayFunctions.add(alias);
        aliasesChanged = true;
      }
    }
  }
  const optionalDefault = node => {
    if (!ts.isBinaryExpression(node)) return false;
    const operator = node.operatorToken.kind;
    if (operator !== ts.SyntaxKind.EqualsEqualsToken && operator !== ts.SyntaxKind.EqualsEqualsEqualsToken) return false;
    return (ts.isIdentifier(node.right) && node.right.text === 'undefined') || node.right.kind === ts.SyntaxKind.NullKeyword;
  };
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text && node.body
      && node.body.statements.length === 1 && ts.isReturnStatement(node.body.statements[0])
      && ts.isArrayLiteralExpression(node.body.statements[0].expression)
      && node.body.statements[0].expression.elements.length === 0) emptyArrayFunctions.add(node.name.text);
    if (test && ts.isVariableDeclaration(node) && node.initializer) {
      const expression = unwrapExpression(node.initializer);
      if (ts.isIdentifier(expression) && schedulerNames.has(expression.text) && ts.isIdentifier(node.name)) schedulerNames.add(node.name.text);
      if (ts.isNewExpression(expression) && expression.expression.getText(tree) === 'SyncScheduler' && ts.isIdentifier(node.name)) schedulerNames.add(node.name.text);
    }
    if (route && (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
      const chain = [];
      let current = ts.isCallExpression(node) ? node.expression : node;
      while (current) {
        if (ts.isPropertyAccessExpression(current)) {
          chain.push(current.name.text);
          current = current.expression;
        } else if (ts.isElementAccessExpression(current)) {
          const argument = current.argumentExpression;
          chain.push(argument && (ts.isStringLiteral(argument) || ts.isNumericLiteral(argument)) ? argument.text : '<computed>');
          current = current.expression;
        } else break;
      }
      if (chain.includes('getDatabase') || chain.includes('prepare') || chain.includes('pragma')
        || (chain.includes('db') && (chain.includes('get') || chain.includes('all') || chain.includes('run') || chain.includes('iterate')))) {
        add('route-database-access', node);
      }
    }
    if (!test && ts.isCatchClause(node)) {
      const body = node.block;
      if (!body.statements.length) add('empty-catch', node);
      if (body.statements.length === 1 && ts.isReturnStatement(body.statements[0])
        && emptyValue(body.statements[0].expression) && !explicitFailureReturn(body.statements[0])) add('silent-recovery', node);
      if (critical && body.statements.length && !containsDirectThrow(body) && !outerFailurePropagates(node)
        && !explicitFailureOutcome(body) && !guardedKnownAbsence(body) && !specificCriticalBoundary(node)) add('critical-swallow', node);
    }
    if (!test && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'catch') {
      const handler = node.arguments[0];
      if (handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
        if (emptyValue(handler.body) || (ts.isBlock(handler.body)
          && (handler.body.statements.length === 0
            || (handler.body.statements.length === 1 && ts.isReturnStatement(handler.body.statements[0])
              && emptyValue(handler.body.statements[0].expression))))) add('silent-recovery', node);
      }
    }
    if (!test && node.kind === ts.SyntaxKind.AnyKeyword) {
      const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line;
      const context = text.split(/\r?\n/).slice(Math.max(0, line - 1), line + 1).join('\n');
      if (!/boundary-any:\s*\S/.test(context)) add('unexplained-any', node.parent);
    }
    if (test && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
      const name = ts.isPropertyAccessExpression(node) ? node.name.text
        : node.argumentExpression && ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : '';
      const expression = unwrapExpression(node.expression);
      const symbol = checker && (ts.isPropertyAccessExpression(node) ? checker.getSymbolAtLocation(node.name)
        : checker.getTypeAtLocation(node.expression).getProperty(name));
      const resolvedPrivate = symbol?.declarations?.some(declaration => declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword)
        && ts.isClassDeclaration(declaration.parent)
        && ['SyncScheduler', 'SchedulerRuntime'].includes(declaration.parent.name?.text || ''));
      if (resolvedPrivate || !checker && privateMembers.includes(name) && ts.isIdentifier(expression) && schedulerNames.has(expression.text)) add('scheduler-private', node);
    }
    const functionName = ts.isFunctionDeclaration(node) && node.name?.text ? node.name.text : undefined;
    const variableName = ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) ? node.name.text : undefined;
    const methodName = ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) ? node.name.text : undefined;
    const parserLike = Boolean((functionName || variableName || methodName)?.match(/^(parse|decode|read)(?:[A-Z_]|$)/));
    const parserFunction = ts.isVariableDeclaration(node) && node.initializer && ts.isFunctionLike(node.initializer)
      ? node.initializer : node;
    if (!test && parserLike && ts.isFunctionLike(parserFunction) && parserFunction.body) {
      function returns(child) {
        if (ts.isConditionalExpression(child)
          && (parserEmptyValue(child.whenTrue) || parserEmptyValue(child.whenFalse))
          && !optionalDefault(child.condition)) add('parser-empty-fallback', child);
        if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && emptyArrayFunctions.has(child.expression.text)) add('parser-empty-fallback', child);
        if (ts.isReturnStatement(child) && parserEmptyValue(child.expression)) {
          let optional = false;
          for (let parent = child.parent; parent && parent !== parserFunction.body; parent = parent.parent) {
            if (ts.isIfStatement(parent)) {
              const condition = parent.expression.getText(tree);
              optional = /ENOENT|undefined|null|missing|length\s*===?\s*0/.test(condition);
              if (optional) break;
            }
          }
          if (!optional) add('parser-empty-fallback', child);
        }
        ts.forEachChild(child, returns);
      }
      returns(parserFunction.body);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return findings;
}
