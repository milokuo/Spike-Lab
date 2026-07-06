import { OVERCHARGE_MAX, OVERCHARGE_QUALITY_PENALTY } from '../constants';

// overchargeQualityMult(c) — M2.4 §5 red-zone quality penalty. Charge c <= 1.0
// carries no penalty (existing behavior, unchanged). Past 1.0, quality is
// docked linearly down to a floor of (1 - OVERCHARGE_QUALITY_PENALTY) at
// c = OVERCHARGE_MAX: the harder you overcharge, the worse the touch quality,
// even though chargeDistanceMult keeps rewarding it with more power/distance.
// c is clamped to OVERCHARGE_MAX on the high end; c <= 1 (including negative)
// always returns 1.
export function overchargeQualityMult(c: number): number {
  if (c <= 1) return 1;
  const clamped = Math.min(c, OVERCHARGE_MAX);
  return 1 - (OVERCHARGE_QUALITY_PENALTY * (clamped - 1)) / (OVERCHARGE_MAX - 1);
}
