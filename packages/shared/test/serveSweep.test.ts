import { describe, expect, it } from 'vitest';
import { SERVE_SWEEP_PERIOD_MS, sweepAngleDeg } from '../src/index';

// M2.3 §3.1 — the angle-sweep serve pointer is a pure function of elapsed ms
// since the serve phase started. Both client (local render) and server
// (lag-compensated release instant) call this SAME function, so these tests
// lock the exact triangle-wave shape both ends must agree on.
describe('sweepAngleDeg (M2.3 §3.1 protractor pointer)', () => {
  it('period constant matches spec (1600ms, 800/800 halves)', () => {
    expect(SERVE_SWEEP_PERIOD_MS).toBe(1600);
  });

  describe('endpoints', () => {
    it('starts at -90 at elapsed = 0', () => {
      expect(sweepAngleDeg(0)).toBe(-90);
    });

    it('reaches +90 at half the period (800ms)', () => {
      expect(sweepAngleDeg(SERVE_SWEEP_PERIOD_MS / 2)).toBe(90);
    });

    it('returns to -90 at a full period (1600ms) — periodic', () => {
      expect(sweepAngleDeg(SERVE_SWEEP_PERIOD_MS)).toBe(-90);
    });
  });

  describe('mid-phase values', () => {
    it('is 0 at the quarter point (400ms), rising leg', () => {
      expect(sweepAngleDeg(400)).toBeCloseTo(0, 10);
    });

    it('is 0 at the three-quarter point (1200ms), falling leg', () => {
      expect(sweepAngleDeg(1200)).toBeCloseTo(0, 10);
    });

    it('is -45 at 200ms (1/8 point, rising leg)', () => {
      expect(sweepAngleDeg(200)).toBeCloseTo(-45, 10);
    });

    it('is +45 at 600ms (rising leg, 3/8 point)', () => {
      expect(sweepAngleDeg(600)).toBeCloseTo(45, 10);
    });

    it('is +45 at 1000ms (falling leg, mirrors 600ms)', () => {
      expect(sweepAngleDeg(1000)).toBeCloseTo(45, 10);
    });

    it('is -45 at 1400ms (falling leg, mirrors 200ms)', () => {
      expect(sweepAngleDeg(1400)).toBeCloseTo(-45, 10);
    });
  });

  describe('periodicity', () => {
    it('repeats identically after any whole number of periods', () => {
      for (const t of [0, 123, 400, 799, 800, 1234, 1599]) {
        const base = sweepAngleDeg(t);
        expect(sweepAngleDeg(t + SERVE_SWEEP_PERIOD_MS)).toBeCloseTo(base, 10);
        expect(sweepAngleDeg(t + 3 * SERVE_SWEEP_PERIOD_MS)).toBeCloseTo(base, 10);
      }
    });
  });

  describe('symmetry (triangle wave: rising leg mirrors falling leg)', () => {
    it('sweepAngleDeg(t) === sweepAngleDeg(P - t) for 0 < t < P/2', () => {
      for (const t of [50, 200, 399.9, 600, 799]) {
        expect(sweepAngleDeg(t)).toBeCloseTo(sweepAngleDeg(SERVE_SWEEP_PERIOD_MS - t), 6);
      }
    });
  });

  describe('negative and large inputs (true modulo, not JS %)', () => {
    it('negative elapsed wraps to the equivalent point in-cycle', () => {
      // -400 mod 1600 == 1200, same as the 1200ms falling-leg case above.
      expect(sweepAngleDeg(-400)).toBeCloseTo(sweepAngleDeg(1200), 10);
      expect(sweepAngleDeg(-400)).toBeCloseTo(0, 10);
    });

    it('a full negative period matches elapsed = 0', () => {
      expect(sweepAngleDeg(-SERVE_SWEEP_PERIOD_MS)).toBeCloseTo(sweepAngleDeg(0), 10);
    });

    it('large multi-period elapsed values match their in-cycle equivalent', () => {
      const many = SERVE_SWEEP_PERIOD_MS * 50 + 600;
      expect(sweepAngleDeg(many)).toBeCloseTo(sweepAngleDeg(600), 10);
    });

    it('stays within [-90, 90] across a dense sample including negatives', () => {
      for (let t = -5000; t <= 5000; t += 37) {
        const angle = sweepAngleDeg(t);
        expect(angle).toBeGreaterThanOrEqual(-90);
        expect(angle).toBeLessThanOrEqual(90);
      }
    });
  });
});
