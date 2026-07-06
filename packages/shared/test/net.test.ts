// M2.7 §1 net soft-collision + M3.0a §8 flight-backed event detection. The pure
// resolveNetCollision zone maths are UNCHANGED (kept verbatim). The firstEvent
// portions now run over the drag/Magnus flight model, so the crossing TIME is no
// longer the closed-form t = -z0/vz — it shifts a couple ms and is asserted with a
// tolerance. The cross-rebound history rules (the blood-lesson zone) stay intact.
import { describe, expect, it } from 'vitest';
import {
  ballPosition,
  ballVelocity,
  firstEvent,
  resolveNetCollision,
  GRAVITY,
  NET_TOP,
  NET_TAPE_H,
  NET_TAPE_DAMP,
  NET_TAPE_VY_DROP,
  NET_RESTITUTION,
  NET_FACE_HORIZ_DAMP,
  NET_MIN_REBOUND_SPEED,
  NET_CONTACT_EPS,
  COURT_WIDTH,
  type BallLaunch,
} from '../src/index';

const HALF_WIDTH = COURT_WIDTH / 2;

// A low, slow ball on side A (z<0) heading straight at the net at z=0. Spin-free.
const towardNet = (overrides: Partial<BallLaunch> = {}): BallLaunch => ({
  origin: { x: 0, y: 1, z: -1 },
  velocity: { x: 0, y: 0, z: 4 },
  omega: { x: 0, y: 0, z: 0 },
  arcType: 'spike',
  quality: 1,
  gravity: GRAVITY,
  serverTime: 1_000,
  rngSeed: 1,
  ...overrides,
});

describe('net contact detection over the flight model (§1)', () => {
  it('crosses z=0 near the ballistic time (t≈250ms), landing exactly on the plane', () => {
    // z0=-1, vz=4 -> drag-free t=250ms; drag shifts it a couple ms later.
    const ev = firstEvent(towardNet(), 2_000);
    expect(ev.kind).toBe('net');
    expect(ev.pos.z).toBeCloseTo(0, 6); // bisected exactly onto the plane
    expect(ev.atMs).toBeGreaterThan(248);
    expect(ev.atMs).toBeLessThan(260);
  });

  it("the event's height matches the trajectory sample at that instant", () => {
    const launch = towardNet({ origin: { x: 0, y: 2, z: -2 }, velocity: { x: 0, y: 1, z: 4 } });
    const ev = firstEvent(launch, 2_000);
    expect(ev.pos.y).toBeCloseTo(ballPosition(launch, ev.atMs).y, 6);
    expect(ev.kind).toBe('net');
  });

  it('is a MISS when the ball clears the tape (y > NET_TOP): no net event', () => {
    const launch = towardNet({ origin: { x: 0, y: 3, z: -1 }, velocity: { x: 0, y: 2, z: 6 } });
    expect(firstEvent(launch, 5_000).kind).not.toBe('net');
  });

  it('is a MISS when the crossing is outside the antennae (|x| > half width)', () => {
    const launch = towardNet({ origin: { x: 0, y: 1, z: -1 }, velocity: { x: 40, y: 0, z: 4 } });
    expect(firstEvent(launch, 5_000).kind).not.toBe('net');
  });

  // Ground-before-net priority still holds under drag: a ball grounding a hair
  // before it reaches the net plane reports 'ground', not 'net'.
  it('reports ground (not net) when landing precedes the net crossing', () => {
    // Ground time ~99ms just before the z=0 crossing ~100ms; drag widens the gap.
    const launch = towardNet({ origin: { x: 0, y: 0.198, z: -0.5 }, velocity: { x: 0, y: 0, z: 5 } });
    const ev = firstEvent(launch, 2_000);
    expect(ev.kind).toBe('ground');
    expect(ev.pos.z).toBeLessThan(0); // died before the net plane
  });
});

