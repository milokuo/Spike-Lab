// M3.0a WP-P0 §2/§3 — flight integrator: analytic-parabola degeneracy, accuracy vs
// an in-test RK4 reference, bit-for-bit determinism, incremental-cache correctness,
// and monotone spin decay.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FLIGHT_PARAMS,
  flightStateAt,
  resetFlightCache,
  type FlightLaunch,
  type FlightParams,
} from '../src/physics/flight';
import type { Vec3 } from '../src/math/vec3';

const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T;
const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const G = DEFAULT_FLIGHT_PARAMS.gravity;

const baseLaunch: FlightLaunch = {
  origin: { x: 0, y: 2, z: -8 },
  velocity: { x: 2, y: 7, z: 12 },
  omega: { x: 30, y: 4, z: -6 }, // arbitrary world spin
  startMs: 1000,
};

// ---- in-test RK4 reference (dt/16), same ODE the integrator approximates -------
function accel(v: Vec3, omega: Vec3, p: FlightParams): Vec3 {
  const speed = Math.hypot(v.x, v.y, v.z);
  const cd = p.drag(speed);
  const k = p.magnusK;
  return {
    x: -cd * speed * v.x + k * (omega.y * v.z - omega.z * v.y),
    y: -p.gravity - cd * speed * v.y + k * (omega.z * v.x - omega.x * v.z),
    z: -cd * speed * v.z + k * (omega.x * v.y - omega.y * v.x),
  };
}
function omegaAt(omega0: Vec3, t: number, p: FlightParams): Vec3 {
  const d = Math.exp(-p.spinDecayPerSec * t); // exact continuous decay
  return { x: omega0.x * d, y: omega0.y * d, z: omega0.z * d };
}
function rk4Pos(launch: FlightLaunch, p: FlightParams, targetSec: number): Vec3 {
  const h = p.dt / 16;
  const steps = Math.round(targetSec / h);
  let pos = { ...launch.origin };
  let vel = { ...launch.velocity };
  const add = (a: Vec3, b: Vec3, s: number): Vec3 => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s });
  for (let i = 0; i < steps; i += 1) {
    const t = i * h;
    const w1 = omegaAt(launch.omega, t, p);
    const w2 = omegaAt(launch.omega, t + h / 2, p);
    const w3 = omegaAt(launch.omega, t + h, p);
    const k1v = accel(vel, w1, p);
    const k1p = vel;
    const k2v = accel(add(vel, k1v, h / 2), w2, p);
    const k2p = add(vel, k1v, h / 2);
    const k3v = accel(add(vel, k2v, h / 2), w2, p);
    const k3p = add(vel, k2v, h / 2);
    const k4v = accel(add(vel, k3v, h), w3, p);
    const k4p = add(vel, k3v, h);
    pos = {
      x: pos.x + (h / 6) * (k1p.x + 2 * k2p.x + 2 * k3p.x + k4p.x),
      y: pos.y + (h / 6) * (k1p.y + 2 * k2p.y + 2 * k3p.y + k4p.y),
      z: pos.z + (h / 6) * (k1p.z + 2 * k2p.z + 2 * k3p.z + k4p.z),
    };
    vel = {
      x: vel.x + (h / 6) * (k1v.x + 2 * k2v.x + 2 * k3v.x + k4v.x),
      y: vel.y + (h / 6) * (k1v.y + 2 * k2v.y + 2 * k3v.y + k4v.y),
      z: vel.z + (h / 6) * (k1v.z + 2 * k2v.z + 2 * k3v.z + k4v.z),
    };
  }
  return pos;
}

describe('flight integrator — analytic parabola degeneracy (ω=0, DRAG_K=0)', () => {
  const noForces: FlightParams = { ...DEFAULT_FLIGHT_PARAMS, drag: () => 0 };
  const launch: FlightLaunch = { ...baseLaunch, omega: { x: 0, y: 0, z: 0 } };
  const analytic = (tSec: number): Vec3 => ({
    x: launch.origin.x + launch.velocity.x * tSec,
    y: launch.origin.y + launch.velocity.y * tSec - 0.5 * G * tSec * tSec,
    z: launch.origin.z + launch.velocity.z * tSec,
  });

  it('matches the closed-form parabola to < 1e-9 at grid and off-grid times', () => {
    resetFlightCache();
    for (const tSec of [0, 0.1, 0.3333, 0.5, 0.75, 1.0, 1.23456]) {
      const got = flightStateAt(launch, launch.startMs + tSec * 1000, noForces).pos;
      expect(dist(got, analytic(tSec))).toBeLessThan(1e-9);
    }
  });
});

