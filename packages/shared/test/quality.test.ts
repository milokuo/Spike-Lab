import { describe, expect, it } from 'vitest';
import {
  chargeDistanceMult,
  computeQuality,
  fDistance,
  fTiming,
  gradeOf,
  overchargeQualityMult,
} from '../src/index';

describe('fDistance (§6.2 breakpoints)', () => {
  it('returns 1.0 within the sweet spot (d <= 0.5)', () => {
    expect(fDistance(0)).toBe(1.0);
    expect(fDistance(0.5)).toBe(1.0);
  });

  it('linearly decays from 1.0 to 0.5 across 0.5 < d <= 1.2', () => {
    expect(fDistance(1.2)).toBeCloseTo(0.5, 5);
    // midpoint of the reachable band
    expect(fDistance(0.85)).toBeCloseTo(0.75, 5);
  });

  it('linearly decays from 0.5 to 0.1 across 1.2 < d <= 1.8 (diving-save zone)', () => {
    expect(fDistance(1.8)).toBeCloseTo(0.1, 5);
    expect(fDistance(1.5)).toBeCloseTo(0.3, 5);
  });

  it('returns 0 beyond REACH_MAX (d > 1.8) — unreachable', () => {
    expect(fDistance(1.80001)).toBe(0);
    expect(fDistance(5)).toBe(0);
  });

  it('is continuous across the internal breakpoints (0.5 and 1.2)', () => {
    const eps = 1e-9;
    expect(fDistance(0.5 - eps)).toBeCloseTo(fDistance(0.5 + eps), 3);
    expect(fDistance(1.2 - eps)).toBeCloseTo(fDistance(1.2 + eps), 3);
  });

  it('has an intentional cliff at REACH_MAX (1.8): reachable vs unreachable', () => {
    expect(fDistance(1.8)).toBeCloseTo(0.1, 5);
    expect(fDistance(1.8 + 1e-9)).toBe(0);
  });
});

describe('fTiming (§6.2 Δt bands)', () => {
  it('returns 1.0 for |Δt| <= 60ms (PERFECT)', () => {
    expect(fTiming(0)).toBe(1.0);
    expect(fTiming(60)).toBe(1.0);
    expect(fTiming(-60)).toBe(1.0);
  });

  it('returns 0.8 for 60ms < |Δt| <= 150ms (GOOD)', () => {
    expect(fTiming(61)).toBe(0.8);
    expect(fTiming(150)).toBe(0.8);
  });

  it('returns 0.5 for 150ms < |Δt| <= 300ms (OK)', () => {
    expect(fTiming(151)).toBe(0.5);
    expect(fTiming(300)).toBe(0.5);
  });

  it('returns 0.2 for |Δt| > 300ms (WHIFF edge)', () => {
    expect(fTiming(301)).toBe(0.2);
    expect(fTiming(10_000)).toBe(0.2);
  });
});

describe('gradeOf (§6.2 grade labels, same bands as fTiming)', () => {
  it('maps each band boundary to the correct grade', () => {
    expect(gradeOf(60)).toBe('PERFECT');
    expect(gradeOf(61)).toBe('GOOD');
    expect(gradeOf(150)).toBe('GOOD');
    expect(gradeOf(151)).toBe('OK');
    expect(gradeOf(300)).toBe('OK');
    expect(gradeOf(301)).toBe('WHIFF');
  });
});

describe('chargeDistanceMult (§6.2: 1 + 0.6 * charge)', () => {
  it('returns 1.0 at charge = 0', () => {
    expect(chargeDistanceMult(0)).toBe(1.0);
  });

  it('returns 1.6 at charge = 1 (full charge => x1.6 distance)', () => {
    expect(chargeDistanceMult(1)).toBeCloseTo(1.6, 5);
  });

  it('clamps out-of-range charge to [0, OVERCHARGE_MAX] (M2.4 §5: cap raised from 1 to 1.3)', () => {
    expect(chargeDistanceMult(-1)).toBe(1.0);
    expect(chargeDistanceMult(2)).toBeCloseTo(1.78, 5); // 1 + 0.6 * 1.3, clamped at OVERCHARGE_MAX
  });

  it('keeps scaling past charge = 1 up to OVERCHARGE_MAX (overcharge = more power)', () => {
    expect(chargeDistanceMult(1.3)).toBeCloseTo(1.78, 5);
    expect(chargeDistanceMult(1.15)).toBeCloseTo(1.69, 5);
  });
});

describe('overchargeQualityMult (M2.4 §5: red-zone quality penalty)', () => {
  it('is 1 (no penalty) for c <= 1', () => {
    expect(overchargeQualityMult(0)).toBe(1);
    expect(overchargeQualityMult(0.5)).toBe(1);
    expect(overchargeQualityMult(1)).toBe(1);
  });

  it('linearly decays to 0.75 at the midpoint of the red zone (c = 1.15)', () => {
    expect(overchargeQualityMult(1.15)).toBeCloseTo(0.75, 5);
  });

  it('bottoms out at 0.5 at c = OVERCHARGE_MAX (1.3)', () => {
    expect(overchargeQualityMult(1.3)).toBeCloseTo(0.5, 5);
  });

  it('clamps c beyond OVERCHARGE_MAX to the 0.5 floor', () => {
    expect(overchargeQualityMult(1.5)).toBeCloseTo(0.5, 5);
    expect(overchargeQualityMult(100)).toBeCloseTo(0.5, 5);
  });

  it('returns 1 for negative c', () => {
    expect(overchargeQualityMult(-1)).toBe(1);
    expect(overchargeQualityMult(-100)).toBe(1);
  });
});

describe('computeQuality (§6.1: clamp01(f_distance * f_timing))', () => {
  it('is 1.0 for a perfect touch (sweet spot distance + perfect timing)', () => {
    expect(computeQuality(0, 0)).toBe(1.0);
  });

  it('multiplicatively combines both sub-functions', () => {
    // d=0.85 -> fDistance=0.75; Δt=100 -> fTiming=0.8
    expect(computeQuality(0.85, 100)).toBeCloseTo(0.75 * 0.8, 5);
  });

  it('is 0 when distance is unreachable regardless of timing', () => {
    expect(computeQuality(2, 0)).toBe(0);
  });

  it('stays within [0, 1] for extreme inputs', () => {
    const q = computeQuality(-100, -100);
    expect(q).toBeGreaterThanOrEqual(0);
    expect(q).toBeLessThanOrEqual(1);
  });
});
