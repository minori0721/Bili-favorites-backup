import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectRawDatabaseProviderFixture, inspectWorkflowCapabilityFixture } from '../scripts/check-capability-boundaries.mjs';
import { inspectFailureBoundaries } from '../scripts/check-failure-boundaries.mjs';
import { inspectRuntimeResponsibilityFixture } from '../scripts/check-runtime-responsibilities.mjs';

test('HTTP routes consume services instead of database connections', () => {
  for (const source of ['state.getDatabase()', 'store.db.prepare("SELECT 1")', 'store["db"]["prepare"]("SELECT 1")']) {
    assert.ok(inspectFailureBoundaries(source, {route: true}).some(item => item.rule === 'route-database-access'));
  }
  assert.deepEqual(inspectFailureBoundaries('service.items(query)', {route: true}), []);
});

for (const [rule, bad, good] of [
  ['empty-catch', 'try { work(); } catch {}', 'try { work(); } catch (error) { throw error; }'],
  ['silent-recovery', 'recover().catch(() => undefined)', 'recover().catch(error => { report(error); throw error; })'],
  ['unexplained-any', 'let response: any;', 'let response: unknown;'],
  ['parser-empty-fallback', 'function parse(v) { return valid(v) ? v : []; }', 'function parse(v) { if (!valid(v)) throw Error("invalid"); return v; }'],
] as const) {
  test(`failure rule ${rule} rejects bad code and accepts an explicit boundary`, () => {
    assert.ok(inspectFailureBoundaries(bad).some(item => item.rule === rule));
    assert.deepEqual(inspectFailureBoundaries(good), []);
  });
}
test('tests must use public scheduler contracts', () => {
  assert.equal(inspectFailureBoundaries('(scheduler as any).jobStore', {test: true, privateMembers: ['jobStore']})[0].rule, 'scheduler-private');
  assert.equal(inspectFailureBoundaries('const runtime = scheduler; runtime["jobStore"]', {test: true, privateMembers: ['jobStore']})[0].rule, 'scheduler-private');
  assert.deepEqual(inspectFailureBoundaries('scheduler.start()', {test: true, privateMembers: ['jobStore']}), []);
});
test('parser helper fallbacks and nested failure handlers are not hidden', () => {
  for (const source of [
    'function parse(v) { return ok(v) ? v : empty(); } function empty() { return []; }',
    'const empty = () => []; function parse(v) { return ok(v) ? v : empty(); }',
  ]) assert.ok(inspectFailureBoundaries(source).some(item => item.rule === 'parser-empty-fallback'));
  assert.ok(inspectFailureBoundaries('try { restore(); } catch(e) { if (false) throw e; }', {critical: true}).some(item => item.rule === 'critical-swallow'));
  assert.ok(inspectFailureBoundaries('const service = new SyncScheduler(); service.jobStore;', {test: true, privateMembers: ['jobStore']}).some(item => item.rule === 'scheduler-private'));
  assert.ok(inspectFailureBoundaries('function emptyList() { return []; } function parse(v) { return ok(v) ? v : emptyList(); }').some(item => item.rule === 'parser-empty-fallback'));
  const nested = 'try { restore(); } catch(error) { try { cleanup(); } catch(inner) { throw inner; } return 0; }';
  assert.ok(inspectFailureBoundaries(nested, {critical: true}).some(item => item.rule === 'critical-swallow'));
});
test('critical recovery cannot turn a logged error into apparent success', () => {
  const bad = 'try { restore(); } catch(error) { log(error); return 0; }';
  const good = 'try { restore(); } catch(error) { log(error); throw error; }';
  assert.ok(inspectFailureBoundaries(bad, {critical: true}).some(item => item.rule === 'critical-swallow'));
  assert.deepEqual(inspectFailureBoundaries(good, {critical: true}), []);
  assert.deepEqual(inspectFailureBoundaries('try { restore(); } catch(error) { try { close(); } catch(cleanup) { log(cleanup); } throw error; }', {critical: true}), []);
});

test('known architecture bypasses are rejected', () => {
  assert.ok(inspectFailureBoundaries('try { work(); } catch { /* ignored */ }').some(item => item.rule === 'empty-catch'));
  assert.ok(inspectFailureBoundaries('try { work(); } catch { /* boundary-cleanup: ignored */ }').some(item => item.rule === 'empty-catch'));
  assert.ok(inspectFailureBoundaries('try { restore(); } catch (error) { const assessment = 1; return 0; }', {critical: true}).some(item => item.rule === 'critical-swallow'));
  assert.ok(inspectFailureBoundaries('try { restore(); } catch (error) { /* boundary-critical: ignored */ return 0; }', {critical: true}).some(item => item.rule === 'critical-swallow'));
  assert.ok(inspectFailureBoundaries('const parseItems = value => Array.isArray(value) ? value : [];').some(item => item.rule === 'parser-empty-fallback'));
  assert.ok(inspectFailureBoundaries('const empty = () => []; const alias = empty; const parseItems = value => Array.isArray(value) ? value : alias();').some(item => item.rule === 'parser-empty-fallback'));
  assert.ok(inspectFailureBoundaries('store["db"]["prepare"]("SELECT 1")', {route: true}).some(item => item.rule === 'route-database-access'));
});

