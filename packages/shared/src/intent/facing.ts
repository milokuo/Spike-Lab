// M2.5 §1 — per-player horizontal facing (radians), same yaw convention as
// moveToWorld/wrapYaw in viewSpace.ts: 0 = +Z, positive yaw rotates +Z toward
// +X about the world +Y axis (forward(yaw) = (sin(yaw), cos(yaw)) in the XZ
// plane). Server is the sole writer (see MatchRoom); client renders local
// players' facing instantly from the same inputs and remote players from the
// broadcast snapshot value.
import type { Side } from '../types/state';
import { moveToWorld, type PlanarInput } from './viewSpace';

// Initial value, before any input: face the net. Net is at z=0; side A spawns
// on the z<0 half and faces +Z (yaw=0), side B spawns on the z>0 half and
// faces -Z (yaw=π) — this matches the FPV yaw init documented in viewSpace.ts
// (forwardFromYaw(0) = +Z, forwardFromYaw(π) = -Z).
export function initialFacing(side: Side): number {
  return side === 'A' ? 0 : Math.PI;
}

// Priority (spec §1): explicit yaw (FPV heading) > horizontal movement
// direction (when the resolved world-space move vector is non-zero) > the
// previous facing value (idle players keep facing where they last faced).
export function computeFacing(
  prevFacing: number,
  side: Side,
  move: PlanarInput,
  yaw: number | null,
): number {
  if (yaw !== null && Number.isFinite(yaw)) return yaw;
  if (move.x !== 0 || move.y !== 0) {
    const world = moveToWorld(move, side, yaw);
    if (world.x !== 0 || world.z !== 0) return Math.atan2(world.x, world.z);
  }
  return prevFacing;
}
