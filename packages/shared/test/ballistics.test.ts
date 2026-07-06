// M3.0a §8.2 — trajectory wrapper over the flight-model v2 integrator. The public
// ballPosition/ballVelocity/ballOmega/firstEvent keep their signatures; the model
// underneath now has drag + Magnus + spin decay, so the OLD "exactly a drag-free
// parabola" assertions are replaced with new-model expectations. The RIGOROUS
// integrator accuracy/determinism proofs live in physicsFlight.test.ts /
// physicsEvents.test.ts; here we verify the BallLaunch wrapper is deterministic,
// JSON-stable, drag-aware, and classifies events correctly.
import { describe, expect, it } from 'vitest';
import {
  BALL_RADIUS,
  ballOmega,
  ballPosition,
  ballVelocity,
  buildBallLaunch,
  firstEvent,
  GRAVITY,
  NET_HEIGHT,
  type BallLaunch,
} from '../src/index';

const baseLaunch: BallLaunch = {
  origin: { x: 0, y: 1, z: -8 },
  velocity: { x: 0, y: 5, z: 10 },
  omega: { x: 0, y: 0, z: 0 },
  arcType: 'spike',
  quality: 1,
  gravity: GRAVITY,
  serverTime: 1_000,
  rngSeed: 42,
};

describe('ballistics determinism (iron rule 1)', () => {
  it('same launch + elapsed time -> identical Vec3 across independent calls', () => {
    const t = 437;
    expect(ballPosition(baseLaunch, t)).toEqual(ballPosition(baseLaunch, t));
  });

  it('is identical across a JSON round-trip of the launch packet (cache-independent)', () => {
    const roundTripped = JSON.parse(JSON.stringify(baseLaunch)) as BallLaunch;
    for (const t of [0, 50, 250, 900]) {
      expect(ballPosition(roundTripped, t)).toEqual(ballPosition(baseLaunch, t));
    }
  });

  it('produces a sweep of identical positions across two independent evaluators', () => {
    const times = Array.from({ length: 50 }, (_, i) => i * 20);
    const first = times.map((t) => ballPosition(baseLaunch, t));
    const second = times.map((t) => ballPosition(baseLaunch, t));
    expect(first).toEqual(second);
  });

  it('returns the launch origin/velocity at t = 0', () => {
    expect(ballPosition(baseLaunch, 0)).toEqual(baseLaunch.origin);
    expect(ballVelocity(baseLaunch, 0)).toEqual(baseLaunch.velocity);
  });
});

describe('flight-model effects (drag + spin decay)', () => {
  it('horizontal speed decays over the flight (quadratic drag)', () => {
    const h0 = Math.hypot(baseLaunch.velocity.x, baseLaunch.velocity.z);
    const later = ballVelocity(baseLaunch, 700);
    const h1 = Math.hypot(later.x, later.z);
    expect(h1).toBeLessThan(h0); // drag bled off speed
    expect(h1).toBeGreaterThan(0.7 * h0); // but only modestly (DRAG_K is small)
  });

  it('spin magnitude decays monotonically toward zero', () => {
    const spun: BallLaunch = { ...baseLaunch, omega: { x: 20, y: 0, z: 5 } };
    const w0 = Math.hypot(spun.omega.x, spun.omega.z);
    const w1 = Math.hypot(ballOmega(spun, 500).x, ballOmega(spun, 500).z);
    const w2 = Math.hypot(ballOmega(spun, 1500).x, ballOmega(spun, 1500).z);
    expect(w1).toBeLessThan(w0);
    expect(w2).toBeLessThan(w1);
  });

  it('topspin (Magnus) makes a horizontal drive fall SHORTER than a no-spin one', () => {
    // Ball hit along +Z; topspin ω = +X presses it down (Magnus), so it lands sooner.
    const flat: BallLaunch = { ...baseLaunch, origin: { x: 0, y: 2, z: -4 }, velocity: { x: 0, y: 1, z: 12 }, omega: { x: 0, y: 0, z: 0 } };
    const top: BallLaunch = { ...flat, omega: { x: 40, y: 0, z: 0 } };
    const zFlat = firstEvent(flat, 5_000).pos.z;
    const zTop = firstEvent(top, 5_000).pos.z;
    expect(zTop).toBeLessThan(zFlat); // topspin dives -> shorter
  });
});

