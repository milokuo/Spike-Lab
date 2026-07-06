// M3.0a WP-P0 §2 — deterministic fixed-step flight integrator (drag + Magnus +
// spin decay). Pure, no I/O. Server and every client run this identical code so a
// ball is described by a small FlightLaunch parameter pack plus elapsed time only —
// no per-frame local physics, zero drift (architecture iron rule 1).
//
// INTEGRATION SCHEME (important adjudication — see report):
//   Spec §2 says "semi-implicit Euler, PHYSICS_DT=1/240, update v then p". Taken
//   literally (p += v_new*dt) that scheme carries a systematic ~0.5·g·T·dt vertical
//   truncation: ~3cm at T=1.5s. That FAILS both §3 accuracy gates — the "<1e-9 vs
//   analytic parabola" degenerate test AND the "<2cm vs RK4" test. So we honor the
//   ORDER ("update v first, then p") but use the TRAPEZOIDAL position update
//     v' = v + a·dt ;  p += ½·(v + v')·dt
//   which equals p += v·dt + ½·a·dt² — EXACT for constant acceleration (gravity-only
//   ⇒ the analytic parabola to machine ε) and 2nd-order for the velocity-dependent
//   drag/Magnus terms (well under 2cm vs RK4 at 240Hz). The numbers, not the prose,
//   decide (debug iron rule: reproduce numerically first). This is a symplectic,
//   single-eval-per-step, allocation-free step.
//
// DETERMINISM: fixed dt, fixed operation order, and the step loop uses ONLY
//   + - * / and sqrt (drag() returns a constant in P0; no sin/cos/exp/pow in the
//   loop). The per-step spin-decay factor exp(-SPIN_DECAY·dt) is computed ONCE per
//   params (spec §2.4). Identical inputs ⇒ identical bits (asserted in tests).
import type { Vec3 } from '../math/vec3';
// M3.0a §8.2 — physics tunables now live in the shared constants barrel (folded
// in from the former physics/constants.ts, which is deleted). One source of truth.
import { DRAG_K, MAGNUS_K, PHYSICS_DT, PHYSICS_GRAVITY, SPIN_DECAY } from '../constants';

// P0-internal launch pack (spec §2 API). P1 folds `omega` into the wire BallLaunch.
export interface FlightLaunch {
  readonly origin: Vec3;
  readonly velocity: Vec3;
  readonly omega: Vec3; // world-space angular velocity (rad/s), from spinIntentToWorld
  readonly startMs: number; // absolute launch time; flightStateAt takes ABSOLUTE tMs
}

export interface FlightState {
  pos: Vec3;
  vel: Vec3;
  omega: Vec3;
}

// Effective quadratic-drag coefficient as a function of speed. P0 default is a
// constant (DRAG_K); 0c swaps in the speed-dependent "drag crisis" curve here.
export type DragCoeff = (speed: number) => number;

export interface FlightParams {
  readonly gravity: number; // magnitude, applied as -Y
  readonly drag: DragCoeff;
  readonly magnusK: number;
  readonly spinDecayPerSec: number;
  readonly dt: number; // seconds
}

export const DEFAULT_FLIGHT_PARAMS: FlightParams = {
  gravity: PHYSICS_GRAVITY,
  drag: () => DRAG_K,
  magnusK: MAGNUS_K,
  spinDecayPerSec: SPIN_DECAY,
  dt: PHYSICS_DT,
};

// Mutable scalar working state — no Vec3 allocation inside the hot loop.
export interface ScalarState {
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  ox: number;
  oy: number;
  oz: number;
}

export function freshState(launch: FlightLaunch): ScalarState {
  return {
    px: launch.origin.x,
    py: launch.origin.y,
    pz: launch.origin.z,
    vx: launch.velocity.x,
    vy: launch.velocity.y,
    vz: launch.velocity.z,
    ox: launch.omega.x,
    oy: launch.omega.y,
    oz: launch.omega.z,
  };
}

export function cloneState(s: ScalarState): ScalarState {
  return { ...s };
}

// Per-params derived constant: exact per-step spin-decay multiplier.
export function spinDecayStep(params: FlightParams): number {
  return Math.exp(-params.spinDecayPerSec * params.dt);
}

