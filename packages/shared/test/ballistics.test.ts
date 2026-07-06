import { describe, expect, it } from 'vitest';
import {
  BALL_RADIUS,
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
  arcType: 'spike',
  quality: 1,
  gravity: GRAVITY,
  serverTime: 1_000,
  rngSeed: 42,
};

describe('ballistics determinism (§6.4)', () => {
  it('same launch + elapsed time -> identical Vec3 across independent calls', () => {
    const t = 437;
    const a = ballPosition(baseLaunch, t);
    const b = ballPosition(baseLaunch, t);
    expect(a).toEqual(b);
  });

  it('is identical across a JSON round-trip of the launch packet', () => {
    const roundTripped = JSON.parse(JSON.stringify(baseLaunch)) as BallLaunch;
    for (const t of [0, 50, 250, 900]) {
      expect(ballPosition(roundTripped, t)).toEqual(ballPosition(baseLaunch, t));
    }
  });

  it('matches the closed-form parabola exactly', () => {
    const t = 500;
    const seconds = t / 1000;
    const pos = ballPosition(baseLaunch, t);
    expect(pos.x).toBeCloseTo(baseLaunch.origin.x + baseLaunch.velocity.x * seconds, 9);
    expect(pos.y).toBeCloseTo(
      baseLaunch.origin.y + baseLaunch.velocity.y * seconds - 0.5 * baseLaunch.gravity * seconds * seconds,
      9,
    );
    expect(pos.z).toBeCloseTo(baseLaunch.origin.z + baseLaunch.velocity.z * seconds, 9);
  });

  it('ballVelocity integrates gravity over elapsed time', () => {
    const t = 300;
    const seconds = t / 1000;
    const vel = ballVelocity(baseLaunch, t);
    expect(vel.x).toBe(baseLaunch.velocity.x);
    expect(vel.z).toBe(baseLaunch.velocity.z);
    expect(vel.y).toBeCloseTo(baseLaunch.velocity.y - baseLaunch.gravity * seconds, 9);
  });

  it('produces a sweep of identical positions across two independent evaluators', () => {
    const times = Array.from({ length: 50 }, (_, i) => i * 20);
    const first = times.map((t) => ballPosition(baseLaunch, t));
    const second = times.map((t) => ballPosition(baseLaunch, t));
    expect(first).toEqual(second);
  });
});

describe('firstEvent (ground/net/out landing detection)', () => {
  it('detects ground contact when the ball falls straight down', () => {
    const launch: BallLaunch = {
      ...baseLaunch,
      origin: { x: 0, y: 2, z: -5 },
      velocity: { x: 0, y: 0, z: 0 },
    };
    const event = firstEvent(launch, 5_000);
    expect(event.kind).toBe('ground');
    expect(event.pos.y).toBeLessThanOrEqual(BALL_RADIUS);
    // sanity: free fall from y=2 to y=BALL_RADIUS takes ~ sqrt(2*(2-r)/g) seconds
    const expectedSeconds = Math.sqrt((2 * (2 - BALL_RADIUS)) / GRAVITY);
    expect(event.atMs / 1000).toBeCloseTo(expectedSeconds, 1);
  });

  it('detects an out-of-bounds landing beyond the court edges', () => {
    const launch: BallLaunch = {
      ...baseLaunch,
      origin: { x: 0, y: 1, z: -8 },
      velocity: { x: 20, y: 3, z: 30 }, // will land far outside x/z bounds
    };
    const event = firstEvent(launch, 5_000);
    expect(event.kind).toBe('out');
  });

  it('detects a net crossing below NET_HEIGHT within the court width', () => {
    const launch: BallLaunch = {
      ...baseLaunch,
      origin: { x: 0, y: 0.5, z: -1 },
      velocity: { x: 0, y: 0, z: 4 }, // crosses z=0 quickly, low and slow
    };
    const event = firstEvent(launch, 2_000);
    expect(event.kind).toBe('net');
    expect(event.pos.y).toBeLessThan(NET_HEIGHT);
  });

  it('reports "none" when no event occurs within maxMs', () => {
    const launch: BallLaunch = {
      ...baseLaunch,
      origin: { x: 0, y: 100, z: -8 },
      velocity: { x: 0, y: 0, z: 0 },
    };
    const event = firstEvent(launch, 10); // far too short to fall anywhere
    expect(event.kind).toBe('none');
  });

  it('yields a bit-identical event time across repeated scans (deterministic fixed step)', () => {
    const launch: BallLaunch = {
      ...baseLaunch,
      origin: { x: 0, y: 3, z: -3 },
      velocity: { x: 1, y: 2, z: 3 },
    };
    const first = firstEvent(launch, 5_000);
    const second = firstEvent(launch, 5_000);
    expect(first).toEqual(second);
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
    };
    expect(buildBallLaunch(args)).toEqual(buildBallLaunch(args));
  });

  it('scales speed upward with charge (chargeDistanceMult)', () => {
    const base = {
      origin: { x: 0, y: 1, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      baseSpeed: 10,
      arcType: 'spike' as const,
      quality: 1,
      serverTime: 0,
      rngSeed: 1,
    };
    const noCharge = buildBallLaunch({ ...base, charge: 0 });
    const fullCharge = buildBallLaunch({ ...base, charge: 1 });
    const noChargeSpeed = Math.hypot(noCharge.velocity.x, noCharge.velocity.z);
    const fullChargeSpeed = Math.hypot(fullCharge.velocity.x, fullCharge.velocity.z);
    expect(fullChargeSpeed).toBeGreaterThan(noChargeSpeed);
    expect(fullChargeSpeed / noChargeSpeed).toBeCloseTo(1.6, 2);
  });

  it('carries gravity, serverTime, and quality through to the packet', () => {
    const launch = buildBallLaunch({
      origin: { x: 1, y: 2, z: 3 },
      direction: { x: 0, y: 1, z: 0 },
      baseSpeed: 5,
      arcType: 'dig',
      quality: 0.42,
      charge: 0,
      serverTime: 12_345,
      rngSeed: 9,
    });
    expect(launch.gravity).toBe(GRAVITY);
    expect(launch.serverTime).toBe(12_345);
    expect(launch.quality).toBeCloseTo(0.42, 9);
    expect(launch.origin).toEqual({ x: 1, y: 2, z: 3 });
  });
});
