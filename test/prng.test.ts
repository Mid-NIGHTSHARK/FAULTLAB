import { describe, expect, it } from 'vitest';
import { createPrng } from '../src/engine/prng';

describe('Mulberry32 samplers', () => {
  it('matches a known Mulberry32 sequence for seed 1', () => {
    const rng = createPrng(1);
    expect([rng.nextFloat(), rng.nextFloat(), rng.nextFloat()]).toEqual([
      0.6270739405881613, 0.002735721180215478, 0.5274470399599522,
    ]);
  });

  it('replays mixed samples with the same seed and diverges with a different seed', () => {
    function sample(seed: number) {
      const rng = createPrng(seed);
      return Array.from({ length: 25 }, () => [
        rng.nextFloat(), rng.nextInt(-8, 3), rng.nextExponential(5),
        rng.nextLogNormal(10, 0.5), rng.nextZipf(16, 1.2),
      ]);
    }

    expect(sample(0)).toEqual(sample(0));
    expect(sample(0)).not.toEqual(sample(1));
  });

  it('respects sampling bounds and includes both integer endpoints', () => {
    const rng = createPrng(42);
    const integers = new Set<number>();
    for (let i = 0; i < 1_000; i++) {
      const fraction = rng.nextFloat();
      const integer = rng.nextInt(-2, 2);
      const exponential = rng.nextExponential(5);
      const logNormal = rng.nextLogNormal(10, 0.5);
      const key = rng.nextZipf(8, 1);
      expect(fraction >= 0 && fraction < 1).toBe(true);
      expect(Number.isInteger(integer) && integer >= -2 && integer <= 2).toBe(true);
      expect(Number.isFinite(exponential) && exponential >= 0).toBe(true);
      expect(Number.isFinite(logNormal) && logNormal > 0).toBe(true);
      expect(Number.isInteger(key) && key >= 0 && key < 8).toBe(true);
      integers.add(integer);
    }
    expect(integers.size).toBe(5);
    expect(rng.nextInt(10, 10)).toBe(10);
    expect(rng.nextLogNormal(10, 0)).toBe(10);
    expect(rng.nextZipf(1, 4)).toBe(0);
  });

  it('increases the hot key share with skew', () => {
    function hotKeyShare(skew: number) {
      const rng = createPrng(33);
      let hits = 0;
      for (let i = 0; i < 16_000; i++) {
        if (rng.nextZipf(16, skew) === 0) hits++;
      }
      return hits / 16_000;
    }

    const uniform = hotKeyShare(0);
    const moderate = hotKeyShare(1);
    const concentrated = hotKeyShare(2);
    expect(uniform).toBeCloseTo(1 / 16, 2);
    expect(moderate).toBeGreaterThan(uniform);
    expect(concentrated).toBeGreaterThan(moderate);
    expect(concentrated).toBeGreaterThan(0.6);
  });

  it('rejects invalid sampler parameters', () => {
    const rng = createPrng(42);
    expect(() => rng.nextInt(2, 1)).toThrow(RangeError);
    expect(() => rng.nextExponential(0)).toThrow(RangeError);
    expect(() => rng.nextLogNormal(1, -1)).toThrow(RangeError);
    expect(() => rng.nextZipf(0, 0)).toThrow(RangeError);
    expect(() => rng.nextZipf(1, -1)).toThrow(RangeError);
  });
});
