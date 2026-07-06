import { CHARGE_DISTANCE_MULT_BASE, CHARGE_DISTANCE_MULT_SLOPE, OVERCHARGE_MAX } from '../constants';

// charge(c) — charge distance multiplier (spec §6.2, cap raised by M2.4 §5).
// Charge only affects distance, never quality directly (see
// overchargeQualityMult for the M2.4 red-zone quality penalty):
// chargeDistanceMult(0) = 1, chargeDistanceMult(1) = 1.6, and the pipeline
// keeps scaling linearly up to c = OVERCHARGE_MAX (1.3) — overcharging means
// "more power", not more distance-mult cap.
export function chargeDistanceMult(c: number): number {
  const clamped = Math.min(OVERCHARGE_MAX, Math.max(0, c));
  return CHARGE_DISTANCE_MULT_BASE + CHARGE_DISTANCE_MULT_SLOPE * clamped;
}
