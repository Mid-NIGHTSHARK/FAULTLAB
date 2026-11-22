import type { RequestTrace } from './types';

export class TraceRecorder {
  private readonly buffer: (RequestTrace | undefined)[];
  private nextIndex = 0;
  private count = 0;

  constructor(readonly capacity = 200) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity >= 2 ** 32) {
      throw new RangeError('Trace capacity must be a positive array length');
    }
    this.buffer = new Array(capacity);
  }

  /** Record a completed trace. Treat it and its spans as immutable after recording. */
  record(trace: RequestTrace): void {
    this.buffer[this.nextIndex] = trace;
    this.nextIndex = (this.nextIndex + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }

  recent(limit = this.capacity): RequestTrace[] {
    return this.query(() => true, limit);
  }

  /** Return failed requests, including timeouts and drops. */
  errors(limit = this.capacity): RequestTrace[] {
    return this.query((trace) => trace.status !== 'ok', limit);
  }

  slow(minDurationMs: number, limit = this.capacity): RequestTrace[] {
    return this.query((trace) => trace.durationMs >= minDurationMs, limit);
  }

  private query(matches: (trace: RequestTrace) => boolean, limit: number): RequestTrace[] {
    const results: RequestTrace[] = [];
    const maxResults = Math.min(this.count, Math.floor(limit));
    let index = this.nextIndex;
    for (let visited = 0; visited < this.count && results.length < maxResults; visited++) {
      index = (index + this.capacity - 1) % this.capacity;
      const trace = this.buffer[index]!;
      if (matches(trace)) results.push(trace);
    }
    return results;
  }
}
