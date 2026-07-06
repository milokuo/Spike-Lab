// M3.0a §4 — touch fidelity: the timing→execution-noise model. Verifies the
// fidelity curve, the three-step transform (direction cone → power floor → spin),
// f=1 identity, determinism in the seed, and the seed hash.
import { describe, expect, it } from 'vitest';
import {
  applyFidelity,
  fidelityOf,
  hashSeed,
  ERR_CONE_MAX_RAD,
  POWER_FLOOR,
  SPIN_FIDELITY_EXP,
  PERFECT_WINDOW_MS,
  OK_WINDOW_MS,
  type Vec3,
} from '../src/index';

const V: Vec3 = { x: 0, y: 3, z: 12 };
const W: Vec3 = { x: 30, y: 0, z: 0 };
const mag = (v: Vec3): number => Math.hypot(v.x, v.y, v.z);
const angleBetween = (a: Vec3, b: Vec3): number =>
  Math.acos((a.x * b.x + a.y * b.y + a.z * b.z) / (mag(a) * mag(b)));

describe('fidelityOf (§4)', () => {
  it('is 1.0 inside the PERFECT window', () => {
    expect(fidelityOf(0)).toBe(1);
    expect(fidelityOf(PERFECT_WINDOW_MS)).toBe(1);
    expect(fidelityOf(-PERFECT_WINDOW_MS)).toBe(1); // symmetric in |Δ|
  });

  it('decreases monotonically past the PERFECT window and hits 0 at the OK edge', () => {
    const mid = fidelityOf(150);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(fidelityOf(OK_WINDOW_MS)).toBeCloseTo(0, 9);
    expect(fidelityOf(500)).toBe(0); // clamped beyond the window
  });
});

describe('applyFidelity — three-step execution (§4)', () => {
  it('f = 1 is a strict identity (perfect execution)', () => {
    const r = applyFidelity(V, W, 1, hashSeed('p1', 1000));
    expect(r.velocity.x).toBeCloseTo(V.x, 9);
    expect(r.velocity.y).toBeCloseTo(V.y, 9);
    expect(r.velocity.z).toBeCloseTo(V.z, 9);
    expect(r.omega).toEqual(W);
  });

  it('step 2 (power): |v| scales toward POWER_FLOOR as f drops', () => {
    const s0 = mag(V);
    // f=0 -> speed exactly POWER_FLOOR × s0.
    expect(mag(applyFidelity(V, W, 0, 7).velocity)).toBeCloseTo(POWER_FLOOR * s0, 6);
    // f=0.5 -> POWER_FLOOR + 0.5(1-POWER_FLOOR).
    const expectedMult = POWER_FLOOR + 0.5 * (1 - POWER_FLOOR);
    expect(mag(applyFidelity(V, W, 0.5, 7).velocity)).toBeCloseTo(expectedMult * s0, 6);
  });

  it('step 3 (spin): |ω| scales by f^SPIN_FIDELITY_EXP', () => {
    const r = applyFidelity(V, W, 0.4, 123);
    expect(mag(r.omega)).toBeCloseTo(mag(W) * Math.pow(0.4, SPIN_FIDELITY_EXP), 6);
  });

  it('step 1 (direction): deflection never exceeds the (1-f)·cone bound', () => {
    // Compare the deflected direction to the intended one across many seeds.
    for (let seed = 1; seed <= 200; seed += 1) {
      const f = 0.2;
      const r = applyFidelity(V, W, f, seed);
      const dev = angleBetween(V, r.velocity);
      expect(dev).toBeLessThanOrEqual((1 - f) * ERR_CONE_MAX_RAD + 1e-9);
    }
  });

  it('is deterministic in the seed (same seed -> same result)', () => {
    const a = applyFidelity(V, W, 0.3, hashSeed('player-A', 42_000));
    const b = applyFidelity(V, W, 0.3, hashSeed('player-A', 42_000));
    expect(a).toEqual(b);
  });

  it('different seeds generally give different deflections', () => {
    const a = applyFidelity(V, W, 0.3, hashSeed('player-A', 42_000));
    const b = applyFidelity(V, W, 0.3, hashSeed('player-B', 42_000));
    expect(a.velocity).not.toEqual(b.velocity);
  });
});

describe('hashSeed (§4)', () => {
  it('is a deterministic 32-bit unsigned value', () => {
    const s = hashSeed('abc', 12345);
    expect(s).toBe(hashSeed('abc', 12345));
    expect(Number.isInteger(s) && s >= 0 && s <= 0xffffffff).toBe(true);
  });

  it('separates distinct players and instants', () => {
    expect(hashSeed('a', 1000)).not.toBe(hashSeed('b', 1000));
    expect(hashSeed('a', 1000)).not.toBe(hashSeed('a', 1001));
  });
});
