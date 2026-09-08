import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationLifecycle, LifecycleError } from '../../src/web/client/shared/lifecycle.js';

test('page restore initializes once and releases features in reverse dependency order', () => {
  const surface = new EventTarget();
  const calls: string[] = [];
  const lifecycle = createApplicationLifecycle(surface, ['base','feature'].map(name => ({
    init: () => { calls.push('start ' + name); }, destroy: () => { calls.push('stop ' + name); },
  })));
  lifecycle.mount(); lifecycle.mount(); surface.dispatchEvent(new Event('pageshow'));
  surface.dispatchEvent(new Event('pagehide')); surface.dispatchEvent(new Event('pagehide'));
  surface.dispatchEvent(new Event('pageshow'));
  lifecycle.unmount(); lifecycle.unmount();
  surface.dispatchEvent(new Event('pageshow'));
  assert.deepEqual(calls, ['start base','start feature','stop feature','stop base','start base','start feature','stop feature','stop base']);
});

test('partial initialization failure cleans up both the failing and previously initialized feature', () => {
  const calls: string[] = [];
  const lifecycle = createApplicationLifecycle(new EventTarget(), [
    {init() {},destroy() {calls.push('base');}},
    {init() {throw new Error('failed');},destroy() {calls.push('partial');}},
  ]);
  assert.throws(() => lifecycle.mount(), LifecycleError);
  assert.deepEqual(calls,['partial','base']);
});