describe('resolveNetCollision zones (§1) — pure, unchanged by drag', () => {
  it('TAPE zone (top 0.15u): damps all components ×0.5, drags vy down, passes over', () => {
    const contact = { x: 0.2, y: NET_TOP - NET_TAPE_H / 2, z: 0 };
    const incoming = { x: 2, y: 1, z: 5 };
    const r = resolveNetCollision(contact, incoming);
    expect(r.zone).toBe('tape');
    expect(r.velocity.x).toBeCloseTo(2 * NET_TAPE_DAMP, 9);
    expect(r.velocity.y).toBeCloseTo(1 * NET_TAPE_DAMP - NET_TAPE_VY_DROP, 9);
    expect(r.velocity.z).toBeCloseTo(5 * NET_TAPE_DAMP, 9);
    expect(Math.sign(r.velocity.z)).toBe(Math.sign(incoming.z));
    expect(r.origin.z).toBeCloseTo(NET_CONTACT_EPS, 9);
  });

  it('FACE zone (below the tape): reverses vz ×0.15, halves vx, keeps vy', () => {
    const contact = { x: -0.5, y: 1.0, z: 0 };
    const incoming = { x: 3, y: -2, z: 6 };
    const r = resolveNetCollision(contact, incoming);
    expect(r.zone).toBe('face');
    expect(r.velocity.x).toBeCloseTo(3 * NET_FACE_HORIZ_DAMP, 9);
    expect(r.velocity.y).toBeCloseTo(-2, 9);
    expect(r.velocity.z).toBeCloseTo(-6 * NET_RESTITUTION, 9);
    expect(Math.sign(r.velocity.z)).toBe(-Math.sign(incoming.z));
    expect(r.origin.z).toBeCloseTo(-NET_CONTACT_EPS, 9);
  });

  it('the tape boundary (exactly NET_TOP - NET_TAPE_H) is treated as tape', () => {
    const contact = { x: 0, y: NET_TOP - NET_TAPE_H, z: 0 };
    expect(resolveNetCollision(contact, { x: 0, y: 0, z: 3 }).zone).toBe('tape');
  });

  it('floors a weak face rebound at NET_MIN_REBOUND_SPEED, pointed at the hitter', () => {
    const r = resolveNetCollision({ x: 0, y: 1.0, z: 0 }, { x: 0, y: -1, z: 0.1 });
    expect(r.zone).toBe('face');
    expect(r.velocity.z).toBeCloseTo(-NET_MIN_REBOUND_SPEED, 9);
    expect(r.origin.z).toBeCloseTo(-NET_CONTACT_EPS, 9);
  });

  it('leaves a strong face rebound (|vz| >= NET_MIN_REBOUND_SPEED) untouched', () => {
    const r = resolveNetCollision({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 6 });
    expect(r.velocity.z).toBeCloseTo(-6 * NET_RESTITUTION, 9);
  });
});

describe('anti-jitter: a rebound cannot re-collide with itself', () => {
  const reboundLaunch = (contactPos: { x: number; y: number; z: number }, incoming: { x: number; y: number; z: number }): BallLaunch => {
    const r = resolveNetCollision(contactPos, incoming);
    return { origin: r.origin, velocity: r.velocity, omega: { x: 0, y: 0, z: 0 }, arcType: 'spike', quality: 1, gravity: GRAVITY, serverTime: 0, rngSeed: 1, isNetTouch: true };
  };

  it('face rebound: next event is a ground/out landing, never another net at t≈0', () => {
    const ev = firstEvent(reboundLaunch({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 5 }), 5_000);
    expect(ev.kind).not.toBe('net');
    expect(['ground', 'out']).toContain(ev.kind);
  });

  it('a near-resting contact (tiny incoming z) still nudges to the incoming side and falls', () => {
    const next = reboundLaunch({ x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0.01 });
    expect(next.origin.z).toBeLessThan(0);
    expect(firstEvent(next, 5_000).kind).not.toBe('net');
  });
});

describe('chained net contacts (time series)', () => {
  it('a face rebound off a full trajectory produces a monotonically later, non-net-looping series', () => {
    const first = towardNet({ origin: { x: 0, y: 0.8, z: -1.5 }, velocity: { x: 0, y: 1, z: 5 } });
    const e1 = firstEvent(first, 5_000);
    expect(e1.kind).toBe('net');

    const r = resolveNetCollision(e1.pos, e1.vel);
    const second: BallLaunch = { ...first, origin: r.origin, velocity: r.velocity, serverTime: first.serverTime + e1.atMs, isNetTouch: true };
    const e2 = firstEvent(second, 5_000);

    expect(e2.kind).not.toBe('net');
    expect(second.serverTime + e2.atMs).toBeGreaterThan(first.serverTime + e1.atMs);
    const landing = ballPosition(second, e2.atMs);
    expect(landing.z).toBeLessThan(HALF_WIDTH);
    expect(landing.z).toBeLessThanOrEqual(0);
  });
});
