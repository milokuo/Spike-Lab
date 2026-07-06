// M2.2 §3.1/§3.2 — dig-only distance curve + dive success probability.
// mode='dig' uses THIS curve instead of the generic f_distance (fDistance.ts);
// set/spike are unaffected and keep using fDistance/REACH_MAX unchanged.

import { DIG_DECAY_END, DIG_REACH_MAX, DIG_SWEET, DIVE_REACH_MAX } from '../constants';

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

const DIG_MID_QUALITY = 0.5;
const DIG_MIN_QUALITY = 0.1;

// digDistanceQuality(d) — dig-mode distance quality (spec §3.1).
//   d <= DIG_SWEET (0.7)            -> 1.0
//   DIG_SWEET < d <= DIG_DECAY_END (1.5) -> linear 1.0 -> 0.5
//   DIG_DECAY_END < d <= DIG_REACH_MAX (2.2) -> linear 0.5 -> 0.1
//   d > DIG_REACH_MAX                -> 0 (unreachable as a normal dig; see dive)
export function digDistanceQuality(d: number): number {
  if (d <= DIG_SWEET) return 1.0;

  if (d <= DIG_DECAY_END) {
    const t = (d - DIG_SWEET) / (DIG_DECAY_END - DIG_SWEET);
    return lerp(1.0, DIG_MID_QUALITY, t);
  }

  if (d <= DIG_REACH_MAX) {
    const t = (d - DIG_DECAY_END) / (DIG_REACH_MAX - DIG_DECAY_END);
    return lerp(DIG_MID_QUALITY, DIG_MIN_QUALITY, t);
  }

  return 0;
}

// diveSuccessProbability(d) — spec §3.2: linear from 0.8 @ d=DIG_REACH_MAX
// (2.2) down to 0.2 @ d=DIVE_REACH_MAX (3.4), clamped outside that range (a
// dive attempt is only ever adjudicated for d in (DIG_REACH_MAX,
// DIVE_REACH_MAX], but this stays well-defined for any d).
const DIVE_P_NEAR = 0.8;
const DIVE_P_FAR = 0.2;

export function diveSuccessProbability(d: number): number {
  const t = clamp01((d - DIG_REACH_MAX) / (DIVE_REACH_MAX - DIG_REACH_MAX));
  return lerp(DIVE_P_NEAR, DIVE_P_FAR, t);
}
