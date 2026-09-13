import ts from 'typescript';

/** AST rules deliberately inspect failure boundaries, not formatting or file length. */
export function inspectFailureBoundaries(text, {test = false, critical = false, privateMembers = []} = {}) {
  const tree = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true);
  const findings = [];
  const add = (rule, node) => findings.push({rule, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
    signature: node.getText(tree).replace(/\s+/g, ' ')});
  const emptyValue = node => node && ((ts.isIdentifier(node) && node.text === 'undefined')
    || node.kind === ts.SyntaxKind.NullKeyword || (ts.isArrayLiteralExpression(node) && node.elements.length === 0));
  const outerFailurePropagates = node => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isCatchClause(parent) && parent.block.statements.some(ts.isThrowStatement)) return true;
      if (ts.isFunctionLike(parent)) return false;
    }
    return false;
  };
  function visit(node) {
    if (!test && ts.isCatchClause(node)) {
      const body = node.block;
      if (!body.statements.length && !/\/\*|\/\//.test(body.getText(tree))) add('empty-catch', node);
      if (body.statements.length === 1 && ts.isReturnStatement(body.statements[0]) && emptyValue(body.statements[0].expression)) add('silent-recovery', node);
      if (critical && body.statements.length && !body.statements.some(ts.isThrowStatement) && !outerFailurePropagates(node)) add('critical-swallow', node);
    }
    if (!test && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'catch') {
      const handler = node.arguments[0];
      if (handler && ts.isArrowFunction(handler) && emptyValue(handler.body)) add('silent-recovery', node);
    }
    if (!test && node.kind === ts.SyntaxKind.AnyKeyword) {
      const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line;
      const context = text.split(/\r?\n/).slice(Math.max(0, line - 1), line + 1).join('\n');
      if (!/boundary-any:\s*\S/.test(context)) add('unexplained-any', node.parent);
    }
    if (test && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
      const name = ts.isPropertyAccessExpression(node) ? node.name.text
        : node.argumentExpression && ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : '';
      if (privateMembers.includes(name) && /scheduler/i.test(node.expression.getText(tree))) add('scheduler-private', node);
    }
    if (!test && ts.isFunctionDeclaration(node) && node.name?.text.startsWith('parse')) {
      function returns(child) {
        if (ts.isConditionalExpression(child)
          && (emptyValue(child.whenTrue) || emptyValue(child.whenFalse))) add('parser-empty-fallback', child);
        ts.forEachChild(child, returns);
      }
      if (node.body) returns(node.body);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return findings;
}
