import { BALL_RADIUS, COURT_LEN, COURT_WIDTH, EVENT_STEP_MS, NET_HEIGHT } from '../constants';
import type { Vec3 } from '../math/vec3';
import type { BallLaunch } from '../types/messages';

const HALF_WIDTH = COURT_WIDTH / 2;
const HALF_LENGTH = COURT_LEN / 2;

// pos(t) = origin + velocity*t + (0, -0.5*gravity*t^2, 0). Pure function of
// (launch, elapsedMs): identical inputs always yield an identical Vec3 on any
// machine, which is the whole point (spec §6.4) — no per-frame local physics.
export function ballPosition(launch: BallLaunch, elapsedMs: number): Vec3 {
  const t = elapsedMs / 1000;
  return {
    x: launch.origin.x + launch.velocity.x * t,
    y: launch.origin.y + launch.velocity.y * t - 0.5 * launch.gravity * t * t,
    z: launch.origin.z + launch.velocity.z * t,
  };
}

export function ballVelocity(launch: BallLaunch, elapsedMs: number): Vec3 {
  const t = elapsedMs / 1000;
  return {
    x: launch.velocity.x,
    y: launch.velocity.y - launch.gravity * t,
    z: launch.velocity.z,
  };
}

export type TrajectoryEventKind = 'ground' | 'net' | 'out' | 'none';

export interface TrajectoryEvent {
  kind: TrajectoryEventKind;
  atMs: number; // elapsed ms from launch.serverTime
  pos: Vec3;
}

// M2.7 §1 — EXACT net-plane contact time. z has no acceleration, so
// z(t) = z0 + vz·t is linear and the z=0 crossing time is closed-form
// (t = -z0/vz) — no scan error, so the resolved rebound starts precisely at the
// contact point. Returns null when the ball never crosses the plane within the
// net's height/width band inside [0, maxMs].
function netContact(launch: BallLaunch, maxMs: number): TrajectoryEvent | null {
  const vz = launch.velocity.z;
  if (vz === 0) return null; // parallel to the net — never crosses
  const tMs = (-launch.origin.z / vz) * 1000;
  if (tMs <= 0 || tMs > maxMs) return null;
  const pos = ballPosition(launch, tMs);
  // Contact only within the physical net band (below the tape top, above the
  // floor, inside the antennae). Above NET_HEIGHT the ball clears the net.
  if (pos.y < 0 || pos.y > NET_HEIGHT || Math.abs(pos.x) > HALF_WIDTH) return null;
  return { kind: 'net', atMs: tMs, pos };
}

// Exact time (ms) the ball's height reaches BALL_RADIUS on the way DOWN, from the
// closed-form y(t) = y0 + vy·t − ½g·t² = BALL_RADIUS. Used only to refine a
// grid-detected ground crossing (finding #4) so it can be ordered against the
// analytic net crossing without the ±EVENT_STEP_MS grid error. Clamped to the
// detected step; returns null when there is no real descending crossing.
function exactGroundMs(launch: BallLaunch, tHiMs: number): number | null {
  const g = launch.gravity;
  if (g <= 0) return null;
  const vy = launch.velocity.y;
  // From 0.5·g·t² − vy·t + (BALL_RADIUS − y0) = 0 -> disc = vy² + 2g(y0 − R).
  const disc = vy * vy + 2 * g * (launch.origin.y - BALL_RADIUS);
  if (disc < 0) return null;
  const ms = ((vy + Math.sqrt(disc)) / g) * 1000; // larger (descending) root
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(ms, tHiMs);
}

// Deterministic fixed-step scan (EVENT_STEP_MS, 250Hz) for ground/out — both
// ends run it identically (no float RNG), so the event time is bit-identical on
// server and every client. Net contact is solved analytically (netContact) and
// merged in by earliest time. Server treats the result as authoritative; clients
// call it only to know when to freeze/redirect the ball mesh.
export function firstEvent(launch: BallLaunch, maxMs: number): TrajectoryEvent {
  const net = netContact(launch, maxMs);

  for (let t = EVENT_STEP_MS; t <= maxMs; t += EVENT_STEP_MS) {
    const pos = ballPosition(launch, t);
    if (pos.y <= BALL_RADIUS) {
      // Ground/out lies in (t-EVENT_STEP_MS, t]. Finding #4: a net crossing must
      // only win if it truly happened EARLIER — compare against the exact ground
      // time (refined off the grid), not just the grid step, so a ball grounding
      // before it reaches the net reports ground, never net.
      if (net) {
        const groundMs = exactGroundMs(launch, t) ?? t;
        if (net.atMs < groundMs) return net;
      }
      const outOfBounds = Math.abs(pos.x) > HALF_WIDTH || Math.abs(pos.z) > HALF_LENGTH;
      return { kind: outOfBounds ? 'out' : 'ground', atMs: t, pos };
    }
    // No ground yet this step — an exact net crossing at/before t now wins.
    if (net && net.atMs <= t) return net;
  }

  // No ground/out inside the window — the net contact (if any) still stands.
  if (net) return net;
  return { kind: 'none', atMs: maxMs, pos: ballPosition(launch, maxMs) };
}
