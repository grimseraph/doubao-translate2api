import { ServiceError } from "./errors.js";

interface Waiter { grant: () => void; fail: (error: unknown) => void }
export class Semaphore {
  private active = 0;
  private queue: Waiter[] = [];
  constructor(private limit: number, private maxQueue: number, private timeout: number) {}
  get status() { return { active: this.active, queued: this.queue.length, limit: this.limit, maxQueue: this.maxQueue }; }
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active < this.limit) { this.active++; return this.releaseOnce(); }
    if (this.queue.length >= this.maxQueue) throw new ServiceError("queue_full", 429, "Upstream queue is full.");
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
      const remove = () => { const i = this.queue.indexOf(waiter); if (i >= 0) this.queue.splice(i, 1); };
      const waiter: Waiter = {
        grant: () => { cleanup(); this.active++; resolve(this.releaseOnce()); },
        fail: error => { cleanup(); remove(); reject(error); },
      };
      const abort = () => waiter.fail(signal.reason);
      const timer = setTimeout(() => waiter.fail(new ServiceError("queue_timeout", 503, "Upstream queue wait timed out.")), this.timeout);
      this.queue.push(waiter);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  private releaseOnce() {
    let released = false;
    return () => {
      if (released) return;
      released = true; this.active--;
      this.queue.shift()?.grant();
    };
  }
}
