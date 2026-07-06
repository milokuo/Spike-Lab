import { fDistance } from './fDistance';
import { fTiming } from './fTiming';

// gradeOf, chargeDistanceMult, fDistance, fTiming, and REACH_MAX are each
// exported once from their own module and re-exported by the barrel
// (index.ts) — not duplicated here, to avoid ambiguous star-export clashes.

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

// quality = clamp01(f_distance(d) * f_timing(Δt)) — spec §6.1.
// The two sub-functions combine multiplicatively (harsh penalty: either being
// off on position OR timing meaningfully tanks quality).
export function computeQuality(d: number, deltaMs: number): number {
  return clamp01(fDistance(d) * fTiming(deltaMs));
}
