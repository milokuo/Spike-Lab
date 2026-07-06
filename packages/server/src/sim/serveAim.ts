// M2.3 §3 angle-sweep serve geometry — the PURE aim + arc helpers used by
// MatchSim.serve. Kept out of matchSim.ts for cohesion (and file size): these
// are stateless functions of (side, angle, charge, origin height) only.
import {
  SERVE_BASE_SPEED,
  SERVE_JUMP_SPEED_MULT,
  GRAVITY,
  NET_HEIGHT,
  chargeDistanceMult,
  forwardZ,
  type Side,
  type Vec3,
} from '@spike/shared';

export const SERVE_HAND_HEIGHT = 1.5; // ground-serve hand height above the feet (§3.3)
export const SERVE_LOFT = 0.45; // ground serve upward fraction so it clears the net
export const AIRBORNE_EPS = 0.05; // player.y above this (at lag-comped release) => jump serve

// §3.3 jump-serve arc solve tuning: clear the net (NET_HEIGHT) at z=0 by this
// vertical margin, flattened from the higher release point. A higher origin or
// bigger charge naturally yields a flatter (even downward) arc.
const JUMP_NET_MARGIN = 0.35;
const JUMP_HORIZ_FRAC = 0.95; // approx horizontal share of the unit dir for the solve

// M2.3 §3.1 — horizontal serve aim: the unit "toward the net" heading for `side`
// rotated about +Y by `angleDeg` (the protractor angle, ∈ [-90, +90]). PURE and
// exported so tests and the client protractor share the one convention: angle 0
// = straight at the net; +angle sweeps toward the server's +X. Net-forward is
// +Z for side A and -Z for side B (shared forwardZ).
export function serveHorizontalDir(side: Side, angleDeg: number): { x: number; z: number } {
  const fz = forwardZ(side); // +1 (A) or -1 (B)
  const rad = (angleDeg * Math.PI) / 180;
  // Rotate (x=0, z=fz) by `rad` about +Y (three.js rotation.y convention):
  //   x' = x·cos + z·sin,  z' = -x·sin + z·cos.
  return { x: fz * Math.sin(rad), z: fz * Math.cos(rad) };
}

// Build the unit launch direction from the horizontal aim + a vertical loft
// fraction (positive = up, negative = downward). Mirrors the pre-M2.3 serve
// construction so buildBallLaunch's charge/scatter/height pipeline is unchanged.
export function serveUnitDir(side: Side, angleDeg: number, loft: number): Vec3 {
  const h = serveHorizontalDir(side, angleDeg);
  const horiz = 1 - Math.abs(loft);
  const withUp = { x: h.x * horiz, y: loft, z: h.z * horiz };
  const len = Math.hypot(withUp.x, withUp.y, withUp.z) || 1;
  return { x: withUp.x / len, y: withUp.y / len, z: withUp.z / len };
}

// §3.3 downward-capable jump loft, SOLVED from the release height: pick the
// vertical fraction whose launch clears the net by JUMP_NET_MARGIN given the
// charge-derived horizontal speed and the forward distance to the net. Clamped
// so a near-flat/slightly-downward arc is allowed from a high origin.
export function solveJumpLoft(originY: number, distToNet: number, angleDeg: number, charge: number): number {
  const speed = SERVE_BASE_SPEED * chargeDistanceMult(charge) * SERVE_JUMP_SPEED_MULT;
  const angleRad = (angleDeg * Math.PI) / 180;
  const forwardSpeed = Math.max(0.5, speed * Math.cos(angleRad) * JUMP_HORIZ_FRAC);
  const t = distToNet / forwardSpeed; // time to reach the net plane
  const vyNeeded = (NET_HEIGHT + JUMP_NET_MARGIN - originY) / t + 0.5 * GRAVITY * t;
  // M3.0a P1 removed buildBallLaunch's quality-driven heightFactor multiply
  // (quality is now informational-only, see ballistics/launch.ts) — this solve
  // no longer needs to pre-compensate for it. Previously divided vyNeeded by
  // sqrt(0.5 + 0.5*SERVE_QUALITY_JUMP) (~0.987) to cancel a downstream
  // multiply that no longer exists; that was a dead reference to a deleted
  // mechanism (docs/knowledge/pitfalls.md).
  const loft = vyNeeded / speed;
  return Math.min(0.5, Math.max(-0.1, loft));
}
