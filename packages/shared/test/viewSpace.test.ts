import { describe, expect, it } from 'vitest';
import { forwardZ, moveToWorld, rightX, viewToWorld, wrapYaw } from '../src/index';

// The single per-side player-view -> world transform that both client
// prediction and server movement/intent/serve share (M2.1 direction fix).
// These tests lock the convention that resolved the live-playtest bug:
//   input.y = +1  -> "toward the net"
//   input.x = +1  -> "camera/screen right"
// mirrored per side so it matches the mirrored follow camera.
describe('viewToWorld (per-side player-view -> world)', () => {
  describe('forward = toward the net', () => {
    it('side A toward-net is +Z (side A is the z<0 half)', () => {
      expect(forwardZ('A')).toBe(1);
      expect(viewToWorld({ x: 0, y: 1 }, 'A').z).toBeGreaterThan(0);
    });

    it('side B toward-net is -Z (side B is the z>0 half)', () => {
      expect(forwardZ('B')).toBe(-1);
      expect(viewToWorld({ x: 0, y: 1 }, 'B').z).toBeLessThan(0);
    });

    it('"toward net" always reduces |z| — the e2e invariant', () => {
      // Side A player at z=-5 pressing forward moves +Z toward net (|z| down).
      const a = viewToWorld({ x: 0, y: 1 }, 'A');
      expect(-5 + a.z).toBeGreaterThan(-5); // closer to 0
      // Side B player at z=+5 pressing forward moves -Z toward net (|z| down).
      const b = viewToWorld({ x: 0, y: 1 }, 'B');
      expect(5 + b.z).toBeLessThan(5); // closer to 0
    });
  });

  describe('right = camera/screen right (mirrored per side)', () => {
    it('side A screen-right is world -X', () => {
      expect(rightX('A')).toBe(-1);
      expect(viewToWorld({ x: 1, y: 0 }, 'A').x).toBeLessThan(0);
    });

    it('side B screen-right is world +X', () => {
      expect(rightX('B')).toBe(1);
      expect(viewToWorld({ x: 1, y: 0 }, 'B').x).toBeGreaterThan(0);
    });
  });

  it('magnitude is preserved (only signs flip) so diagonals stay normal speed', () => {
    for (const side of ['A', 'B'] as const) {
      const w = viewToWorld({ x: 1, y: -1 }, side);
      expect(Math.abs(w.x)).toBe(1);
      expect(Math.abs(w.z)).toBe(1);
    }
  });

  it('neutral input maps to no world movement on either side', () => {
    for (const side of ['A', 'B'] as const) {
      const w = viewToWorld({ x: 0, y: 0 }, side);
      expect(Math.abs(w.x)).toBe(0); // tolerate -0 (signed-zero from sign flip)
      expect(Math.abs(w.z)).toBe(0);
    }
  });
});

