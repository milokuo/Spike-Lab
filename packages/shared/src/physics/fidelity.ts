// M3.0a §4 — touch fidelity: the ONE execution-noise model. "Intent" (aim +
// spin + power) is what the player asked for; "fidelity" f ∈ [0,1] is how
// faithfully that intent is executed. f=1 is a perfect execution (identity — the
// launch is left exactly as intended). Lower f degrades it in a FIXED order:
//   1. direction — deflect the velocity within a random cone (aim scatter),
//   2. power     — scale |v| down toward a floor (a weak, mushy hit),
//   3. spin      — shrink ω hardest of all (spin needs the cleanest contact).
// fidelity ONLY adds noise; it NEVER corrects the intent (spec §0: a mistimed
// hit executes the WRONG aim faithfully-badly, it does not snap back on target).
//
// Determinism: every random draw comes from a mulberry32 PRNG seeded by
// hashSeed(playerId, serverTime), so a touch is replayable bit-for-bit on any
// machine (the seed is the same authoritative inputs both ends already agree on).
import { ERR_CONE_MAX_RAD, FIDELITY_EXP, FIDELITY_WINDOW_MS, PERFECT_WINDOW_MS, POWER_FLOOR, SPIN_FIDELITY_EXP } from '../constants';
import type { Vec3 } from '../math/vec3';
import { scale } from '../math/vec3';
import { cross } from './vecmath';

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

// f = fidelityOf(deltaMs): 1.0 inside the PERFECT window, then a decreasing
// curve that reaches 0 at the FIDELITY_WINDOW (the OK grading edge) and clamps to
// 0 beyond (spec §4). deltaMs is the |timing error| the lag-comp adjudicator
// already computed; the caller multiplies in the overcharge penalty separately.
export function fidelityOf(deltaMs: number): number {
  const abs = Math.abs(deltaMs);
  if (abs <= PERFECT_WINDOW_MS) return 1;
  const x = abs / FIDELITY_WINDOW_MS;
  return clamp01(1 - Math.pow(x, FIDELITY_EXP));
}

// Deterministic mulberry32 (identical to ballistics/launch's former scatter PRNG
// and the dive roll) — same seed ⇒ same sequence, everywhere.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A 32-bit seed from the two authoritative inputs both ends agree on: the
// player's id and the resolved server time of the touch (spec §4/§8.5 —
// η = seed(playerId, serverTime)). A tiny FNV-1a string hash mixed with the
// integer time keeps distinct players/instants well separated.
export function hashSeed(playerId: string, serverTime: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < playerId.length; i += 1) {
    h ^= playerId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= Math.floor(serverTime) | 0;
  h = Math.imul(h ^ (h >>> 13), 0x01000193);
  return h >>> 0;
}

// Build a unit vector perpendicular to `dir` at azimuth φ around it, then return
// dir rotated by `theta` toward that perpendicular. |result| = 1 (Rodrigues on an
// orthogonal axis reduces to cos·dir + sin·perp). Used for the §4 direction cone.
function deflect(dir: Vec3, phi: number, theta: number): Vec3 {
  // Pick a reference not parallel to dir, build an orthonormal {e1, e2} ⟂ dir.
  const ref: Vec3 = Math.abs(dir.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const e1raw = cross(ref, dir);
  const e1len = Math.hypot(e1raw.x, e1raw.y, e1raw.z) || 1;
  const e1 = scale(e1raw, 1 / e1len);
  const e2 = cross(dir, e1); // already unit (dir, e1 orthonormal)
  const perp: Vec3 = {
    x: Math.cos(phi) * e1.x + Math.sin(phi) * e2.x,
    y: Math.cos(phi) * e1.y + Math.sin(phi) * e2.y,
    z: Math.cos(phi) * e1.z + Math.sin(phi) * e2.z,
  };
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return { x: c * dir.x + s * perp.x, y: c * dir.y + s * perp.y, z: c * dir.z + s * perp.z };
}

const EPS = 1e-9;

export interface FidelityResult {
  velocity: Vec3;
  omega: Vec3;
}

// Apply the §4 three-step execution model to an intended (velocity, omega). f=1
// is a strict identity (θ=0, power ×1, spin ×1) so PERFECT/uncharged touches are
// left untouched. Pure + deterministic in `seed`.
export function applyFidelity(velocity: Vec3, omega: Vec3, f: number, seed: number): FidelityResult {
  const clampedF = clamp01(f);
  const rng = mulberry32(seed);
  const speed = Math.hypot(velocity.x, velocity.y, velocity.z);

  // 1. direction cone — random axis (φ) + signed magnitude (η ∈ [−1,1]).
  const phi = rng() * 2 * Math.PI;
  const eta = rng() * 2 - 1;
  const theta = (1 - clampedF) * ERR_CONE_MAX_RAD * eta;
  const dir = speed > EPS ? scale(velocity, 1 / speed) : { x: 0, y: 0, z: 0 };
  const deflected = speed > EPS ? deflect(dir, phi, theta) : dir;

  // 2. power floor — scale the (deflected) speed toward POWER_FLOOR.
  const powerMult = POWER_FLOOR + (1 - POWER_FLOOR) * clampedF;
  const newSpeed = speed * powerMult;

  // 3. spin — ω shrinks with f^SPIN_FIDELITY_EXP (scatters first).
  const spinMult = Math.pow(clampedF, SPIN_FIDELITY_EXP);

  return {
    velocity: scale(deflected, newSpeed),
    omega: scale(omega, spinMult),
  };
}
