import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { inspectFailureBoundaries } from './check-failure-boundaries.mjs';
import { findRawDatabaseProviderAccesses, findWorkflowCapabilityViolations } from './check-capability-boundaries.mjs';
import { findRuntimeResponsibilityViolations } from './check-runtime-responsibilities.mjs';

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
const testPaths = files(path.join(root, 'tests'));
const config = ts.readConfigFile(path.join(root, 'tsconfig.tests.json'), ts.sys.readFile);
const parsedConfig = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram([...paths, ...testPaths], {...parsedConfig.options, allowJs: true});
const checker = program.getTypeChecker();
const graph = new Map();
const errors = [];
const fail = (file,message) => errors.push(`${relative(file)}: ${message}`);
const ownership = JSON.parse(fs.readFileSync(path.join(root,'docs/development/scheduler-ownership.json'),'utf8'));
const documentedFields = Object.values(ownership).flatMap(group => group.fields);
const fieldOwners = new Map();
for (const [name, group] of Object.entries(ownership)) {
  for (const field of group.fields) {
    const previous = fieldOwners.get(field);
    if (previous) fail(path.join(root,'docs/development/scheduler-ownership.json'), `state ownership must have one owner: ${field} (${previous}, ${name})`);
    else fieldOwners.set(field, name);
  }
}
for (const [name, group] of Object.entries(ownership)) {
  if (Object.hasOwn(group, 'targetOwner')) fail(path.join(root, 'docs/development/scheduler-ownership.json'), `${name} retains a planned targetOwner; document the actual owner only`);
  if (typeof group.currentOwner !== 'string' || !group.currentOwner.trim()) fail(path.join(root, 'docs/development/scheduler-ownership.json'), `${name} must document one currentOwner`);
}
const resourceOwnershipPath = path.join(root, 'docs/development/resource-ownership.json');
const resourceOwnership = JSON.parse(fs.readFileSync(resourceOwnershipPath, 'utf8'));
if (!Array.isArray(resourceOwnership.resources)) fail(resourceOwnershipPath, 'resources must be an array');
const resourceIds = new Set();
const documentedResourceOwners = new Set();

function findOwnerSymbol(ownerTree, ownerSymbol) {
  for (const statement of ownerTree.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === ownerSymbol) return statement;
    if (ts.isClassDeclaration(statement) && statement.name?.text === ownerSymbol) return statement;
    if (ts.isVariableStatement(statement)) {
      const declaration = statement.declarationList.declarations.find(candidate => ts.isIdentifier(candidate.name) && candidate.name.text === ownerSymbol);
      if (declaration?.initializer && ts.isFunctionLike(declaration.initializer)) return declaration.initializer;
    }
  }
}

function collectOwnedResources(owner, ownerTree) {
  const declared = new Map();
  function recordVariable(statement) {
    const mutable = Boolean(statement.declarationList.flags & ts.NodeFlags.Let);
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const name = declaration.name.text;
      const typeText = declaration.type?.getText(ownerTree) || '';
      const initializer = declaration.initializer;
      const initializerText = initializer?.getText(ownerTree) || '';
      const callable = Boolean(initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)));
      const namedState = Boolean(initializer && !ts.isIdentifier(initializer)
        && /(?:state|health|circuit|lock|cache|timer|request|generation|active|pending|running|stopped|workflow|updated|initialized|controller|listener)/i.test(name));
      const stateful = !callable && (mutable || /(?:Promise|AbortController)/.test(typeText)
        || /^new\s+(?:Set|Map|WeakSet|WeakMap|AbortController)\b/.test(initializerText)
        || namedState);
      declared.set(name, {stateful});
    }
  }
  function collectClosureState(node, rootNode = node) {
    if (node !== rootNode && ts.isFunctionLike(node)) return;
    if (ts.isVariableStatement(node)) recordVariable(node);
    ts.forEachChild(node, child => collectClosureState(child, rootNode));
  }
  if (ts.isClassDeclaration(owner)) {
    for (const member of owner.members) {
      if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name)) declared.set(member.name.text, {stateful: true});
    }
  } else if (owner.body && ts.isBlock(owner.body)) {
    collectClosureState(owner.body);
  }
  return declared;
}