// M2.3 §5.2 — moveToWorld(move, side, yaw) is the single transform client
// prediction and server movement both call. yaw === null must be byte-for-
// byte identical to the existing viewToWorld path; a finite yaw switches to
// the FPV heading-relative transform (yaw = 0 -> world +Z, positive yaw
// rotates +Z toward +X — see the convention comment on moveToWorld).
describe('moveToWorld (M2.3 §5.2)', () => {
  describe('yaw === null falls back to viewToWorld, per side', () => {
    const cases: Array<{ x: -1 | 0 | 1; y: -1 | 0 | 1 }> = [
      { x: 0, y: 1 },
      { x: 1, y: 0 },
      { x: -1, y: -1 },
      { x: 1, y: 1 },
      { x: 0, y: 0 },
    ];

    for (const side of ['A', 'B'] as const) {
      for (const move of cases) {
        it(`side ${side}, move (${move.x}, ${move.y})`, () => {
          expect(moveToWorld(move, side, null)).toEqual(viewToWorld(move, side));
        });
      }
    }
  });

  describe('yaw quadrant cases (0, π/2, π, -π/2), both axes', () => {
    it('yaw = 0: W (y=+1) -> +Z, D (x=+1) -> -X', () => {
      const w = moveToWorld({ x: 0, y: 1 }, 'A', 0);
      expect(w.x).toBeCloseTo(0, 10);
      expect(w.z).toBeCloseTo(1, 10);

      const d = moveToWorld({ x: 1, y: 0 }, 'A', 0);
      expect(d.x).toBeCloseTo(-1, 10);
      expect(d.z).toBeCloseTo(0, 10);
    });

    it('yaw = π/2: W -> +X, D -> +Z', () => {
      const w = moveToWorld({ x: 0, y: 1 }, 'A', Math.PI / 2);
      expect(w.x).toBeCloseTo(1, 10);
      expect(w.z).toBeCloseTo(0, 10);

      const d = moveToWorld({ x: 1, y: 0 }, 'A', Math.PI / 2);
      expect(d.x).toBeCloseTo(0, 10);
      expect(d.z).toBeCloseTo(1, 10);
    });

    it('yaw = π: W -> -Z (matches side B third-person forward), D -> +X (matches side B right)', () => {
      const w = moveToWorld({ x: 0, y: 1 }, 'A', Math.PI);
      expect(w.x).toBeCloseTo(0, 10);
      expect(w.z).toBeCloseTo(-1, 10);

      const d = moveToWorld({ x: 1, y: 0 }, 'A', Math.PI);
      expect(d.x).toBeCloseTo(1, 10);
      expect(d.z).toBeCloseTo(0, 10);
    });

    it('yaw = -π/2: W -> -X, D -> -Z', () => {
      const w = moveToWorld({ x: 0, y: 1 }, 'A', -Math.PI / 2);
      expect(w.x).toBeCloseTo(-1, 10);
      expect(w.z).toBeCloseTo(0, 10);

      const d = moveToWorld({ x: 1, y: 0 }, 'A', -Math.PI / 2);
      expect(d.x).toBeCloseTo(0, 10);
      expect(d.z).toBeCloseTo(-1, 10);
    });

    it('yaw is independent of `side` (heading fully encodes facing direction)', () => {
      for (const move of [
        { x: 0 as const, y: 1 as const },
        { x: 1 as const, y: 0 as const },
        { x: -1 as const, y: -1 as const },
      ]) {
        for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 1.234]) {
          expect(moveToWorld(move, 'A', yaw)).toEqual(moveToWorld(move, 'B', yaw));
        }
      }
    });

    it('magnitude is preserved for diagonal input at an arbitrary yaw', () => {
      const w = moveToWorld({ x: 1, y: -1 }, 'A', 0.77);
      const mag = Math.sqrt(w.x * w.x + w.z * w.z);
      expect(mag).toBeCloseTo(Math.sqrt(2), 10);
    });
  });

  describe('non-finite yaw falls back to the null/third-person path', () => {
    it('NaN yaw behaves like null', () => {
      const move = { x: 1, y: 1 };
      expect(moveToWorld(move, 'A', NaN)).toEqual(moveToWorld(move, 'A', null));
    });

    it('Infinity yaw behaves like null', () => {
      const move = { x: 1, y: 1 };
      expect(moveToWorld(move, 'B', Infinity)).toEqual(moveToWorld(move, 'B', null));
    });
  });
});

describe('wrapYaw (M2.3 §5.2 validation helper)', () => {
  it('leaves values already inside [-π, π] unchanged', () => {
    for (const yaw of [0, 1, -1, Math.PI / 2, -Math.PI / 2]) {
      expect(wrapYaw(yaw)).toBeCloseTo(yaw, 10);
    }
  });

  it('wraps values above π back into range', () => {
    expect(wrapYaw(Math.PI + 0.1)).toBeCloseTo(-Math.PI + 0.1, 10);
    expect(wrapYaw(2 * Math.PI)).toBeCloseTo(0, 10);
    expect(wrapYaw(3 * Math.PI)).toBeCloseTo(-Math.PI, 10);
  });

  it('wraps values below -π back into range', () => {
    expect(wrapYaw(-Math.PI - 0.1)).toBeCloseTo(Math.PI - 0.1, 10);
    expect(wrapYaw(-2 * Math.PI)).toBeCloseTo(0, 10);
  });

  it('result is always within [-π, π] across a dense sample', () => {
    for (let yaw = -20; yaw <= 20; yaw += 0.37) {
      const wrapped = wrapYaw(yaw);
      expect(wrapped).not.toBeNull();
      expect(wrapped as number).toBeGreaterThanOrEqual(-Math.PI - 1e-9);
      expect(wrapped as number).toBeLessThanOrEqual(Math.PI + 1e-9);
    }
  });

  it('returns null for non-finite input (NaN, +/-Infinity)', () => {
    expect(wrapYaw(NaN)).toBeNull();
    expect(wrapYaw(Infinity)).toBeNull();
    expect(wrapYaw(-Infinity)).toBeNull();
  });
});
