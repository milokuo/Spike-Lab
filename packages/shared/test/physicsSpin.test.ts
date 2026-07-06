// M3.0a WP-P0 §3 — ω sign-convention truth table. THIS is the round's gatekeeper
// (cameraBasis-grade, blood-history mandated). It enumerates side {A,B} × kind
// {top,back,side-L,side-R} × yaw {null,0,π/2} and pins, per cell, the world ω
// vector, the Magnus direction, and the defender's on-screen curve — plus a
// stale-yaw residual case (finite yaw must override `side`).
import { describe, expect, it } from 'vitest';
import { spinForward, spinIntentToWorld, type SpinIntent, type SpinKind } from '../src/physics/spin';
import { cross } from '../src/physics/vecmath';
import type { Vec3 } from '../src/math/vec3';
import type { Side } from '../src/types/state';

const RATE = 30;
const UP: Vec3 = { x: 0, y: 1, z: 0 };
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const closeVec = (a: Vec3, b: Vec3): void => {
  expect(a.x).toBeCloseTo(b.x, 9);
  expect(a.y).toBeCloseTo(b.y, 9);
  expect(a.z).toBeCloseTo(b.z, 9);
};

// Independent forward lookup (documented rule, NOT via the implementation) so the
// side/yaw → forward mapping itself is cross-checked.
const YAWS: { label: string; yaw: number | null }[] = [
  { label: 'yaw=null', yaw: null },
  { label: 'yaw=0', yaw: 0 },
  { label: 'yaw=π/2', yaw: Math.PI / 2 },
];
function expectedForward(side: Side, yaw: number | null): Vec3 {
  if (yaw === null) return { x: 0, y: 0, z: side === 'A' ? 1 : -1 };
  if (yaw === 0) return { x: 0, y: 0, z: 1 };
  return { x: 1, y: 0, z: 0 }; // yaw = π/2
}
// First-principles axis for a kind given a forward (right = forward × up).
function expectedAxis(kind: SpinKind, forward: Vec3): Vec3 {
  switch (kind) {
    case 'top':
      return cross(UP, forward); // -right
    case 'back':
      return cross(forward, UP); // +right
    case 'side-R':
      return { x: 0, y: -1, z: 0 };
    case 'side-L':
      return { x: 0, y: 1, z: 0 };
  }
}

const KINDS: SpinKind[] = ['top', 'back', 'side-L', 'side-R'];
const SIDES: Side[] = ['A', 'B'];