// Advance ONE full fixed step, mutating `s`. Loop-safe (only + - * / sqrt and the
// drag() injection point, which returns a constant in P0).
export function advance(s: ScalarState, params: FlightParams, decayStep: number): void {
  const dt = params.dt;
  const speed = Math.sqrt(s.vx * s.vx + s.vy * s.vy + s.vz * s.vz);
  const cd = params.drag(speed);
  const k = params.magnusK;
  // acceleration from CURRENT v and ω: gravity + quadratic drag + Magnus (ω × v).
  const ax = -cd * speed * s.vx + k * (s.oy * s.vz - s.oz * s.vy);
  const ay = -params.gravity - cd * speed * s.vy + k * (s.oz * s.vx - s.ox * s.vz);
  const az = -cd * speed * s.vz + k * (s.ox * s.vy - s.oy * s.vx);
  // update v FIRST (spec §2), then position via the trapezoid of old+new v.
  const nvx = s.vx + ax * dt;
  const nvy = s.vy + ay * dt;
  const nvz = s.vz + az * dt;
  s.px += 0.5 * (s.vx + nvx) * dt;
  s.py += 0.5 * (s.vy + nvy) * dt;
  s.pz += 0.5 * (s.vz + nvz) * dt;
  s.vx = nvx;
  s.vy = nvy;
  s.vz = nvz;
  // spin decay: precomputed factor, keeps the loop transcendental-free.
  s.ox *= decayStep;
  s.oy *= decayStep;
  s.oz *= decayStep;
}

// One trapezoidal sub-step of arbitrary size r (seconds) from a grid snapshot,
// WITHOUT mutating it. r = 0 returns the snapshot state exactly (accel·0 = 0,
// decay = e^0 = 1). Used to land exactly on a non-grid query time and for event
// bisection. exp() here is one call per query (outside the hot loop).
export function subStep(s: ScalarState, params: FlightParams, r: number): FlightState {
  const speed = Math.sqrt(s.vx * s.vx + s.vy * s.vy + s.vz * s.vz);
  const cd = params.drag(speed);
  const k = params.magnusK;
  const ax = -cd * speed * s.vx + k * (s.oy * s.vz - s.oz * s.vy);
  const ay = -params.gravity - cd * speed * s.vy + k * (s.oz * s.vx - s.ox * s.vz);
  const az = -cd * speed * s.vz + k * (s.ox * s.vy - s.oy * s.vx);
  const nvx = s.vx + ax * r;
  const nvy = s.vy + ay * r;
  const nvz = s.vz + az * r;
  const decay = Math.exp(-params.spinDecayPerSec * r);
  return {
    pos: { x: s.px + 0.5 * (s.vx + nvx) * r, y: s.py + 0.5 * (s.vy + nvy) * r, z: s.pz + 0.5 * (s.vz + nvz) * r },
    vel: { x: nvx, y: nvy, z: nvz },
    omega: { x: s.ox * decay, y: s.oy * decay, z: s.oz * decay },
  };
}

// ---- flightStateAt with an internal incremental cache (spec §2 API) ----------
//
// Single-entry module cache: a render/render-loop calls flightStateAt with a
// monotonically increasing tMs on the SAME launch object, so we step forward from
// the last grid position instead of re-integrating from t=0 every frame. The cache
// ONLY memoizes deterministic grid states, so the returned value is always
// bit-identical to a from-scratch integration (a different launch object — e.g. a
// JSON clone — simply misses the cache and recomputes; the determinism tests rely
// on exactly that). Non-forward or different-launch/params queries rebuild.
interface GridCache {
  launch: FlightLaunch;
  params: FlightParams;
  decayStep: number;
  step: number; // number of full dt steps baked into `s`
  s: ScalarState;
}

let gridCache: GridCache | null = null;

// Safety bound on elapsed time. The step integrator is O(elapsed·1/dt), so a query
// far in the future (e.g. a sampler handed an absolute wall-clock tMs against a
// launch whose startMs is a small test stamp) would otherwise walk billions of
// steps and hang. No real ball lives anywhere near this long — the event horizon
// (MAX_TRAJECTORY_MS ≈ 8s) bounds a live trajectory — so clamping the elapsed here
// is invisible to every realistic query and only tames the degenerate one.
const MAX_ELAPSED_S = 60;

export function flightStateAt(
  launch: FlightLaunch,
  tMs: number,
  params: FlightParams = DEFAULT_FLIGHT_PARAMS,
): FlightState {
  const dt = params.dt;
  const elapsedSec = Math.min(MAX_ELAPSED_S, Math.max(0, (tMs - launch.startMs) / 1000));
  const nSteps = Math.floor(elapsedSec / dt);
  const rem = elapsedSec - nSteps * dt;

  if (
    gridCache === null ||
    gridCache.launch !== launch ||
    gridCache.params !== params ||
    gridCache.step > nSteps
  ) {
    gridCache = {
      launch,
      params,
      decayStep: spinDecayStep(params),
      step: 0,
      s: freshState(launch),
    };
  }
  const cache = gridCache;
  while (cache.step < nSteps) {
    advance(cache.s, params, cache.decayStep);
    cache.step += 1;
  }
  return subStep(cache.s, params, rem > 0 ? rem : 0);
}

// Test/tooling hook: drop the incremental cache so a fresh from-scratch walk is
// forced. Not needed in production (correctness is cache-independent by design).
export function resetFlightCache(): void {
  gridCache = null;
}
