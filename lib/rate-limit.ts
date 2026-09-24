/** Sliding-window limiter in memory: one process, a restart resetting it is fine. */
export class SlidingWindow {
  private readonly hits = new Map<string, number[]>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Count a hit; returns whether it is allowed and when to retry otherwise. */
  hit(key: string, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs)
    if (list.length >= this.limit) {
      this.hits.set(key, list)
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((list[0]! + this.windowMs - now) / 1000)) }
    }
    list.push(now)
    this.hits.set(key, list)
    return { allowed: true, retryAfterSec: 0 }
  }
}
