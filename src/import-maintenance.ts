export class ImportMaintenance {
  private active = 0;
  private exclusive = false;
  private failed = false;
  private busy() { return Object.assign(new Error("状态导入维护中，请稍后重试"), { statusCode: 409 }); }
  enter() {
    if (this.exclusive) throw this.busy();
    this.active += 1;
    let released = false;
    return () => { if (!released) { released = true; this.active -= 1; } };
  }
  async run<T>(fn: () => Promise<T>) {
    const release = this.enter();
    try { return await fn(); } finally { release(); }
  }
  async acquire(timeoutMs = 30_000) {
    if (this.exclusive) throw this.busy();
    this.exclusive = true;
    const deadline = Date.now() + timeoutMs;
    while (this.active > 0) {
      if (Date.now() >= deadline) { this.exclusive = false; throw this.busy(); }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return () => { if (!this.failed) this.exclusive = false; };
  }
  failClosed() { this.failed = true; this.exclusive = true; }
  get blocked() { return this.exclusive; }
}
