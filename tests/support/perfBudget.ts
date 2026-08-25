import { expect } from 'vitest'

/**
 * Wall-clock budget assertions, recorded rather than enforced on shared CI.
 *
 * The scale suites (`composeScale`, `listTracksScale`, `relatedScale`,
 * `statsScale`) measure real `performance.now()` timings against fixed
 * millisecond budgets. Those budgets were already sized "generous for CI share"
 * and CI still flaked them for weeks: a GitHub-hosted runner sharing a core with
 * whatever else the fleet scheduled that minute has no upper bound a fixed
 * multiplier can absorb, so the assertion measured a real number and rejected a
 * real machine for a reason that was never about Oscine's code.
 *
 * So on CI the workload still runs and the measured timing is still printed —
 * the regression signal is preserved, a human reading the log sees the number —
 * but the budget is not asserted. Locally and on the M-exit-gate machines, where
 * the timing is a controlled measurement rather than a noisy one, the budget is
 * enforced exactly as before. A genuine quadratic still fails the developer's
 * own run and the gate; it just no longer paints main red from a busy runner.
 *
 * GitHub Actions sets `CI=true` for every step; that is the whole switch.
 */
export const RECORD_BUDGETS_ONLY = process.env.CI !== undefined && process.env.CI !== ''

/**
 * Assert `measured < budget`, or — under CI — record the measurement and pass.
 *
 * `label` names what was measured so the CI line is legible on its own; it is
 * also the assertion message locally, so a real regression says which workload
 * blew its budget rather than just printing two numbers.
 */
export function expectWithinBudget(measured: number, budget: number, label: string): void {
  if (RECORD_BUDGETS_ONLY) {
    console.info(
      `[perf] ${label}: ${measured.toFixed(1)} ms (budget ${budget} ms, record-only on CI)`
    )
    return
  }
  expect(measured, `${label} exceeded its ${budget} ms budget`).toBeLessThan(budget)
}
