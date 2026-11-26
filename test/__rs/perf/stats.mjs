/** Statistics shared by bench.mjs (one process) and run.mjs (pooling the processes of a cell). */

/** Order statistics, mean, standard deviation and coefficient of variation of `values` (ms). */
export function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const at = (q) => (n ? sorted[Math.min(n - 1, Math.floor(q * n))] : NaN)
  const mean = n ? sorted.reduce((sum, value) => sum + value, 0) / n : NaN
  const stddev =
    n > 1 ? Math.sqrt(sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)) : 0
  return {
    cv: n ? stddev / mean : NaN,
    maxMs: sorted.at(-1) ?? NaN,
    meanMs: mean,
    medianMs: at(0.5),
    minMs: sorted[0] ?? NaN,
    n,
    p25Ms: at(0.25),
    p75Ms: at(0.75),
    p90Ms: at(0.9),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
    stddevMs: stddev,
  }
}

/** Median of the finite values (mean of the middle two for an even count); NaN when none. */
export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  const middle = sorted.length / 2
  return sorted.length === 0
    ? NaN
    : sorted.length % 2
      ? sorted[Math.floor(middle)]
      : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Two-sided 95% Student t quantiles by degrees of freedom (1-10; 1.96 beyond). */
const T95 = [NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228]

/**
 * Geometric mean and 95% confidence interval of positive ratios (e.g. one speedup per round): a t
 * interval on their logarithms. `low` / `high` are NaN for fewer than two ratios.
 */
export function ratioInterval(ratios) {
  const logs = ratios.filter((value) => Number.isFinite(value) && value > 0).map(Math.log)
  const n = logs.length
  const mean = n ? logs.reduce((sum, value) => sum + value, 0) / n : NaN
  if (n < 2) {
    return { geomean: Math.exp(mean), high: NaN, low: NaN, n }
  }
  const sd = Math.sqrt(logs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1))
  const half = (T95[n - 1] ?? 1.96) * (sd / Math.sqrt(n))
  return { geomean: Math.exp(mean), high: Math.exp(mean + half), low: Math.exp(mean - half), n }
}
