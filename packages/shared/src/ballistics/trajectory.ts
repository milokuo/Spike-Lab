// M3.0a §8.2 — the public ball-trajectory surface (ballPosition / ballVelocity /
// firstEvent) keeps its exact signatures but is now backed by the deterministic
// flight-model v2 integrator (physics/flight + physics/events): fixed-step, with
// quadratic drag, Magnus (ω) and spin decay. The ball is still a pure function of
// (BallLaunch, elapsedMs) — identical inputs yield an identical result on the
// server and every client, so nothing carries per-frame local ball physics (iron
// rule 1). Server and clients import ONLY these wrappers; the raw flight API is an
// implementation detail here.
import { BALL_RADIUS, COURT_LEN, COURT_WIDTH, NET_HEIGHT } from '../constants';
import type { Vec3 } from '../math/vec3';
import type { BallLaunch } from '../types/messages';
import { flightStateAt, type FlightLaunch, type FlightState } from '../physics/flight';
import { firstFlightEvent, type FlightBounds } from '../physics/events';

const HALF_WIDTH = COURT_WIDTH / 2;
const HALF_LENGTH = COURT_LEN / 2;

// The court/net bounds the event scanner needs. P0's events.ts imports no court
// constants (zero coupling), so we inject them here — the single place the flight
// engine meets this game's geometry. groundY = BALL_RADIUS (ball-center contact).
const COURT_BOUNDS: Omit<FlightBounds, 'horizonMs'> = {
  groundY: BALL_RADIUS,
  netZ: 0,
  netHalfWidth: HALF_WIDTH,
  netTop: NET_HEIGHT,
  courtHalfWidth: HALF_WIDTH,
  courtHalfLength: HALF_LENGTH,
};

// Give each BallLaunch a STABLE FlightLaunch identity so flightStateAt's internal
// incremental cache (which keys on object identity) accelerates the monotonic
// forward walk a render/tick loop performs. Correctness is cache-independent by
// design, so a different BallLaunch object (e.g. a JSON clone) simply gets its own
// entry and recomputes — determinism holds either way.
const flightLaunchByBall = new WeakMap<BallLaunch, FlightLaunch>();

function toFlightLaunch(launch: BallLaunch): FlightLaunch {
  let f = flightLaunchByBall.get(launch);
  if (!f) {
    f = { origin: launch.origin, velocity: launch.velocity, omega: launch.omega, startMs: launch.serverTime };
    flightLaunchByBall.set(launch, f);
  }
  return f;
}

// Full flight state at `elapsedMs` after launch. flightStateAt takes ABSOLUTE ms
// (launch.serverTime is the flight's startMs), so elapsed maps straight through.
function stateAt(launch: BallLaunch, elapsedMs: number): FlightState {
  return flightStateAt(toFlightLaunch(launch), launch.serverTime + elapsedMs);
}

// pos(t) under drag + Magnus + spin decay. Pure function of (launch, elapsedMs).
export function ballPosition(launch: BallLaunch, elapsedMs: number): Vec3 {
  return stateAt(launch, elapsedMs).pos;
}

export function ballVelocity(launch: BallLaunch, elapsedMs: number): Vec3 {
  return stateAt(launch, elapsedMs).vel;
}

// ω(t) — the decayed angular velocity at `elapsedMs`. Needed by the net-contact
// resolver (rebound spin damping) and available to client spin visuals (WP7).
export function ballOmega(launch: BallLaunch, elapsedMs: number): Vec3 {
  return stateAt(launch, elapsedMs).omega;
}

export type TrajectoryEventKind = 'ground' | 'net' | 'out' | 'none';

export interface TrajectoryEvent {
  kind: TrajectoryEventKind;
  atMs: number; // elapsed ms from launch.serverTime
  pos: Vec3;
  vel: Vec3; // velocity at the event instant (net rebound uses this)
  omega: Vec3; // spin at the event instant (net rebound damps this)
}

// Deterministic first ground/net/out event, delegating to the flight event
// scanner (fixed-step crossing detection + fixed-iteration bisection — bit-stable
// across machines). Server treats the result as authoritative; clients call it to
// know when to freeze/redirect the ball mesh. `kind: 'none'` when the horizon
// (maxMs) elapses with no event, carrying the sampled state at maxMs.
export function firstEvent(launch: BallLaunch, maxMs: number): TrajectoryEvent {
  const flightLaunch = toFlightLaunch(launch);
  const ev = firstFlightEvent(flightLaunch, { ...COURT_BOUNDS, horizonMs: maxMs });
  if (!ev) {
    const st = stateAt(launch, maxMs);
    return { kind: 'none', atMs: maxMs, pos: st.pos, vel: st.vel, omega: st.omega };
  }
  return { kind: ev.type, atMs: ev.tMs - launch.serverTime, pos: ev.pos, vel: ev.vel, omega: ev.omega };
}