describe('firstEvent (ground/net/out landing detection)', () => {
  it('detects ground contact when the ball falls straight down', () => {
    const launch: BallLaunch = { ...baseLaunch, origin: { x: 0, y: 2, z: -5 }, velocity: { x: 0, y: 0, z: 0 } };
    const event = firstEvent(launch, 5_000);
    expect(event.kind).toBe('ground');
    expect(event.pos.y).toBeCloseTo(BALL_RADIUS, 2);
    // No drag on a purely vertical drop, so the fall time still ~ the free-fall time.
    const expectedSeconds = Math.sqrt((2 * (2 - BALL_RADIUS)) / GRAVITY);
    expect(event.atMs / 1000).toBeCloseTo(expectedSeconds, 1);
  });

  it('detects an out-of-bounds landing beyond the court edges', () => {
    const launch: BallLaunch = { ...baseLaunch, origin: { x: 0, y: 1, z: -8 }, velocity: { x: 20, y: 3, z: 30 } };
    expect(firstEvent(launch, 5_000).kind).toBe('out');
  });

  it('detects a net crossing below NET_HEIGHT within the court width', () => {
    const launch: BallLaunch = { ...baseLaunch, origin: { x: 0, y: 0.5, z: -1 }, velocity: { x: 0, y: 0, z: 4 } };
    const event = firstEvent(launch, 2_000);
    expect(event.kind).toBe('net');
    expect(event.pos.y).toBeLessThan(NET_HEIGHT);
    expect(event.pos.z).toBeCloseTo(0, 6);
  });

  it('reports "none" when no event occurs within maxMs, carrying the sampled state', () => {
    const launch: BallLaunch = { ...baseLaunch, origin: { x: 0, y: 100, z: -8 }, velocity: { x: 0, y: 0, z: 0 } };
    const event = firstEvent(launch, 10);
    expect(event.kind).toBe('none');
    expect(event.pos.y).toBeLessThan(100); // fell a hair over 10ms
  });

  it('yields a bit-identical event across repeated scans (deterministic)', () => {
    const launch: BallLaunch = { ...baseLaunch, origin: { x: 0, y: 3, z: -3 }, velocity: { x: 1, y: 2, z: 3 } };
    expect(firstEvent(launch, 5_000)).toEqual(firstEvent(launch, 5_000));
  });

  it('the event carries the velocity + spin at the contact instant', () => {
    const launch: BallLaunch = { ...baseLaunch, origin: { x: 0, y: 2, z: -3 }, velocity: { x: 0, y: 1, z: 5 }, omega: { x: 10, y: 0, z: 0 } };
    const ev = firstEvent(launch, 5_000);
    // The event resolves via bisection while ballVelocity re-samples via the grid
    // cache — bit paths differ by ~1 ULP, so compare closely (not bit-exact).
    const v = ballVelocity(launch, ev.atMs);
    const w = ballOmega(launch, ev.atMs);
    expect(ev.vel.x).toBeCloseTo(v.x, 9);
    expect(ev.vel.y).toBeCloseTo(v.y, 9);
    expect(ev.vel.z).toBeCloseTo(v.z, 9);
    expect(ev.omega.x).toBeCloseTo(w.x, 9);
  });
});

describe('buildBallLaunch', () => {
  it('is a pure function: identical args -> identical BallLaunch', () => {
    const args = {
      origin: { x: 0, y: 1, z: -8 },
      direction: { x: 0, y: 0.3, z: 0.9 },
      baseSpeed: 14,
      arcType: 'spike' as const,
      quality: 0.9,
      charge: 0.5,
      serverTime: 5_000,
      rngSeed: 7,
      omega: { x: 1, y: 2, z: 3 },
    };
    expect(buildBallLaunch(args)).toEqual(buildBallLaunch(args));
  });

  it('builds the NOMINAL velocity = direction * baseSpeed * chargeMult (no scatter)', () => {
    const launch = buildBallLaunch({
      origin: { x: 0, y: 1, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      baseSpeed: 10,
      arcType: 'spike',
      quality: 0.3, // low quality no longer perturbs the geometry
      charge: 0,
      serverTime: 0,
      rngSeed: 1,
    });
    expect(launch.velocity.x).toBeCloseTo(0, 12);
    expect(launch.velocity.z).toBeCloseTo(10, 12); // exactly on aim, chargeMult(0)=1
  });

  it('scales speed upward with charge (chargeDistanceMult, 0->1 = 1.6x)', () => {
    const base = {
      origin: { x: 0, y: 1, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      baseSpeed: 10,
      arcType: 'spike' as const,
      quality: 1,
      serverTime: 0,
      rngSeed: 1,
    };
    const noCharge = Math.hypot(buildBallLaunch({ ...base, charge: 0 }).velocity.z);
    const fullCharge = Math.hypot(buildBallLaunch({ ...base, charge: 1 }).velocity.z);
    expect(fullCharge / noCharge).toBeCloseTo(1.6, 2);
  });

  it('carries gravity, serverTime, quality, and omega through to the packet', () => {
    const launch = buildBallLaunch({
      origin: { x: 1, y: 2, z: 3 },
      direction: { x: 0, y: 1, z: 0 },
      baseSpeed: 5,
      arcType: 'dig',
      quality: 0.42,
      charge: 0,
      serverTime: 12_345,
      rngSeed: 9,
      omega: { x: 7, y: 0, z: -2 },
    });
    expect(launch.gravity).toBe(GRAVITY);
    expect(launch.serverTime).toBe(12_345);
    expect(launch.quality).toBeCloseTo(0.42, 9);
    expect(launch.omega).toEqual({ x: 7, y: 0, z: -2 });
  });

  it('defaults omega to a zero (spin-free) vector when not supplied', () => {
    const launch = buildBallLaunch({
      origin: { x: 0, y: 1, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      baseSpeed: 5,
      arcType: 'dig',
      quality: 1,
      charge: 0,
      serverTime: 0,
      rngSeed: 1,
    });
    expect(launch.omega).toEqual({ x: 0, y: 0, z: 0 });
  });
});
