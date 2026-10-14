'use strict';

class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
    this.timer = setInterval(() => this.sweep(), Math.max(windowMs, 60000));
    this.timer.unref();
  }
  sweep() {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, list] of this.hits) {
      const kept = list.filter((t) => t > cutoff);
      if (kept.length) this.hits.set(key, kept); else this.hits.delete(key);
    }
  }
  // Returns true if the request is allowed.
  take(key) {
    const now = Date.now();
    const list = (this.hits.get(key) || []).filter((t) => t > now - this.windowMs);
    if (list.length >= this.limit) { this.hits.set(key, list); return false; }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
  stop() { clearInterval(this.timer); }
}

module.exports = { RateLimiter };
