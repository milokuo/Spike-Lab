// M3.0a WP-P0 §3 — the SINGLE mirror entry point from a view-space spin intent to
// a world-space angular-velocity vector ω (rad/s, right-handed). This is the spin
// analogue of moveToWorld (intent/viewSpace.ts): the ONLY place a per-side mirror
// or a yaw rotation is allowed to touch spin. Anything downstream consumes the
// world ω directly and must never re-mirror it (iron rule 2, coordinate-systems.md).
//
// Alignment with moveToWorld (mandatory — same yaw/side convention):
//   - yaw === null (third person): "forward" (the hit/aim direction toward the net)
//     mirrors per side via forwardZ(side) — REUSED from viewSpace.ts so the mirror
//     lives in exactly one function for both movement and spin.
//   - finite yaw (FPV): forward = (sin yaw, 0, cos yaw), the same heading basis
//     moveToWorld uses; `side` is ignored because the heading fully encodes facing
//     (this is what makes a STALE yaw from a previous rally still resolve correctly —
//     it is used verbatim, never combined with side).
//
// View-space spin kinds (from the hitter's own screen, up = world +Y):
//   top    (topspin)  → ω ⟂ forward, Magnus pushes the ball DOWN  (it dives)
//   back   (backspin) → ω ⟂ forward, Magnus pushes the ball UP    (it floats)
//   side-R            → ω = -up,     Magnus toward the hitter's screen-RIGHT (curves right)
//   side-L            → ω = +up,     Magnus toward the hitter's screen-LEFT  (curves left)
//
// Derivation anchor (spec §3, must round-trip in the truth table): a ball hit along
// world +Z with topspin has its top surface rotating toward +Z ⇒ ω = +X̂, and then
// Magnus = ω×v = (0,-vz,0) presses it down. Here forward = +Z (side A / yaw 0), so
// top axis = up × forward = (0,1,0)×(0,0,1) = (+1,0,0) = +X̂. ✓
//
// Why these axes give the stated Magnus directions (v along forward):
//   right := forward × up  (screen-right; identical to viewSpace's cross(forward,up))
//   top  axis = up × forward = -right → Magnus = (up×forward)×forward = -up (down)
//   back axis = forward × up =  right → Magnus = +up (up)
//   side-R axis = -up              → Magnus = (-up)×forward = +right (screen-right)
//   side-L axis = +up              → Magnus =  up ×forward  = -right (screen-left)
import type { Vec3 } from '../math/vec3';
import { scale } from '../math/vec3';
import type { Side } from '../types/state';
import { forwardZ } from '../intent/viewSpace';
import { cross, negate } from './vecmath';

export type SpinKind = 'top' | 'back' | 'side-L' | 'side-R';

export interface SpinIntent {
  readonly kind: SpinKind;
  readonly rate: number; // spin magnitude, rad/s (sign/handedness is carried by `kind`)
}

const UP: Vec3 = { x: 0, y: 1, z: 0 };

// Horizontal "forward" (the aim/hit direction) for a given side + view mode,
// byte-aligned with moveToWorld: forwardZ(side) on the null-yaw path (the mirror),
// (sin yaw, cos yaw) on the FPV path (side unused, heading is authoritative).
export function spinForward(side: Side, yaw: number | null): Vec3 {
  if (yaw === null || !Number.isFinite(yaw)) {
    return { x: 0, y: 0, z: forwardZ(side) };
  }
  return { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
}

// The single conversion entry point. Returns the world-space ω vector (rad/s).
export function spinIntentToWorld(intent: SpinIntent, side: Side, yaw: number | null): Vec3 {
  const forward = spinForward(side, yaw);
  let axis: Vec3;
  switch (intent.kind) {
    case 'top':
      axis = cross(UP, forward); // -right; Magnus down
      break;
    case 'back':
      axis = cross(forward, UP); // +right; Magnus up
      break;
    case 'side-R':
      axis = negate(UP); // Magnus toward hitter's screen-right
      break;
    case 'side-L':
      axis = UP; // Magnus toward hitter's screen-left
      break;
  }
  return scale(axis, intent.rate);
}