for (const entry of resourceOwnership.resources || []) {
  const ownerIdentity = `${entry.module}#${entry.ownerSymbol}`;
  if (documentedResourceOwners.has(ownerIdentity)) fail(resourceOwnershipPath, `duplicate resource owner: ${ownerIdentity}`);
  documentedResourceOwners.add(ownerIdentity);
  for (const key of ['module', 'ownerSymbol', 'stop', 'lateCallback', 'rebind']) {
    if (typeof entry[key] !== 'string' || !entry[key].trim()) fail(resourceOwnershipPath, `${ownerIdentity} must define ${key}`);
  }
  if (!Array.isArray(entry.resourceSymbols) || entry.resourceSymbols.length === 0
    || entry.resourceSymbols.some(symbol => typeof symbol !== 'string' || !symbol.trim())) {
    fail(resourceOwnershipPath, `${ownerIdentity} must define resourceSymbols`);
  }
  if (typeof entry.module === 'string' && !paths.some(file => relative(file) === entry.module)) {
    fail(resourceOwnershipPath, `resource module does not exist: ${entry.module}`);
  }
  const ownerFile = paths.find(file => relative(file) === entry.module);
  if (!ownerFile || typeof entry.ownerSymbol !== 'string') continue;
  const ownerTree = ts.createSourceFile(ownerFile, fs.readFileSync(ownerFile, 'utf8'), ts.ScriptTarget.Latest, true);
  const owner = findOwnerSymbol(ownerTree, entry.ownerSymbol);
  if (!owner) {
    fail(resourceOwnershipPath, `resource owner symbol is not present: ${ownerIdentity}`);
    continue;
  }
  const declared = collectOwnedResources(owner, ownerTree);
  const documented = new Set(entry.resourceSymbols || []);
  for (const symbol of documented) {
    const identity = `${ownerIdentity}:${symbol}`;
    if (resourceIds.has(identity)) fail(resourceOwnershipPath, `duplicate resource ownership: ${identity}`);
    resourceIds.add(identity);
    if (!declared.has(symbol)) fail(resourceOwnershipPath, `resource symbol is not owned by ${ownerIdentity}: ${symbol}`);
  }
  for (const [symbol, metadata] of declared) {
    if (metadata.stateful && !documented.has(symbol)) fail(resourceOwnershipPath, `unregistered resource symbol: ${ownerIdentity}:${symbol}`);
  }
}

