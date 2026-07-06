// Single source of truth for the per-side player-view -> world-space transform
// (M2.1 direction fix). Keyboard input and TouchIntent.dirInput are always
// PLAYER-VIEW-LOCAL: y = +1 is "up" = toward the net; x = +1 is camera/screen
// right. The follow camera (client renderer.followPlayer) is mirrored per side
// (a 180-degree yaw between A and B), so world-space movement/aim MUST mirror
// too — otherwise the two disagree and input reads inverted on one axis per
// side (the live-playtest bug: side A left/right inverted, side B up/down
// inverted). Both client prediction and server application call THIS function
// so the two ends are guaranteed identical.
//
// Convention, derived directly from the camera basis (up = +Y):
//   forward (toward net) = cross-checked with renderer look direction:
//     side A (z<0 half) faces +Z, side B (z>0 half) faces -Z.
//   right (camera/screen right) = normalize(cross(forward, up)):
//     side A -> -X, side B -> +X.
// So worldX = input.x * rightX(side), worldZ = input.y * forwardZ(side).

import type { Side } from '../types/state';

export interface PlanarInput {
  x: number; // camera/screen right (+1) .. left (-1)
  y: number; // toward net (+1) .. away from net (-1)
}

export interface PlanarWorld {
  x: number;
  z: number;
}

// +Z for side A, -Z for side B — the direction "toward the net" in world space.
export function forwardZ(side: Side): number {
  return side === 'A' ? 1 : -1;
}

// -X for side A, +X for side B — "camera/screen right" in world space.
export function rightX(side: Side): number {
  return side === 'A' ? -1 : 1;
}

// Transform a player-view-local planar input (right = +x, toward-net = +y) into
// a world-space XZ vector for the given side. Pure; used identically by client
// prediction, server movement, intent resolution, and serve aim.
export function viewToWorld(input: PlanarInput, side: Side): PlanarWorld {
  return { x: input.x * rightX(side), z: input.y * forwardZ(side) };
}

// ---- M2.3 §5.2 — FPV yaw-relative movement -------------------------------
//
// InputFrame.yaw is `null` in third person (existing mirrored-per-side
// viewToWorld behavior, unchanged) or a world-space heading in RADIANS when
// the player is in first-person view. Convention (picked to make FPV init
// "facing net" fall out naturally, see §5.1):
//   - yaw = 0 points along world +Z.
//   - Positive yaw rotates +Z toward +X (i.e. forward(yaw) is +Z rotated by
//     `yaw` radians about the world +Y/up axis: forward = (sin(yaw), cos(yaw))
//     in the XZ plane). This is the same right-handed Y-axis rotation used
//     everywhere else in this codebase (three.js `rotation.y`/`rotateY`).
//   - right(yaw) = cross(forward, up), matching the convention documented on
//     rightX/forwardZ above, which is why yaw=0 lines up exactly with side A's
//     third-person forward (+Z, right=-X): initializing FPV yaw to 0 for side
//     A and to π (facing -Z) for side B reproduces "facing net" per side, and
//     the yaw path is otherwise a drop-in replacement for the mirrored path.
//   - W (move.y = +1) moves along forward(yaw) projected on the ground.
//   - D (move.x = +1) moves along right(yaw) ("heading's right").
//
// `side` is accepted (and used on the null-yaw path) purely so callers have a
// single entry point regardless of view mode; it is NOT used when yaw is a
// number, because the heading already fully encodes which way the player is
// facing (side only ever mattered for mirroring the OTHER convention).
function forwardFromYaw(yaw: number): PlanarWorld {
  return { x: Math.sin(yaw), z: Math.cos(yaw) };
}

function rightFromYaw(yaw: number): PlanarWorld {
  // cross(forward, up) with up = (0, 1, 0), forward = (sin(yaw), 0, cos(yaw))
  return { x: -Math.cos(yaw), z: Math.sin(yaw) };
}

// Single per-side/per-view-mode planar transform (§5.2). yaw === null keeps
// the existing viewToWorld (mirrored-per-side) behavior byte-for-byte; a
// finite yaw switches to the FPV heading-relative transform above. A
// non-finite yaw (should not happen — server validates/wraps before this is
// called, see wrapYaw) falls back to the null/third-person path defensively.
export function moveToWorld(move: PlanarInput, side: Side, yaw: number | null): PlanarWorld {
  if (yaw === null || !Number.isFinite(yaw)) {
    return viewToWorld(move, side);
  }
  const forward = forwardFromYaw(yaw);
  const right = rightFromYaw(yaw);
  return {
    x: move.x * right.x + move.y * forward.x,
    z: move.x * right.z + move.y * forward.z,
  };
}

// Validate + wrap a candidate yaw into [-π, π]. Non-finite input (NaN,
// +/-Infinity) has "treat as third person" semantics — this helper returns
// `null` for those so callers (server intent validation, §5.2) can feed the
// result straight into moveToWorld/InputFrame.yaw without a separate
// isFinite check.
export function wrapYaw(yaw: number): number | null {
  if (!Number.isFinite(yaw)) {
    return null;
  }
  const TWO_PI = Math.PI * 2;
  // Shift into [0, 2π), wrap, then shift back into [-π, π].
  const wrapped = (((yaw + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI;
  return wrapped - Math.PI;
}
