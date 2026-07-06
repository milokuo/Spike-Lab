// M2.7 §1 — net soft-collision resolution (pure function, unit-tested).
//
// The net is the z=0 plane, |x| <= COURT_WIDTH/2, y in [0, NET_TOP]. When the
// authoritative ball's trajectory crosses that plane below the tape, the server
// resolves the contact into a NEW BallLaunch that starts from the exact contact
// point/time. Two zones:
//
//   tape  (y in [NET_TOP - NET_TAPE_H, NET_TOP]): the ball passes OVER, damped —
//         every component ×NET_TAPE_DAMP and an extra −NET_TAPE_VY_DROP on vy so
//         it flops down onto the far side (this is the "let serve").
//   face  (y <  NET_TOP - NET_TAPE_H): a soft, near-vertical rebound — vz reverses
//         at ×NET_RESTITUTION (bounces back toward the hitter's side), vx ×0.5,
//         vy unchanged (gravity keeps pulling it down). The rebound vz is floored
//         at NET_MIN_REBOUND_SPEED so a very weak contact still cleanly separates
//         onto the hitter's side instead of numerically hovering on the plane.
//
// Anti-jitter: because z has no acceleration, z(t) = z0 + vz·t is linear, so a
// crossing time is EXACT (t = -z0/vz) and there is exactly one. After a bounce the
// z-velocity reverses sign and stays constant, so the ball moves monotonically
// away from the plane and can never re-collide with the same launch. We still nudge
// the resolved origin NET_CONTACT_EPS off the plane along the outgoing z direction
// so a scan starting at the contact can't re-detect the crossing at t≈0.
import {
  NET_TOP,
  NET_TAPE_H,
  NET_TAPE_DAMP,
  NET_TAPE_VY_DROP,
  NET_RESTITUTION,
  NET_FACE_HORIZ_DAMP,
  NET_MIN_REBOUND_SPEED,
  NET_CONTACT_EPS,
} from '../constants';
import type { Vec3 } from '../math/vec3';

export type NetZone = 'tape' | 'face';

export interface NetResolveResult {
  zone: NetZone;
  origin: Vec3; // contact point, nudged NET_CONTACT_EPS off the z=0 plane
  velocity: Vec3; // post-collision velocity for the new BallLaunch
}

const sign = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);

// Face rebound z: reverse+damp the incoming z, then enforce a minimum separation
// speed (NET_MIN_REBOUND_SPEED) so a weak contact never numerically stalls on the
// z=0 plane. Direction is the reversed incoming side (toward the hitter).
function faceReboundZ(incomingVz: number): number {
  const raw = -incomingVz * NET_RESTITUTION;
  const dir = sign(raw) || -sign(incomingVz);
  return Math.abs(raw) < NET_MIN_REBOUND_SPEED ? dir * NET_MIN_REBOUND_SPEED : raw;
}

/**
 * Resolve a net contact into the outgoing (origin, velocity) for a new launch.
 * `contactPos` is the exact point the ball meets the z=0 plane (z≈0); `incomingVel`
 * is the ball's velocity at that instant. Pure — no RNG, no globals.
 */
export function resolveNetCollision(
  contactPos: Readonly<Vec3>,
  incomingVel: Readonly<Vec3>,
): NetResolveResult {
  const isTape = contactPos.y >= NET_TOP - NET_TAPE_H;

  const velocity: Vec3 = isTape
    ? {
        // Tape: damp everything, drag down, keep crossing to the far side.
        x: incomingVel.x * NET_TAPE_DAMP,
        y: incomingVel.y * NET_TAPE_DAMP - NET_TAPE_VY_DROP,
        z: incomingVel.z * NET_TAPE_DAMP,
      }
    : {
        // Face: reverse (and heavily damp) z, halve x, let gravity keep y. Floor
        // the rebound speed at NET_MIN_REBOUND_SPEED (finding #5) so a near-zero
        // contact still leaves the net cleanly toward the hitter and drops.
        x: incomingVel.x * NET_FACE_HORIZ_DAMP,
        y: incomingVel.y,
        z: faceReboundZ(incomingVel.z),
      };

  // Nudge off the plane along the outgoing z; if the rebound z is ~0 (ball
  // resting against the net) fall back to the incoming side so gravity drops it.
  const outSign = sign(velocity.z) || -sign(incomingVel.z);
  const origin: Vec3 = {
    x: contactPos.x,
    y: contactPos.y,
    z: outSign * NET_CONTACT_EPS,
  };

  return { zone: isTape ? 'tape' : 'face', origin, velocity };
}
