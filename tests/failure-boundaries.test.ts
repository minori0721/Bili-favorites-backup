import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectFailureBoundaries } from '../scripts/check-failure-boundaries.mjs';

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
  assert.deepEqual(inspectFailureBoundaries('scheduler.start()', {test: true, privateMembers: ['jobStore']}), []);
});
test('critical recovery cannot turn a logged error into apparent success', () => {
  const bad = 'try { restore(); } catch(error) { log(error); return 0; }';
  const good = 'try { restore(); } catch(error) { log(error); throw error; }';
  assert.ok(inspectFailureBoundaries(bad, {critical: true}).some(item => item.rule === 'critical-swallow'));
  assert.deepEqual(inspectFailureBoundaries(good, {critical: true}), []);
  assert.deepEqual(inspectFailureBoundaries('try { restore(); } catch(error) { try { close(); } catch(cleanup) { log(cleanup); } throw error; }', {critical: true}), []);
});
