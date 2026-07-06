// M2.3 §3.1 — angle-sweep serve "protractor" pointer. The pointer angle is a
// PURE function of elapsed time since the serve phase started (no wire field
// carries the angle itself, only the phase-start server time). Client renders
// its own local pointer from synced clock; server substitutes the
// lag-compensated release instant into this SAME function to get the
// authoritative angle. Both ends MUST call this one function so they always
// agree bit-for-bit (spec §6.4 determinism philosophy).

export const SERVE_SWEEP_PERIOD_MS = 1600; // full back-and-forth: 800ms left->right + 800ms right->left

// Triangle wave over [-90, +90] degrees:
//   elapsedMs = 0            -> -90 (start, "left")
//   elapsedMs = P/2          -> +90 (midpoint, "right")
//   elapsedMs = P            -> -90 (back to start, periodic)
// phase = (elapsedMs mod P) / P, wrapped into [0, 1) so negative and
// arbitrarily large elapsed times behave identically to their equivalent
// point in-cycle (true modulo, not JS `%` which can return negative values).
export function sweepAngleDeg(elapsedMs: number): number {
  const phase = wrappedPhase(elapsedMs, SERVE_SWEEP_PERIOD_MS);
  return phase < 0.5 ? -90 + 360 * phase : 90 - 360 * (phase - 0.5);
}

// True modulo into [0, 1): (elapsedMs mod period) / period. NaN/Infinity in
// -> NaN out (elapsedMs is expected to be a finite millisecond count; callers
// are responsible for not feeding it non-finite values).
function wrappedPhase(elapsedMs: number, periodMs: number): number {
  const m = ((elapsedMs % periodMs) + periodMs) % periodMs;
  return m / periodMs;
}
