import { describe, expect, it } from 'vitest';
import { digDistanceQuality, diveSuccessProbability } from '../src/index';

describe('digDistanceQuality (§3.1 dig-only distance curve)', () => {
  it('returns 1.0 within the (widened) sweet spot (d <= 0.7)', () => {
    expect(digDistanceQuality(0)).toBe(1.0);
    expect(digDistanceQuality(0.7)).toBe(1.0);
  });

  it('linearly decays from 1.0 to 0.5 across 0.7 < d <= 1.5', () => {
    expect(digDistanceQuality(1.5)).toBeCloseTo(0.5, 5);
    expect(digDistanceQuality(1.1)).toBeCloseTo(0.75, 5); // midpoint of the band
  });

  it('linearly decays from 0.5 to 0.1 across 1.5 < d <= 2.2', () => {
    expect(digDistanceQuality(2.2)).toBeCloseTo(0.1, 5);
    expect(digDistanceQuality(1.85)).toBeCloseTo(0.3, 5); // midpoint of the band
  });

  it('returns 0 beyond DIG_REACH_MAX (d > 2.2) — a normal dig can no longer reach it', () => {
    expect(digDistanceQuality(2.20001)).toBe(0);
    expect(digDistanceQuality(5)).toBe(0);
  });

  it('is continuous across the internal breakpoints (0.7 and 1.5)', () => {
    const eps = 1e-9;
    expect(digDistanceQuality(0.7 - eps)).toBeCloseTo(digDistanceQuality(0.7 + eps), 3);
    expect(digDistanceQuality(1.5 - eps)).toBeCloseTo(digDistanceQuality(1.5 + eps), 3);
  });

  it('is continuous at the DIG_REACH_MAX cliff (2.2) approaching from inside the reachable band', () => {
    const eps = 1e-9;
    expect(digDistanceQuality(2.2 - eps)).toBeCloseTo(0.1, 3);
    expect(digDistanceQuality(2.2 + eps)).toBe(0);
  });
});

describe('diveSuccessProbability (§3.2 dive success chance)', () => {
  it('is 0.8 at d = DIG_REACH_MAX (2.2), the nearest dive attempt', () => {
    expect(diveSuccessProbability(2.2)).toBeCloseTo(0.8, 9);
  });

  it('is 0.2 at d = DIVE_REACH_MAX (3.4), the farthest dive attempt', () => {
    expect(diveSuccessProbability(3.4)).toBeCloseTo(0.2, 9);
  });

  it('is linear between the two endpoints', () => {
    expect(diveSuccessProbability(2.8)).toBeCloseTo(0.5, 9); // midpoint
  });

  it('clamps to 0.8 for d below DIG_REACH_MAX', () => {
    expect(diveSuccessProbability(0)).toBeCloseTo(0.8, 9);
    expect(diveSuccessProbability(2.2 - 0.5)).toBeCloseTo(0.8, 9);
  });

  it('clamps to 0.2 for d above DIVE_REACH_MAX', () => {
    expect(diveSuccessProbability(3.4 + 1)).toBeCloseTo(0.2, 9);
    expect(diveSuccessProbability(100)).toBeCloseTo(0.2, 9);
  });
});
