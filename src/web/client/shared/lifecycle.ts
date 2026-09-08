export interface LifecycleFeature { init(): void; destroy(): void }
export class LifecycleError extends Error {
  constructor(message: string, readonly causes: unknown[]) { super(message); this.name = 'LifecycleError'; }
}

/** Application assembly supplies features in dependency order; disposal reverses that order. */
export function createApplicationLifecycle(surface: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>, features: readonly LifecycleFeature[]) {
  let mounted = false;
  let active = false;
  function suspend() {
    if (!active) return;
    active = false;
    const errors: unknown[] = [];
    for (const feature of [...features].reverse()) {
      try { feature.destroy(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new LifecycleError('Application resource disposal failed', errors);
  }
  function resume() {
    if (active) return;
    const initialized: LifecycleFeature[] = [];
    try {
      for (const feature of features) { initialized.push(feature); feature.init(); }
      active = true;
    } catch (error) {
      const errors = [error];
      for (const feature of initialized.reverse()) {
        try { feature.destroy(); } catch (failure) { errors.push(failure); }
      }
      throw new LifecycleError('Application initialization failed', errors);
    }
  }
  return {
    mount() {
      if (mounted) return;
      resume();
      surface.addEventListener('pagehide', suspend);
      surface.addEventListener('pageshow', resume);
      mounted = true;
    },
    unmount() {
      if (!mounted) return;
      mounted = false;
      surface.removeEventListener('pagehide', suspend);
      surface.removeEventListener('pageshow', resume);
      suspend();
    },
  };
}