describe('spinIntentToWorld — ω truth table (spec §3, gatekeeper)', () => {
  it('spinForward matches the documented side/yaw rule for every cell', () => {
    for (const side of SIDES) {
      for (const { yaw } of YAWS) {
        closeVec(spinForward(side, yaw), expectedForward(side, yaw));
      }
    }
  });

  // ---- 24-cell enumeration: world ω + Magnus direction + |ω| ------------------
  for (const side of SIDES) {
    for (const { label, yaw } of YAWS) {
      for (const kind of KINDS) {
        it(`ω & Magnus: side ${side}, ${kind}, ${label}`, () => {
          const intent: SpinIntent = { kind, rate: RATE };
          const forward = expectedForward(side, yaw);
          const omega = spinIntentToWorld(intent, side, yaw);

          // 1) world ω == rate * first-principles axis
          closeVec(omega, scale(expectedAxis(kind, forward), RATE));
          // 2) |ω| preserved
          expect(Math.hypot(omega.x, omega.y, omega.z)).toBeCloseTo(RATE, 9);

          // 3) Magnus direction for v along forward
          const magnus = cross(omega, forward);
          const right = cross(forward, UP); // screen-right (viewSpace convention)
          if (kind === 'top') {
            expect(magnus.y).toBeLessThan(0); // dives
            expect(Math.abs(magnus.x)).toBeCloseTo(0, 9);
            expect(Math.abs(magnus.z)).toBeCloseTo(0, 9);
          } else if (kind === 'back') {
            expect(magnus.y).toBeGreaterThan(0); // floats
          } else {
            expect(Math.abs(magnus.y)).toBeCloseTo(0, 9); // sidespin ⇒ horizontal curve only
            const along = dot(magnus, right);
            if (kind === 'side-R') expect(along).toBeGreaterThan(0);
            else expect(along).toBeLessThan(0);
          }

          // 4) axis geometry: top/back ⟂ forward; sides are purely vertical
          if (kind === 'top' || kind === 'back') {
            expect(dot(omega, forward)).toBeCloseTo(0, 9);
            expect(omega.y).toBeCloseTo(0, 9);
          } else {
            expect(omega.x).toBeCloseTo(0, 9);
            expect(omega.z).toBeCloseTo(0, 9);
          }
        });
      }
    }
  }

  // ---- Absolute-truth anchor + mirror pins ------------------------------------
  it('ANCHOR: +Z flight topspin ⇒ ω = +X̂ ⇒ Magnus down (spec §3)', () => {
    const omega = spinIntentToWorld({ kind: 'top', rate: RATE }, 'A', null);
    closeVec(omega, { x: RATE, y: 0, z: 0 });
    const magnus = cross(omega, { x: 0, y: 0, z: 1 }); // v along +Z
    expect(magnus.y).toBeLessThan(0);
    expect(magnus).toEqual({ x: 0, y: -RATE, z: 0 });
  });

  it('side B topspin mirrors side A (ω = -X̂) at yaw=null', () => {
    closeVec(spinIntentToWorld({ kind: 'top', rate: RATE }, 'B', null), { x: -RATE, y: 0, z: 0 });
  });

  it('same view-space side-R makes BOTH defenders see a LEFT curve (mirror-consistent)', () => {
    for (const hitter of SIDES) {
      const defender: Side = hitter === 'A' ? 'B' : 'A';
      const forward = spinForward(hitter, null);
      const omega = spinIntentToWorld({ kind: 'side-R', rate: RATE }, hitter, null);
      const magnus = cross(omega, forward);
      const defenderScreenRight = cross(spinForward(defender, null), UP);
      // Ball curves toward the hitter's right ⇒ the net-facing defender sees LEFT.
      expect(dot(magnus, defenderScreenRight)).toBeLessThan(0);
    }
  });

  it('side-L is the exact opposite of side-R (defender sees RIGHT)', () => {
    const defenderScreenRight = cross(spinForward('B', null), UP);
    const magnusL = cross(spinIntentToWorld({ kind: 'side-L', rate: RATE }, 'A', null), spinForward('A', null));
    expect(dot(magnusL, defenderScreenRight)).toBeGreaterThan(0);
  });

  // ---- Stale-yaw residual (finite yaw must OVERRIDE side) ----------------------
  it('STALE YAW: side B with a finite yaw=0 resolves like yaw=0 (ω=+X̂), not side B null (-X̂)', () => {
    const staleYaw = 0; // residual heading left over from a previous rally
    const omega = spinIntentToWorld({ kind: 'top', rate: RATE }, 'B', staleYaw);
    closeVec(omega, { x: RATE, y: 0, z: 0 }); // side is ignored; heading wins
    // sanity: this differs from the side-B null result
    closeVec(spinIntentToWorld({ kind: 'top', rate: RATE }, 'B', null), { x: -RATE, y: 0, z: 0 });
  });

  it('a non-finite (NaN) yaw falls back to third-person side semantics', () => {
    const nan = spinIntentToWorld({ kind: 'top', rate: RATE }, 'B', Number.NaN);
    closeVec(nan, { x: -RATE, y: 0, z: 0 }); // == side B null
  });

  it('rate = 0 yields zero ω for every kind', () => {
    for (const kind of KINDS) {
      closeVec(spinIntentToWorld({ kind, rate: 0 }, 'A', null), { x: 0, y: 0, z: 0 });
    }
  });
});
