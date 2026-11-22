const UINT32_RANGE = 0x100000000;

export function createPrng(seed: number) {
  let state = seed >>> 0;
  let zipfTable: { n: number; skew: number; quantile: (fraction: number) => number } | undefined;

  function nextUint32(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return (mixed ^ (mixed >>> 14)) >>> 0;
  }

  function nextFloat(): number {
    return nextUint32() / UINT32_RANGE;
  }

  /** Uniform integer in the inclusive range [min, max]. */
  function nextInt(min: number, max: number): number {
    const width = max - min + 1;
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || width < 1 || width > UINT32_RANGE) {
      throw new RangeError('Expected an inclusive integer range containing at most 2^32 values');
    }
    const limit = UINT32_RANGE - (UINT32_RANGE % width);
    let sample = nextUint32();
    while (sample >= limit) sample = nextUint32();
    return min + (sample % width);
  }

  function nextExponential(mean: number): number {
    if (!Number.isFinite(mean) || mean <= 0) throw new RangeError('Mean must be finite and positive');
    return -Math.log1p(-nextFloat()) * mean;
  }

  function nextLogNormal(median: number, sigma: number): number {
    if (!Number.isFinite(median) || median <= 0 || !Number.isFinite(sigma) || sigma < 0) {
      throw new RangeError('Expected a positive finite median and a nonnegative finite sigma');
    }
    if (sigma === 0) return median;
    const radius = Math.sqrt(-2 * Math.log1p(-nextFloat()));
    const normal = radius * Math.cos(2 * Math.PI * nextFloat());
    return median * Math.exp(sigma * normal);
  }

  function nextZipf(n: number, skew: number): number {
    if (!Number.isInteger(n) || n < 1 || n > UINT32_RANGE || !Number.isFinite(skew) || skew < 0) {
      throw new RangeError('Expected a positive key count and nonnegative finite skew');
    }
    if (skew === 0) return nextInt(0, n - 1);

    if (zipfTable?.n !== n || zipfTable.skew !== skew) {
      zipfTable = { n, skew, quantile: createZipfQuantile(n, skew) };
    }
    return zipfTable.quantile(nextFloat());
  }

  return { nextFloat, nextInt, nextExponential, nextLogNormal, nextZipf };
}


/** Build a reusable lookup from a uniform key fraction in [0, 1) to a Zipf rank. */
export function createZipfQuantile(n: number, skew: number): (fraction: number) => number {
  if (skew === 0) return (fraction) => Math.floor(fraction * n);
  const cumulative = new Float64Array(n);
  let total = 0;
  for (let index = 0; index < n; index++) {
    total += (index + 1) ** -skew;
    cumulative[index] = total;
  }
  return (fraction) => {
    const sample = fraction * total;
    let low = 0;
    let high = n - 1;
    while (low < high) {
      const mid = low + Math.floor((high - low) / 2);
      if (sample < cumulative[mid]) high = mid;
      else low = mid + 1;
    }
    return low;
  };
}
