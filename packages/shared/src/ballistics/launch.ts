import { BASE_SCATTER, GRAVITY } from '../constants';
import { chargeDistanceMult } from '../quality/charge';
import type { Vec3 } from '../math/vec3';
import type { BallLaunch } from '../types/messages';

export interface BuildBallLaunchArgs {
  origin: Vec3;
  direction: Vec3; // unit-ish vector from intent/direction.ts
  baseSpeed: number;
  arcType: BallLaunch['arcType'];
  quality: number; // 0..1, §6.1
  charge: number; // 0..1, §6.2
  serverTime: number;
  rngSeed: number;
}

// Deterministic PRNG (mulberry32): same seed -> same sequence, everywhere.
// Used only to derive the §6.3 scatter deviation, so the whole packet stays
// a pure function of its inputs (§6.4) — no engine Math.random() anywhere.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

// Builds the launch packet: velocity = direction * baseSpeed * charge distance
// multiplier, with a §6.3 scatter deviation (magnitude BASE_SCATTER * (1 -
// quality)) applied as a deterministic horizontal angular perturbation seeded
// by rngSeed, and a §6.3.1 height reduction when quality is low (peak height
// scales by 0.5 + 0.5*quality, so vertical speed scales by its square root).
export function buildBallLaunch(args: BuildBallLaunchArgs): BallLaunch {
  const quality = clamp01(args.quality);
  const speedMult = chargeDistanceMult(args.charge);
  const scatterAngleRad = scatterAngle(args.rngSeed, quality);
  const heightFactor = Math.sqrt(0.5 + 0.5 * quality); // §6.3.1

  const rotatedHoriz = rotateY(args.direction, scatterAngleRad);
  const speed = args.baseSpeed * speedMult;

  const velocity: Vec3 = {
    x: rotatedHoriz.x * speed,
    y: args.direction.y * speed * heightFactor,
    z: rotatedHoriz.z * speed,
  };

  return {
    origin: args.origin,
    velocity,
    arcType: args.arcType,
    quality,
    gravity: GRAVITY,
    serverTime: args.serverTime,
    rngSeed: args.rngSeed,
  };
}

// §6.3: scatter = base_scatter * (1 - quality). Converted to a bounded angle
// (radians) so imperfect touches drift off-target without ever reversing
// direction outright.
const MAX_SCATTER_ANGLE_RAD = Math.PI / 6; // 30 degrees at quality = 0

function scatterAngle(rngSeed: number, quality: number): number {
  const magnitude = (BASE_SCATTER * (1 - quality)) / BASE_SCATTER; // normalized 0..1
  const rand = mulberry32(rngSeed)(); // 0..1
  const signedUnit = rand * 2 - 1; // -1..1
  return signedUnit * magnitude * MAX_SCATTER_ANGLE_RAD;
}

function rotateY(v: Vec3, angleRad: number): Vec3 {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    x: v.x * cos + v.z * sin,
    y: v.y,
    z: -v.x * sin + v.z * cos,
  };
}
