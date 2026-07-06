// M3.0a §6 — default spin presets. Verifies spike topspin (∝ charge, capped),
// serve sidespin (∝ protractor eccentricity, curving TOWARD the aim — "偏哪側彎哪側"),
// and the dig/set micro-spin cap. The per-side world resolution goes through
// spinIntentToWorld (the single mirror entry), so we also pin that a serve aimed to
// one screen side curves that way for BOTH serving sides (mirror-consistent).
import { describe, expect, it } from 'vitest';
import {
  serveSpin,
  spikeSpin,
  softSpin,
  serveSpinWorld,
  spikeSpinWorld,
  softSpinWorld,
  rallySpinWorld,
  spinIntentToWorld,
  forwardZ,
  cross,
  SPIN_MAX,
  SERVE_SIDESPIN_MAX,
  SPIN_SOFT_MAX,
  type Side,
  type Vec3,
} from '../src/index';

const UP: Vec3 = { x: 0, y: 1, z: 0 };
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
// Serve aim in world space (serveAim.serveHorizontalDir convention): fz·(sinθ, cosθ).
const aimWorld = (side: Side, angleDeg: number): Vec3 => {
  const fz = forwardZ(side);
  const r = (angleDeg * Math.PI) / 180;
  return { x: fz * Math.sin(r), y: 0, z: fz * Math.cos(r) };
};
const screenRight = (side: Side): Vec3 => cross({ x: 0, y: 0, z: forwardZ(side) }, UP);

describe('spikeSpin (§6)', () => {
  it('is topspin proportional to charge', () => {
    expect(spikeSpin(0.5)).toEqual({ kind: 'top', rate: SPIN_MAX * 0.5 });
  });
  it('caps the rate at SPIN_MAX under overcharge', () => {
    expect(spikeSpin(1.3).rate).toBe(SPIN_MAX);
  });
});

describe('world-ω wrappers funnel through spinIntentToWorld (yaw = null)', () => {
  it('spike/soft/rally wrappers equal spinIntentToWorld of their intents', () => {
    for (const side of ['A', 'B'] as Side[]) {
      expect(spikeSpinWorld(0.6, side)).toEqual(spinIntentToWorld(spikeSpin(0.6), side, null));
      expect(softSpinWorld(0.4, side)).toEqual(spinIntentToWorld(softSpin(0.4), side, null));
      // rally dispatcher: spike -> topspin, dig/set -> the micro-spin.
      expect(rallySpinWorld('spike', 0.6, side)).toEqual(spikeSpinWorld(0.6, side));
      expect(rallySpinWorld('dig', 0.4, side)).toEqual(softSpinWorld(0.4, side));
      expect(rallySpinWorld('set', 0.4, side)).toEqual(softSpinWorld(0.4, side));
    }
  });
});

describe('softSpin (§6) — dig/set micro-spin', () => {
  it('stays at or below SPIN_SOFT_MAX', () => {
    expect(softSpin(0.5).rate).toBeCloseTo(SPIN_SOFT_MAX * 0.5, 9);
    expect(softSpin(1.3).rate).toBe(SPIN_SOFT_MAX); // charge clamped to 1
    expect(softSpin(2).rate).toBeLessThanOrEqual(SPIN_SOFT_MAX);
  });
});

describe('serveSpin (§6) — sidespin ∝ eccentricity, curving toward the aim', () => {
  it('a centered serve (angle 0) carries no sidespin', () => {
    expect(serveSpin(0).rate).toBe(0);
  });

  it('rate scales with |angle|/90 up to SERVE_SIDESPIN_MAX', () => {
    expect(serveSpin(90).rate).toBeCloseTo(SERVE_SIDESPIN_MAX, 9);
    expect(serveSpin(45).rate).toBeCloseTo(SERVE_SIDESPIN_MAX / 2, 9);
    expect(serveSpin(-45).rate).toBeCloseTo(SERVE_SIDESPIN_MAX / 2, 9);
  });

  it('+angle (aim toward the hitter screen-left) picks side-L; -angle picks side-R', () => {
    expect(serveSpin(30).kind).toBe('side-L');
    expect(serveSpin(-30).kind).toBe('side-R');
  });

  it('curves TOWARD the aimed screen side for BOTH serving sides (mirror-consistent)', () => {
    for (const side of ['A', 'B'] as Side[]) {
      const aim = aimWorld(side, 40); // aimed off-center
      const sr = screenRight(side);
      // aim·screenRight < 0 => aimed to the hitter's screen-LEFT.
      const aimScreenSide = Math.sign(dot(aim, sr));
      const omega = serveSpinWorld(40, side);
      const magnus = cross(omega, aim); // Magnus = ω × v
      const magnusScreenSide = Math.sign(dot(magnus, sr));
      expect(magnusScreenSide).toBe(aimScreenSide); // curve matches the aim side
      // sidespin is purely vertical (world ω = ±up), side-independent.
      expect(Math.abs(omega.x)).toBeCloseTo(0, 9);
      expect(Math.abs(omega.z)).toBeCloseTo(0, 9);
    }
  });
});