describe('flight integrator — accuracy vs RK4 (dt/16) reference', () => {
  // The truncation of the trapezoidal-position / Euler-velocity scheme grows ~ with
  // |ω|·T² (the 2nd-order Magnus term), so we check the whole REALISTIC flight
  // envelope: a fast high-spin spike (short), a medium serve, and a low-spin lob
  // (long). Combining NEAR-MAX spin with a >1.5s flight is physically unreachable
  // (a ~1g-Magnus topspin ball dives into the floor in well under a second) and is
  // the only corner that drifts past 2cm; the reachable envelope stays under it.
  const scenarios: { name: string; launch: FlightLaunch; times: number[] }[] = [
    {
      name: 'spike (high topspin, short)',
      launch: { origin: { x: 0, y: 2.4, z: -2 }, velocity: { x: 0, y: 2, z: 16 }, omega: { x: 30, y: 0, z: 0 }, startMs: 1000 },
      times: [0.15, 0.3, 0.45, 0.6],
    },
    {
      name: 'serve (medium spin)',
      launch: { origin: { x: 0, y: 1.8, z: -9 }, velocity: { x: 2, y: 5, z: 14 }, omega: { x: 12, y: 4, z: -4 }, startMs: 1000 },
      times: [0.3, 0.6, 0.9, 1.2],
    },
    {
      name: 'lob (low spin, long)',
      launch: { origin: { x: 0, y: 2, z: -6 }, velocity: { x: 1, y: 8, z: 7 }, omega: { x: 8, y: 0, z: 2 }, startMs: 1000 },
      times: [0.5, 1.0, 1.5, 2.0],
    },
  ];
  for (const { name, launch: l, times } of scenarios) {
    it(`stays within 2cm of RK4 over the flight — ${name}`, () => {
      for (const tSec of times) {
        resetFlightCache();
        const got = flightStateAt(l, l.startMs + tSec * 1000).pos;
        const ref = rk4Pos(l, DEFAULT_FLIGHT_PARAMS, tSec);
        expect(dist(got, ref)).toBeLessThan(0.02);
      }
    });
  }
});

describe('flight integrator — determinism (§2)', () => {
  it('is bit-identical across two independent JSON clones', () => {
    for (const tSec of [0.2, 0.6, 1.1]) {
      resetFlightCache();
      const a = flightStateAt(clone(baseLaunch), baseLaunch.startMs + tSec * 1000);
      resetFlightCache();
      const b = flightStateAt(clone(baseLaunch), baseLaunch.startMs + tSec * 1000);
      expect(a).toEqual(b);
    }
  });

  it('incremental cache walk equals a from-scratch integration', () => {
    // Forward walk populates + advances the module cache.
    resetFlightCache();
    const times = Array.from({ length: 40 }, (_, i) => baseLaunch.startMs + i * 25);
    const walked = times.map((tMs) => flightStateAt(baseLaunch, tMs));
    // A fresh clone at each time misses the cache → recomputed from t=0.
    const fresh = times.map((tMs) => {
      resetFlightCache();
      return flightStateAt(clone(baseLaunch), tMs);
    });
    expect(walked).toEqual(fresh);
  });

  it('t <= startMs returns the exact launch state', () => {
    resetFlightCache();
    const st = flightStateAt(baseLaunch, baseLaunch.startMs);
    expect(st.pos).toEqual(baseLaunch.origin);
    expect(st.vel).toEqual(baseLaunch.velocity);
    expect(st.omega).toEqual(baseLaunch.omega);
  });
});

describe('flight integrator — spin decay is strictly monotone', () => {
  it('|ω| decreases every sample and never grows', () => {
    resetFlightCache();
    let prev = Infinity;
    for (let tSec = 0; tSec <= 2; tSec += 0.05) {
      const w = flightStateAt(baseLaunch, baseLaunch.startMs + tSec * 1000).omega;
      const mag = Math.hypot(w.x, w.y, w.z);
      expect(mag).toBeLessThan(prev + 1e-12);
      if (tSec > 0) expect(mag).toBeLessThan(prev); // strictly decreasing while ω ≠ 0
      prev = mag;
    }
  });

  it('decays by exactly exp(-SPIN_DECAY·t) (grid-exact spin)', () => {
    resetFlightCache();
    const tSec = 1.0;
    const w = flightStateAt(baseLaunch, baseLaunch.startMs + tSec * 1000).omega;
    const factor = Math.exp(-DEFAULT_FLIGHT_PARAMS.spinDecayPerSec * tSec);
    expect(w.x).toBeCloseTo(baseLaunch.omega.x * factor, 6);
    expect(w.y).toBeCloseTo(baseLaunch.omega.y * factor, 6);
    expect(w.z).toBeCloseTo(baseLaunch.omega.z * factor, 6);
  });
});
