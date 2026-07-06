import { GRAVITY } from '../constants';
import { chargeDistanceMult } from '../quality/charge';
import type { Vec3 } from '../math/vec3';
import type { BallLaunch } from '../types/messages';

export interface BuildBallLaunchArgs {
  origin: Vec3;
  direction: Vec3; // unit-ish vector from intent/direction.ts
  baseSpeed: number;
  arcType: BallLaunch['arcType'];
  quality: number; // 0..1, carried on the packet (informational / client visuals)
  charge: number; // 0..1 (past 1 = overcharge), distance-only scaling
  serverTime: number;
  rngSeed: number;
  omega?: Vec3; // M3.0a §8.1 — world-space spin; defaults to spin-free (zero)
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

// M3.0a §8 — builds the NOMINAL ("perfectly executed") launch of an intent:
//   velocity = direction · baseSpeed · chargeDistanceMult(charge)
// with the intended world spin ω. It no longer bakes in timing/quality noise —
// that whole job now belongs to the single fidelity model (physics/fidelity.ts),
// which the sim applies to this launch's velocity + ω afterward (spec §4). The
// `quality` argument is still carried on the packet for the HUD / client visuals
// and the TouchResult; it no longer perturbs the geometry here.
export function buildBallLaunch(args: BuildBallLaunchArgs): BallLaunch {
  const quality = clamp01(args.quality);
  const speed = args.baseSpeed * chargeDistanceMult(args.charge);
  const velocity: Vec3 = {
    x: args.direction.x * speed,
    y: args.direction.y * speed,
    z: args.direction.z * speed,
  };

  return {
    origin: args.origin,
    velocity,
    omega: args.omega ?? ZERO,
    arcType: args.arcType,
    quality,
    gravity: GRAVITY,
    serverTime: args.serverTime,
    rngSeed: args.rngSeed,
  };
}
