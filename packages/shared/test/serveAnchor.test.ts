// M3.0a §8.3 — velocity-compensation ANCHOR. Flight model v2 adds quadratic drag,
// which shortens a launch of the same speed. The SERVE/SPIKE base speeds were
// bumped (SERVE 8→9.0, SPIKE 9→10.0) so a no-spin flat power shot lands within ±5%
// of the OLD (drag-free) distance — keeping every prior round's feel/tuning. This
// test pins that: OLD model = the drag-free analytic parabola at the OLD base
// speed; NEW model = ballPosition (drag on) at the current base speed.
import { describe, expect, it } from 'vitest';
import {
  BALL_RADIUS,
  GRAVITY,
  SERVE_BASE_SPEED,
  SPIKE_BASE_SPEED,
  chargeDistanceMult,
  ballPosition,
  type BallLaunch,
  type Vec3,
} from '../src/index';

// Pre-M3 base speeds (the reference the compensation must reproduce).
const OLD_SERVE_BASE = 8;
const OLD_SPIKE_BASE = 9;

const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
const nominalVel = (dir: Vec3, base: number, charge: number): Vec3 => {
  const s = base * chargeDistanceMult(charge);
  return { x: dir.x * s, y: dir.y * s, z: dir.z * s };
};

// OLD drag-free parabola: horizontal distance when y returns to BALL_RADIUS.
function oldLandingDist(origin: Vec3, v: Vec3): number {
  const disc = v.y * v.y + 2 * GRAVITY * (origin.y - BALL_RADIUS);
  const t = (v.y + Math.sqrt(disc)) / GRAVITY; // descending root
  return Math.hypot(v.x * t, v.z * t);
}
// NEW flight model: scan ballPosition (drag on) for the ground crossing.
function newLandingDist(origin: Vec3, v: Vec3): number {
  const launch: BallLaunch = { origin, velocity: v, omega: { x: 0, y: 0, z: 0 }, arcType: 'serve', quality: 1, gravity: GRAVITY, serverTime: 0, rngSeed: 1 };
  let prev = origin;
  for (let ms = 4; ms <= 8000; ms += 4) {
    const p = ballPosition(launch, ms);
    if (p.y <= BALL_RADIUS && prev.y > BALL_RADIUS) {
      const f = (prev.y - BALL_RADIUS) / (prev.y - p.y);
      return Math.hypot((prev.x + (p.x - prev.x) * f) - origin.x, (prev.z + (p.z - prev.z) * f) - origin.z);
    }
    prev = p;
  }
  return NaN;
}

describe('velocity compensation anchor (§8.3)', () => {
  it('charge-0.8 no-spin flat serve lands within ±5% of the pre-drag distance', () => {
    // Serve geometry mirrors MatchSim.serve: station z=-9.8, hand y=1.5, flat loft
    // 0.45 straight at the net (serveUnitDir('A', 0, 0.45)).
    const origin: Vec3 = { x: 0, y: 1.5, z: -9.8 };
    const dir = unit({ x: 0, y: 0.45, z: 0.55 }); // 1-loft horizontal, loft up
    const oldDist = oldLandingDist(origin, nominalVel(dir, OLD_SERVE_BASE, 0.8));
    const newDist = newLandingDist(origin, nominalVel(dir, SERVE_BASE_SPEED, 0.8));
    expect(Math.abs(newDist / oldDist - 1)).toBeLessThanOrEqual(0.05);
  });

  it('charge-0.85 no-spin spike lands within ±5% of the pre-drag distance', () => {
    // Spike geometry mirrors resolveSpike: mid-court jump reach, upFraction 0.25,
    // aimed straight at the opponent half.
    const origin: Vec3 = { x: 0, y: 2.4, z: -2 };
    const dir = unit({ x: 0, y: 0.25, z: 0.75 });
    const oldDist = oldLandingDist(origin, nominalVel(dir, OLD_SPIKE_BASE, 0.85));
    const newDist = newLandingDist(origin, nominalVel(dir, SPIKE_BASE_SPEED, 0.85));
    expect(Math.abs(newDist / oldDist - 1)).toBeLessThanOrEqual(0.05);
  });
});
