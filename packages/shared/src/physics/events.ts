// M3.0a WP-P0 §2 — first flight event (ground / net / out) via a deterministic
// fixed-step scan that detects a crossing, then a FIXED number of bisection
// iterations (BISECT_ITERS = 20) to refine the exact time. Fixed iteration count ⇒
// bit-deterministic event time (no tolerance-dependent loop). Net plane and court
// bounds are passed in — P0 imports NO court constants (zero coupling, spec §2).
//
// EVENTS
//   ground / out : the ball descends through y = groundY. Same physical event; the
//                  landing position decides the label (in-court ⇒ ground, else out).
//   net          : the trajectory crosses the net plane (z = netZ) while inside the
//                  net band (|x| ≤ netHalfWidth, 0 ≤ y ≤ netTop). A crossing ABOVE
//                  netTop (cleared) or outside the antennae is not an event — the
//                  scan continues.
//
// EDGE-CASE PRIORITY (adjudicated here — spec §3 asked me to pick and justify):
//   1. Earliest exact (bisected) time wins, always.
//   2. Exact tie (|Δt| ≤ TIE_EPS_MS) between a net crossing and a landing ⇒ LANDING
//      wins. Rationale: a simultaneous net-plane crossing AT the floor means the
//      ball has reached the ground at the net base; it is dead/landed, and the net
//      soft-collision (a P1 mid-air rebound) only makes sense while airborne. So
//      "ground/out beats net" on a tie.
//   3. "out vs ground on the same landing tick" is one event, split by position: a
//      ball landing exactly ON a court line counts as IN (ground). Out requires the
//      landing point to be STRICTLY beyond the boundary. Rationale: line-ball favors
//      keeping the rally alive and matches the inclusive |x|≤half / |z|≤half bound
//      used everywhere else.
import type { Vec3 } from '../math/vec3';
import { BISECT_ITERS } from './constants';
import {
  advance,
  cloneState,
  DEFAULT_FLIGHT_PARAMS,
  freshState,
  spinDecayStep,
  subStep,
  type FlightLaunch,
  type FlightParams,
  type ScalarState,
} from './flight';

export type FlightEventType = 'ground' | 'net' | 'out';

export interface FlightBounds {
  readonly groundY: number; // ball-center y that counts as ground contact
  readonly netZ?: number; // net plane (default 0)
  readonly netHalfWidth: number; // antenna half-width
  readonly netTop: number; // net height (top-inclusive counts as contact)
  readonly courtHalfWidth: number; // |x| ≤ this ⇒ in-court
  readonly courtHalfLength: number; // |z| ≤ this ⇒ in-court
  readonly horizonMs: number; // max elapsed time to scan
}

export interface FlightEvent {
  type: FlightEventType;
  tMs: number; // ABSOLUTE (launch.startMs + elapsed)
  pos: Vec3;
  vel: Vec3;
  omega: Vec3;
}

const TIE_EPS_MS = 1e-6;

function landingType(pos: Vec3, bounds: FlightBounds): FlightEventType {
  const inCourt = Math.abs(pos.x) <= bounds.courtHalfWidth && Math.abs(pos.z) <= bounds.courtHalfLength;
  return inCourt ? 'ground' : 'out';
}

// Bisect [0, dt] for the sub-step time τ where f(state(τ)) crosses zero, given the
// signs at the endpoints. Fixed BISECT_ITERS iterations (deterministic). `base` is
// the grid snapshot at the interval start; state(τ) = subStep(base, params, τ).
function bisect(
  base: ScalarState,
  params: FlightParams,
  dt: number,
  f: (pos: Vec3) => number,
  fLoPositive: boolean,
): number {
  let lo = 0;
  let hi = dt;
  for (let i = 0; i < BISECT_ITERS; i += 1) {
    const mid = 0.5 * (lo + hi);
    const val = f(subStep(base, params, mid).pos);
    // Keep the sub-interval that still straddles the crossing.
    const positive = val > 0;
    if (positive === fLoPositive) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return 0.5 * (lo + hi);
}

export function firstFlightEvent(
  launch: FlightLaunch,
  bounds: FlightBounds,
  params: FlightParams = DEFAULT_FLIGHT_PARAMS,
): FlightEvent | null {
  const dt = params.dt;
  const decayStep = spinDecayStep(params);
  const netZ = bounds.netZ ?? 0;
  const maxSteps = Math.floor(bounds.horizonMs / 1000 / dt);

  const s = freshState(launch);
  // Immediate ground (ball starts at/under the floor).
  if (s.py <= bounds.groundY) {
    const st = subStep(s, params, 0);
    return { type: landingType(st.pos, bounds), tMs: launch.startMs, pos: st.pos, vel: st.vel, omega: st.omega };
  }

  let prev = cloneState(s); // grid state at the interval START (t = step*dt)
  for (let step = 0; step < maxSteps; step += 1) {
    const prevY = prev.py;
    const prevZrel = prev.pz - netZ;
    advance(s, params, decayStep);
    const tLo = step * dt;
    const currZrel = s.pz - netZ;

    const landed = s.py <= bounds.groundY && prevY > bounds.groundY;
    const crossedNet =
      (prevZrel > 0 && currZrel <= 0) || (prevZrel < 0 && currZrel >= 0);

    if (!landed && !crossedNet) {
      prev = cloneState(s);
      continue;
    }

    // Resolve the earliest true event inside this interval by exact bisected time.
    let landTau = Infinity;
    if (landed) {
      landTau = bisect(prev, params, dt, (p) => p.y - bounds.groundY, prevY - bounds.groundY > 0);
    }
    let netTau = Infinity;
    if (crossedNet) {
      const tau = bisect(prev, params, dt, (p) => p.z - netZ, prevZrel > 0);
      const at = subStep(prev, params, tau).pos;
      const inBand = Math.abs(at.x) <= bounds.netHalfWidth && at.y >= 0 && at.y <= bounds.netTop;
      if (inBand) netTau = tau;
    }

    // Net cleared the band and nothing landed → keep scanning.
    if (landTau === Infinity && netTau === Infinity) {
      prev = cloneState(s);
      continue;
    }

    // Priority: earliest wins; exact tie ⇒ landing (ground/out) beats net.
    const landTimeMs = (tLo + landTau) * 1000;
    const netTimeMs = (tLo + netTau) * 1000;
    const landingWins = landTau !== Infinity && landTimeMs <= netTimeMs + TIE_EPS_MS;

    if (landingWins) {
      const st = subStep(prev, params, landTau);
      return {
        type: landingType(st.pos, bounds),
        tMs: launch.startMs + landTimeMs,
        pos: st.pos,
        vel: st.vel,
        omega: st.omega,
      };
    }
    const st = subStep(prev, params, netTau);
    return { type: 'net', tMs: launch.startMs + netTimeMs, pos: st.pos, vel: st.vel, omega: st.omega };
  }
  return null; // no event within the horizon
}
