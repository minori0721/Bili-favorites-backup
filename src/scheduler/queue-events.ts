export interface EventSource<Arguments extends unknown[]> {
  on(event: string, handler: (...args: Arguments) => void): unknown;
  off(event: string, handler: (...args: Arguments) => void): unknown;
}

/** The registry owns subscriptions; each handler keeps its explicit business arguments. */
export function createQueueEventBindings() {
  const subscriptions: Array<() => void> = [];
  let disposed = false;
  return {
    on<Arguments extends unknown[]>(source: EventSource<Arguments>, event: string, handler: (...args: Arguments) => void) {
      if (disposed) throw new Error('Cannot register queue events after disposal');
      source.on(event, handler);
      subscriptions.push(() => { source.off(event, handler); });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of subscriptions.splice(0).reverse()) unsubscribe();
    },
  };
}
