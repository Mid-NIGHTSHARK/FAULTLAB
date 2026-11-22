import type { CircuitBreakerConfig, CircuitState } from './types';

export class CircuitBreaker {
  private current: CircuitState = 'closed';
  private epoch = 0;
  private openUntil = 0;
  private probes = 0;
  private successes = 0;
  private samples: { at: number; failed: boolean }[] = [];
  private head = 0;
  private failures = 0;

  state(now: number): CircuitState {
    if (this.current === 'open' && now >= this.openUntil) this.transition('half_open');
    return this.current;
  }

  admit(now: number, config: CircuitBreakerConfig): number | undefined {
    if (this.state(now) === 'open') return undefined;
    if (this.current === 'half_open' && this.successes >= config.halfOpenMaxRequests) {
      this.transition('closed');
    }
    if (this.current === 'half_open') {
      if (this.probes >= config.halfOpenMaxRequests) return undefined;
      this.probes++;
    }
    return this.epoch;
  }

  settle(epoch: number, now: number, failed: boolean, config: CircuitBreakerConfig): void {
    this.state(now);
    if (epoch !== this.epoch) return;
    if (this.current === 'half_open') {
      if (failed) this.open(now, config);
      else if (++this.successes >= config.halfOpenMaxRequests) this.transition('closed');
      return;
    }

    this.samples.push({ at: now, failed });
    if (failed) this.failures++;
    const cutoff = now - (config.windowMs ?? 1_000);
    while (this.samples[this.head]?.at <= cutoff) {
      if (this.samples[this.head++].failed) this.failures--;
    }
    const count = this.samples.length - this.head;
    if (this.head > 0 && this.head * 2 >= this.samples.length) {
      this.samples = this.samples.slice(this.head);
      this.head = 0;
    }
    if (count >= (config.minSamples ?? config.failureThreshold) &&
        this.failures > 0 && this.failures * 100 >= count * (config.errorThresholdPct ?? 50)) {
      this.open(now, config);
    }
  }

  private open(now: number, config: CircuitBreakerConfig): void {
    this.openUntil = now + (config.openDurationMs ?? config.resetTimeoutMs);
    this.transition('open');
  }

  private transition(state: CircuitState): void {
    this.current = state;
    this.epoch++;
    this.samples = [];
    this.head = this.failures = this.probes = this.successes = 0;
  }
}