test('critical boundaries do not trust notifications, comments, or unreachable branches', () => {
  for (const source of [
    'try { restore(); } catch(error) { showToast(error); return true; }',
    'try { restore(); } catch(error) { if (false) return false; return true; }',
    'try { restore(); } catch(error) { if (errorCode(error) === "ENOENT") { /* throw */ } return true; }',
  ]) {
    assert.ok(inspectFailureBoundaries(source, {critical: true}).some(item => item.rule === 'critical-swallow'));
  }
});

test('promise catch handlers and parser helpers cannot hide invalid responses', () => {
  assert.ok(inspectFailureBoundaries('restore().catch(() => {})').some(item => item.rule === 'silent-recovery'));
  assert.ok(inspectFailureBoundaries('restore().catch(function () { return undefined; })').some(item => item.rule === 'silent-recovery'));
  assert.ok(inspectFailureBoundaries('function parseItems(v) { if (!Array.isArray(v)) return []; return v; }').some(item => item.rule === 'parser-empty-fallback'));
  assert.deepEqual(inspectFailureBoundaries('function parseItems(v) { if (v == null) return []; return v; }'), []);
});

test('runtime responsibility rule follows renamed and indexed imports', () => {
  const forbidden = ['./business.js'];
  for (const source of [
    `import { createWork as renamed } from './business.js'; class SchedulerRuntime { run() { return renamed({}); } }`,
    `import * as business from './business.js'; class SchedulerRuntime { run() { return business.createWork({}); } }`,
    `import * as business from './business.js'; class SchedulerRuntime { run() { return business['createWork']({}); } }`,
  ]) assert.equal(inspectRuntimeResponsibilityFixture(source, forbidden).length, 1);
  assert.equal(inspectRuntimeResponsibilityFixture(
    `import { createWork } from './bridge.js'; class SchedulerRuntime { run() { return createWork({}); } }`,
    forbidden,
    {'./bridge.js': './business.js'},
  ).length, 1);
  assert.deepEqual(inspectRuntimeResponsibilityFixture(
    `import { createWork } from './business.js'; class SchedulerRuntime { private work; constructor() { this.work = createWork({}); } run() { return this.work.run(); } }`,
    forbidden,
  ), []);
  assert.deepEqual(inspectRuntimeResponsibilityFixture(
    `import type { createWork } from './business.js'; type Work = ReturnType<typeof createWork>; class SchedulerRuntime { run(value: Work) { return value; } }`,
    forbidden,
  ), []);
});

test('workflow capability rule rejects aliases, namespaces, re-exports and intersections', () => {
  for (const source of [
    `import { createSyncRuntime as makeSync } from './scheduler/sync-runtime.js'; type All = ReturnType<typeof makeSync>;`,
    `import * as sync from './scheduler/sync-runtime.js'; type All = ReturnType<typeof sync.createSyncRuntime>;`,
    `import * as sync from './scheduler/sync-runtime.js'; type All = ReturnType<typeof sync['createSyncRuntime']>;`,
    `import { createSyncRuntime } from './scheduler/sync-runtime.js'; type Port = SyncWorkflowPort & ReturnType<typeof createSyncRuntime>;`,
  ]) assert.equal(inspectWorkflowCapabilityFixture(source).length, 1);
  assert.equal(inspectWorkflowCapabilityFixture(
    `import { createSyncRuntime as makeSync } from './bridge.js'; type All = ReturnType<typeof makeSync>;`,
    {'./bridge.js': './scheduler/sync-runtime.js'},
  ).length, 1);
  assert.deepEqual(inspectWorkflowCapabilityFixture(
    `import type { SyncWorkflowPort } from './ports/scheduler-workflows.js'; type Commands = Pick<SyncWorkflowPort, 'runSync'>;`,
  ), []);
});

test('scheduler storage boundary fixture distinguishes a narrow callback from a raw provider', () => {
  assert.equal(inspectRawDatabaseProviderFixture(`state.getDatabase().query()`).length, 1);
  assert.equal(inspectRawDatabaseProviderFixture(`state['getDatabase']().query()`).length, 1);
  assert.deepEqual(inspectRawDatabaseProviderFixture(`isArchiveSourceDeletionBlocked(userId, mediaId, bvid)`), []);
});


test('parser optional defaults may restrict absence with a conjunction but not broaden it', () => {
  assert.equal(inspectFailureBoundaries('function decode(v) { return v.list === null && v.count === 0 ? [] : v.list; }').filter(item => item.rule === 'parser-empty-fallback').length, 0);
  assert.ok(inspectFailureBoundaries('function decode(v) { return v.list === null || v.count === 0 ? [] : v.list; }').some(item => item.rule === 'parser-empty-fallback'));
});