const resourceCoverageRoots = ['scheduler/', 'web/client/features/', 'web/client/shared/'];
for (const ownerFile of paths.filter(file => resourceCoverageRoots.some(prefix => relative(file).startsWith(prefix)))) {
  const ownerTree = ts.createSourceFile(ownerFile, fs.readFileSync(ownerFile, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const statement of ownerTree.statements) {
    const exported = statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
    let owner;
    let ownerSymbol;
    if (exported && ts.isFunctionDeclaration(statement) && statement.name?.text.startsWith('create')) {
      owner = statement;
      ownerSymbol = statement.name.text;
    } else if (exported && ts.isClassDeclaration(statement) && statement.name?.text) {
      owner = statement;
      ownerSymbol = statement.name.text;
    } else if (exported && ts.isVariableStatement(statement)) {
      const declaration = statement.declarationList.declarations.find(candidate => ts.isIdentifier(candidate.name)
        && candidate.name.text.startsWith('create') && candidate.initializer && ts.isFunctionLike(candidate.initializer));
      if (declaration && ts.isIdentifier(declaration.name)) {
        owner = declaration.initializer;
        ownerSymbol = declaration.name.text;
      }
    }
    if (!owner || !ownerSymbol || ownerSymbol === 'SchedulerRuntime') continue;
    const resources = [...collectOwnedResources(owner, ownerTree)].filter(([, metadata]) => metadata.stateful).map(([name]) => name);
    if (!resources.length) continue;
    const ownerIdentity = `${relative(ownerFile)}#${ownerSymbol}`;
    if (!documentedResourceOwners.has(ownerIdentity)) {
      fail(resourceOwnershipPath, `stateful resource owner is not registered: ${ownerIdentity} (${resources.join(', ')})`);
    }
  }
}
const feature = file => relative(file).match(/^web\/client\/features\/([^/]+)\//)?.[1];
const client = file => /^(web\/(client|shared)\/|shared\/)/.test(relative(file));
const modular = file => client(file) || /^(scheduler|repositories|ports)\//.test(relative(file));
function containsAny(node) {
  return node.kind === ts.SyntaxKind.AnyKeyword || Boolean(ts.forEachChild(node, containsAny));
}

for (const file of paths) {
  const text = fs.readFileSync(file,'utf8');
  const tree = ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
  if (relative(file).startsWith('scheduler/') && relative(file) !== 'scheduler/scheduler-runtime.ts') {
    for (const finding of findRawDatabaseProviderAccesses(tree)) {
      errors.push(`${relative(file)}:${finding.line}: scheduler workflows must receive narrow storage capabilities instead of a raw database provider`);
    }
  }
  if (!relative(file).startsWith('web/client/') && !relative(file).startsWith('web/shared/')) {
    function findExplicitAny(node) {
      if (node.kind === ts.SyntaxKind.AnyKeyword) fail(file, 'production code must not introduce explicit any');
      ts.forEachChild(node, findExplicitAny);
    }
    findExplicitAny(tree);
  }
  if (relative(file) === 'scheduler.ts') {
    const scheduler = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SyncScheduler');
    if (!scheduler) fail(file,'scheduler facade missing from ownership audit');
    else {
      const fields = scheduler.members.filter(ts.isPropertyDeclaration).map(node => node.name.getText(tree));
      const runtimeFile = path.join(sourceRoot, 'scheduler', 'scheduler-runtime.ts');
      const runtimeTree = ts.createSourceFile(runtimeFile, fs.readFileSync(runtimeFile, 'utf8'), ts.ScriptTarget.Latest, true);
      const runtime = runtimeTree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SchedulerRuntime');
      if (!runtime) fail(runtimeFile, 'scheduler runtime missing from ownership audit');
      const runtimeFields = runtime ? runtime.members.filter(ts.isPropertyDeclaration).map(node => node.name.getText(runtimeTree)) : [];
      const actualFields = new Set([...fields, ...runtimeFields]);
      for (const name of actualFields) if (!documentedFields.includes(name)) fail(file, `state ownership must be documented exactly once: ${name}`);
      for (const name of new Set(documentedFields)) if (!actualFields.has(name)) fail(file, `stale state ownership entry: ${name}`);
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
    if (relative(file) !== 'index.ts' && relative(target) === 'scheduler.ts') fail(file,'business modules cannot depend on the scheduler facade');
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
    if (relative(file) === 'index.ts' && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(tree) === 'app'
      && ['get', 'post', 'put', 'patch', 'delete'].includes(node.expression.name.text)) {
      fail(file, 'the application composition root must register a router instead of declaring an inline HTTP handler');
    }
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
const schedulerTree = program.getSourceFile(path.join(sourceRoot, 'scheduler.ts'))
  ?? ts.createSourceFile('scheduler.ts', fs.readFileSync(path.join(sourceRoot, 'scheduler.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const schedulerClass = schedulerTree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SyncScheduler');
const runtimePath = path.join(sourceRoot, 'scheduler', 'scheduler-runtime.ts');
const runtimeTree = program.getSourceFile(runtimePath)
  ?? ts.createSourceFile(runtimePath, fs.readFileSync(runtimePath, 'utf8'), ts.ScriptTarget.Latest, true);
const runtimeClass = runtimeTree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SchedulerRuntime');
const runtimeAssemblyOnlyModules = [
  'access-probe-wakeup.ts',
  'cycle-logger.ts',
  'manual-archive.ts',
  'quality-projection.ts',
  'queue-projection.ts',
  'retry-pending-recovery.ts',
  'scheduler-status-projection.ts',
  'startup-probes.ts',
  'startup-recovery.ts',
  'legacy-quality-migration.ts',
].map(file => path.join(sourceRoot, 'scheduler', file));
for (const finding of findRuntimeResponsibilityViolations({
  runtimeClass,
  checker,
  forbiddenSourceFiles: runtimeAssemblyOnlyModules,
})) {
  errors.push(`${relative(runtimePath)}:${finding.line}: SchedulerRuntime may assemble ${finding.symbol} only in its constructor; public methods must delegate to the assembled workflow`);
}
// Capability ports must remain real restrictions even through aliases,
// re-exports, namespace imports or intersections.
for (const file of paths) {
  const sourceFile = program.getSourceFile(file);
  if (!sourceFile) continue;
  for (const finding of findWorkflowCapabilityViolations(sourceFile, checker)) {
    errors.push(`${relative(file)}:${finding.line}: workflow consumers must use declared capability ports, not ReturnType<typeof ${finding.symbol}>`);
  }
}
const jobStorePath = path.join(sourceRoot, 'job-store.ts');
const jobStoreSource = fs.readFileSync(jobStorePath, 'utf8');
if (/Number\([^\n]*(?:count|next_at)[^\n]*\|\|\s*0/.test(jobStoreSource)
  || /decodeSqlRows?\s*\(/.test(jobStoreSource)
  || /decodeSqlRow\([^\n]*count/.test(jobStoreSource)) {
  fail(jobStorePath, 'SQL aggregate projections must use a typed count decoder');
}
const downloadSessionPath = path.join(sourceRoot, 'download-session.ts');
const downloadSessionSource = fs.readFileSync(downloadSessionPath, 'utf8');
if (/output\s+as\s+T/.test(downloadSessionSource)
  || /observedAt\s*=\s*[^;]*\?\s*[^:]+:\s*nowIso\(\)/.test(downloadSessionSource)) {
  fail(downloadSessionPath, 'download evidence decoders must reject invalid fields instead of asserting or timestamping them');
}
const facadePrivateMembers = schedulerClass
  ? schedulerClass.members
    .filter(node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword))
    .map(node => node.name?.getText(schedulerTree))
  : [];
const runtimePrivateMembers = runtimeClass
  ? runtimeClass.members
    .filter(node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword))
    .map(node => node.name?.getText(runtimeTree))
  : [];
const privateMembers = [...facadePrivateMembers, ...runtimePrivateMembers];
for (const file of [...paths, ...testPaths]) {
  const fileName = normalize(path.relative(root, file));
  if (fileName.startsWith('tests/') && !fileName.endsWith('failure-boundaries.test.ts')) {
    const testTree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function findTestAny(node) {
      if (node.kind === ts.SyntaxKind.AnyKeyword) fail(file, 'executable tests must not use explicit any');
      ts.forEachChild(node, findTestAny);
    }
    findTestAny(testTree);
  }
  const found = inspectFailureBoundaries(fs.readFileSync(file, 'utf8'), {test: fileName.startsWith('tests/'), route: fileName.startsWith('src/http/'), critical: /(?:database|state|recovery)/.test(fileName), privateMembers, sourceFile: program.getSourceFile(file), checker});
  const used = new Map();
  for (const finding of found) {
    const key = `${finding.rule}:${finding.signature}`;
    const count = (used.get(key) || 0) + 1;
    used.set(key, count);
    errors.push(`${fileName}:${finding.line}: ${finding.rule} (failure-boundary violation)`);
  }
}
if (errors.length) { console.error([...new Set(errors)].join('\n')); process.exitCode = 1; }
else console.log(`Architecture checks passed (${paths.length} source files; browser source fully checked).`);
