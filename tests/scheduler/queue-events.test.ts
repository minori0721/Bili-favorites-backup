import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createQueueEventBindings } from '../../src/scheduler/queue-events.js';

test('queue event disposal removes only owned handlers and is idempotent', () => {
  const source = new EventEmitter();
  const bindings = createQueueEventBindings();
  const values: string[] = [];
  const external = () => values.push('external');
  source.on('completed', external);
  bindings.on(source, 'completed', (value: string) => { values.push(value); });
  source.emit('completed', 'first');
  bindings.dispose();
  bindings.dispose();
  source.emit('completed', 'late');
  assert.deepEqual(values, ['external','first','external']);
  assert.equal(source.listenerCount('completed'),1);
  assert.throws(() => bindings.on(source,'completed',external), /after disposal/);
});
