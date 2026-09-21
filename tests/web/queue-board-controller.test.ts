import { queueResponse, parseQueueFixture } from './queue-fixture.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createQueueBoardController, queueBoardRefreshDelay, type QueueBoardRoot } from '../../src/web/client/features/task-center/board-controller.js';
import { parseQueueSnapshot, type QueueSnapshot } from '../../src/shared/api/queue-snapshot.js';

test('board lifecycle deduplicates starts and prevents stopped responses from rendering or scheduling', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const pending: Array<{ resolve(value: QueueSnapshot): void; signal: AbortSignal }> = [];
  const rendered: QueueSnapshot[] = [];
  let ticks = 0;
  let resets = 0;
  const ownerDocument = {
    hidden: false,
    createElement: (_tagName: string): HTMLElement => { throw new Error('not used in this scenario'); },
  };
  const root = {
    ownerDocument,
    querySelector<T extends Element = HTMLElement>(_selector: string): T | null { return null; },
    querySelectorAll<T extends Element = HTMLElement>(_selector: string): Iterable<T> & { forEach(callbackfn: (value: T) => void): void } {
      return { forEach: () => {}, *[Symbol.iterator]() {} };
    },
    setAttribute(_name: string, _value: string) {},
    prepend(_node: Node) {},
    innerHTML: '',
  } satisfies QueueBoardRoot;
  const board = createQueueBoardController({
    root, request: signal => new Promise(resolve => pending.push({ signal, resolve })),
    render: snapshot => rendered.push(snapshot), tick: () => { ticks++; },
    resetView: () => { resets++; }, loadingMarkup: () => '', formatDateTime: String,
  });
  board.start();
  board.start();
  await board.refresh();
  assert.equal(pending.length, 1);
  context.mock.timers.tick(1_000);
  assert.equal(ticks, 1);
  board.stop();
  assert.equal(pending[0].signal.aborted, true);
  board.start();
  const current = parseQueueFixture({ downloadPending: [{ id: 'new' }] });
  pending[0].resolve(parseQueueFixture({ downloadPending: [{ id: 'old' }] }));
  pending[1].resolve(current);
  await Promise.resolve();
  assert.deepEqual(rendered, [current]);
  context.mock.timers.tick(5_000);
  assert.equal(pending.length, 3);
  board.destroy();
  board.destroy();
  assert.equal(pending[2].signal.aborted, true);
  const ticksAtStop = ticks;
  context.mock.timers.tick(60_000);
  assert.equal(ticks, ticksAtStop);
  assert.equal(pending.length, 3);
  assert.equal(resets, 2);
  ownerDocument.hidden = true;
  board.start();
  assert.equal(pending.length, 3);
});

test('board polling intervals retain running, waiting, maintenance and idle behavior', () => {
  assert.equal(queueBoardRefreshDelay(parseQueueFixture({ downloadRunning: [{ phase: 'running' as const }] })), 2_000);
  assert.equal(queueBoardRefreshDelay(parseQueueFixture({ uploadPending: [{ phase: 'remote_verifying' as const }] })), 2_000);
  assert.equal(queueBoardRefreshDelay(parseQueueFixture({ uploadPending: [{ phase: 'retry_wait' as const }] })), 5_000);
  assert.equal(queueBoardRefreshDelay(parseQueueFixture({ maintenance: { active: true } })), 5_000);
  assert.equal(queueBoardRefreshDelay(parseQueueFixture({})), 15_000);
});
