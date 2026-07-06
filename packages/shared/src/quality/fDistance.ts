import {
  DIVE_REACH_END,
  DIVE_REACH_MIN_QUALITY,
  DIVE_REACH_START,
  REACH_MID_QUALITY,
  SWEET_SPOT,
} from '../constants';

// f_distance(d) — distance quality (spec §6.2).
// d = horizontal distance between ball and character's touch point.
//   d <= 0.5            -> 1.0   (sweet spot)
//   0.5 < d <= 1.2       -> linear 1.0 -> 0.5 (reachable)
//   1.2 < d <= 1.8       -> linear 0.5 -> 0.1 (diving-save zone)
//   d > 1.8              -> unreachable; returns 0 (see REACH_MAX gate upstream)
export function fDistance(d: number): number {
  if (d <= SWEET_SPOT) return 1.0;

  if (d <= DIVE_REACH_START) {
    const t = (d - SWEET_SPOT) / (DIVE_REACH_START - SWEET_SPOT);
    return lerp(1.0, REACH_MID_QUALITY, t);
  }

  if (d <= DIVE_REACH_END) {
    const t = (d - DIVE_REACH_START) / (DIVE_REACH_END - DIVE_REACH_START);
    return lerp(REACH_MID_QUALITY, DIVE_REACH_MIN_QUALITY, t);
  }

  return 0;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
