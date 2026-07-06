import { GOOD_WINDOW_MS, OK_WINDOW_MS, PERFECT_WINDOW_MS } from '../constants';
import type { TouchGrade } from '../types/messages';

// f_timing(deltaMs) — timing quality (spec §6.2).
// deltaMs = |actual touch time - ideal touch time t*|
//   <= 60ms   -> 1.0  (PERFECT)
//   <= 150ms  -> 0.8  (GOOD)
//   <= 300ms  -> 0.5  (OK)
//   > 300ms   -> 0.2  (WHIFF edge)
export function fTiming(deltaMs: number): number {
  const abs = Math.abs(deltaMs);
  if (abs <= PERFECT_WINDOW_MS) return 1.0;
  if (abs <= GOOD_WINDOW_MS) return 0.8;
  if (abs <= OK_WINDOW_MS) return 0.5;
  return 0.2;
}

// Grade label for HUD feedback, derived from the same Δt bands (§6.2).
export function gradeOf(deltaMs: number): TouchGrade {
  const abs = Math.abs(deltaMs);
  if (abs <= PERFECT_WINDOW_MS) return 'PERFECT';
  if (abs <= GOOD_WINDOW_MS) return 'GOOD';
  if (abs <= OK_WINDOW_MS) return 'OK';
  return 'WHIFF';
}
