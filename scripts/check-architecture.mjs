import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceRoot = path.join(root,'src');
const normalize = value => value.replaceAll('\\','/');
const relative = value => normalize(path.relative(sourceRoot,value));
function files(directory) {
  return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry => {
    const file = path.join(directory,entry.name);
    return entry.isDirectory() ? files(file) : /\.[jt]s$/.test(entry.name) ? [file] : [];
  });
}
const paths = files(sourceRoot);
const graph = new Map();
const errors = [];
const ownership = JSON.parse(fs.readFileSync(path.join(root,'docs/development/scheduler-ownership.json'),'utf8'));
const documentedFields = Object.values(ownership).flatMap(group => group.fields);
const feature = file => relative(file).match(/^web\/client\/features\/([^/]+)\//)?.[1];
const client = file => /^(web\/(client|shared)\/|shared\/)/.test(relative(file));
const modular = file => client(file) || relative(file).startsWith('scheduler/');
const fail = (file,message) => errors.push(`${relative(file)}: ${message}`);
function containsAny(node) {
  return node.kind === ts.SyntaxKind.AnyKeyword || Boolean(ts.forEachChild(node, containsAny));
}

for (const file of paths) {
  const text = fs.readFileSync(file,'utf8');
  const tree = ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
  if (relative(file) === 'scheduler.ts') {
    const scheduler = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SyncScheduler');
    if (!scheduler) fail(file,'scheduler facade missing from ownership audit');
    else {
      const fields = scheduler.members.filter(ts.isPropertyDeclaration).map(node => node.name.getText(tree));
      for (const name of fields) if (documentedFields.filter(field => field === name).length !== 1) fail(file,`state ownership must be documented exactly once: ${name}`);
      for (const name of documentedFields) if (!fields.includes(name)) fail(file,`stale state ownership entry: ${name}`);
    }
  }
  const dependencies = [];
  graph.set(file,dependencies);
  if (relative(file).startsWith('web/client/') && file.endsWith('.js')) fail(file,'browser source must use checked TypeScript');
  if (client(file) && file.endsWith('.ts') && /@ts-(nocheck|ignore)/.test(text)) fail(file,'browser modules cannot suppress TypeScript checks');
  function importTarget(specifier, runtime = true) {
    if (!specifier.startsWith('.')) {
      // Only the installed player's type declarations are consumed; vendor delivery stays unchanged.
      if (specifier === 'artplayer' && !runtime) return;
      if (client(file)) fail(file,`external client dependency must be reviewed: ${specifier}`);
      return;
    }
    const raw = path.resolve(path.dirname(file),specifier);
    const target = paths.find(candidate => candidate === raw || candidate === raw.replace(/\.js$/,'.ts'));
    if (!target) {
      if (client(file) && !specifier.endsWith('.css')) fail(file,`unresolved browser import: ${specifier}`);
      return;
    }
    if (runtime) dependencies.push(target);
    if (client(file) && !client(target)) fail(file,`client imports server code: ${relative(target)}`);
    if (feature(file) && feature(target) && feature(file) !== feature(target) && !relative(target).endsWith('/index.ts')) fail(file,`cross-feature access must use its public entry: ${relative(target)}`);
    if (relative(file).startsWith('scheduler/') && relative(target) === 'scheduler.ts') fail(file,'business modules cannot depend on the scheduler facade');
  }
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly : node.isTypeOnly;
      importTarget(node.moduleSpecifier.text,!typeOnly);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0];
      if (specifier && ts.isStringLiteral(specifier)) importTarget(specifier.text);
      else if (client(file)) fail(file,'dynamic client imports require an explicit static boundary');
    }
    if (modular(file) && file.endsWith('.ts') && (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && containsAny(node.type)) fail(file,'module boundaries must narrow unknown values instead of assertions containing any');
    if (client(file) && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
      && ['window','globalThis'].includes(node.left.expression.getText(tree))) fail(file,'business state cannot be exported through browser globals');
    ts.forEachChild(node,visit);
  }
  visit(tree);
}

// New modules must not participate in runtime cycles, including cycles through older code.
const complete = new Set(), active = [];
function check(file) {
  const index = active.indexOf(file);
  if (index >= 0) {
    const cycle = active.slice(index);
    if (cycle.some(modular)) errors.push('runtime cycle: ' + [...cycle,file].map(relative).join(' -> '));
    return;
  }
  if (complete.has(file)) return;
  active.push(file);
  for (const target of graph.get(file) || []) check(target);
  active.pop();
  complete.add(file);
}
for (const file of paths) check(file);
if (errors.length) { console.error([...new Set(errors)].join('\n')); process.exitCode = 1; }
else console.log(`Architecture checks passed (${paths.length} source files; browser source fully checked).`);
