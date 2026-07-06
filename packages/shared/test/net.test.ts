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

// A low, slow ball on side A (z<0) heading straight at the net at z=0.
const towardNet = (overrides: Partial<BallLaunch> = {}): BallLaunch => ({
  origin: { x: 0, y: 1, z: -1 },
  velocity: { x: 0, y: 0, z: 4 },
  arcType: 'spike',
  quality: 1,
  gravity: GRAVITY,
  serverTime: 1_000,
  rngSeed: 1,
  ...overrides,
});

describe('net contact-time solving (§1)', () => {
  it('solves the z=0 crossing exactly (t = -z0/vz), independent of gravity', () => {
    // z0=-1, vz=4 -> t = 0.25s = 250ms. y stays in the face band.
    const launch = towardNet();
    const ev = firstEvent(launch, 2_000);
    expect(ev.kind).toBe('net');
    expect(ev.atMs).toBeCloseTo(250, 6);
    expect(ev.pos.z).toBeCloseTo(0, 9); // exactly on the plane
  });

  it('reports the contact at the closed-form parabola height at that instant', () => {
    const launch = towardNet({ origin: { x: 0, y: 2, z: -2 }, velocity: { x: 0, y: 1, z: 4 } });
    const ev = firstEvent(launch, 2_000);
    const t = ev.atMs / 1000;
    const expectedY = 2 + 1 * t - 0.5 * GRAVITY * t * t;
    expect(ev.pos.y).toBeCloseTo(expectedY, 9);
  });

  it('is a MISS when the ball clears the tape (y > NET_TOP): no net event', () => {
    // High, fast lob that is well above the net when it reaches z=0.
    const launch = towardNet({ origin: { x: 0, y: 3, z: -1 }, velocity: { x: 0, y: 2, z: 6 } });
    const ev = firstEvent(launch, 5_000);
    expect(ev.kind).not.toBe('net');
  });

  it('is a MISS when the crossing is outside the antennae (|x| > half width)', () => {
    const launch = towardNet({ origin: { x: 0, y: 1, z: -1 }, velocity: { x: 40, y: 0, z: 4 } });
    // At t=0.25s, x = 10 (>4.5) -> passes wide of the net.
    const ev = firstEvent(launch, 5_000);
    expect(ev.kind).not.toBe('net');
  });

  // Finding #4 — a ball that grounds a hair BEFORE it reaches the net plane must
  // report 'ground', not 'net', even when both collapse onto the same 4ms grid
  // step. Here the exact ground time is ~98.97ms and the z=0 crossing is at 100ms
  // (its y ~0.149 is still in-band, so the naive scan would have reported net).
  it('reports ground (not net) when landing precedes the net crossing within a grid step', () => {
    const launch = towardNet({ origin: { x: 0, y: 0.198, z: -0.5 }, velocity: { x: 0, y: 0, z: 5 } });
    const ev = firstEvent(launch, 2_000);
    expect(ev.kind).toBe('ground'); // was 'net' before finding #4's fix
    expect(ev.atMs).toBeLessThanOrEqual(100); // detected at/before the 100ms net crossing step
  });
});

describe('resolveNetCollision zones (§1)', () => {
  it('TAPE zone (top 0.15u): damps all components ×0.5, drags vy down, passes over', () => {
    const contact = { x: 0.2, y: NET_TOP - NET_TAPE_H / 2, z: 0 }; // inside the tape band
    const incoming = { x: 2, y: 1, z: 5 };
    const r = resolveNetCollision(contact, incoming);
    expect(r.zone).toBe('tape');
    expect(r.velocity.x).toBeCloseTo(2 * NET_TAPE_DAMP, 9);
    expect(r.velocity.y).toBeCloseTo(1 * NET_TAPE_DAMP - NET_TAPE_VY_DROP, 9);
    expect(r.velocity.z).toBeCloseTo(5 * NET_TAPE_DAMP, 9);
    // z keeps its incoming sign => the ball continues over to the far side.
    expect(Math.sign(r.velocity.z)).toBe(Math.sign(incoming.z));
    // nudged off the plane on the outgoing (far) side.
    expect(r.origin.z).toBeCloseTo(NET_CONTACT_EPS, 9);
  });

  it('FACE zone (below the tape): reverses vz ×0.15, halves vx, keeps vy', () => {
    const contact = { x: -0.5, y: 1.0, z: 0 };
    const incoming = { x: 3, y: -2, z: 6 };
    const r = resolveNetCollision(contact, incoming);
    expect(r.zone).toBe('face');
    expect(r.velocity.x).toBeCloseTo(3 * NET_FACE_HORIZ_DAMP, 9);
    expect(r.velocity.y).toBeCloseTo(-2, 9); // unchanged (gravity keeps acting)
    expect(r.velocity.z).toBeCloseTo(-6 * NET_RESTITUTION, 9);
    // z reverses => the ball rebounds toward the hitter's (incoming) side.
    expect(Math.sign(r.velocity.z)).toBe(-Math.sign(incoming.z));
    // nudged onto the incoming side (outgoing z is now negative).
    expect(r.origin.z).toBeCloseTo(-NET_CONTACT_EPS, 9);
  });

  it('the tape boundary (exactly NET_TOP - NET_TAPE_H) is treated as tape', () => {
    const contact = { x: 0, y: NET_TOP - NET_TAPE_H, z: 0 };
    expect(resolveNetCollision(contact, { x: 0, y: 0, z: 3 }).zone).toBe('tape');
  });

  // Finding #5 — NET_MIN_REBOUND_SPEED is now applied on the FACE zone.
  it('floors a weak face rebound at NET_MIN_REBOUND_SPEED, pointed at the hitter', () => {
    // Incoming vz=0.1 (from side A, z<0) => raw rebound vz = -0.015, |.| < 0.5.
    const contact = { x: 0, y: 1.0, z: 0 };
    const r = resolveNetCollision(contact, { x: 0, y: -1, z: 0.1 });
    expect(r.zone).toBe('face');
    // Reversed toward the hitter (negative) and floored to the min separation.
    expect(r.velocity.z).toBeCloseTo(-NET_MIN_REBOUND_SPEED, 9);
    // Origin nudged onto the incoming (hitter's) side so gravity drops it there.
    expect(r.origin.z).toBeCloseTo(-NET_CONTACT_EPS, 9);
  });

  it('leaves a strong face rebound (|vz| >= NET_MIN_REBOUND_SPEED) untouched', () => {
    const r = resolveNetCollision({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 6 });
    // -6 * 0.15 = -0.9, already above the floor => exact restitution kept.
    expect(r.velocity.z).toBeCloseTo(-6 * NET_RESTITUTION, 9);
  });
});

describe('anti-jitter: a rebound cannot re-collide with itself', () => {
  // Build the resolved launch the server would install and prove firstEvent on it
  // does NOT report an immediate net contact (origin nudged off the plane; z-vel
  // reversed & constant => moves monotonically away from z=0).
  const reboundLaunch = (contactPos: { x: number; y: number; z: number }, incoming: { x: number; y: number; z: number }): BallLaunch => {
    const r = resolveNetCollision(contactPos, incoming);
    return { origin: r.origin, velocity: r.velocity, arcType: 'spike', quality: 1, gravity: GRAVITY, serverTime: 0, rngSeed: 1, isNetTouch: true };
  };

  it('face rebound: next event is a ground/out landing, never another net at t≈0', () => {
    const next = reboundLaunch({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 5 });
    const ev = firstEvent(next, 5_000);
    expect(ev.kind).not.toBe('net');
    expect(['ground', 'out']).toContain(ev.kind);
  });

  it('a near-resting contact (tiny incoming z) still nudges to the incoming side and falls', () => {
    const next = reboundLaunch({ x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0.01 });
    expect(next.origin.z).toBeLessThan(0); // incoming side (came from z<0)
    const ev = firstEvent(next, 5_000);
    expect(ev.kind).not.toBe('net');
  });
});

describe('chained net contacts (time series)', () => {
  it('a face rebound off a full trajectory produces a monotonically later, non-net-looping series', () => {
    // First launch crosses the net face; resolve at the exact contact, install the
    // rebound, and confirm the rebound's own first event is NOT another net contact
    // (so a chain terminates in a ground/out, never an infinite net loop).
    const first = towardNet({ origin: { x: 0, y: 0.8, z: -1.5 }, velocity: { x: 0, y: 1, z: 5 } });
    const e1 = firstEvent(first, 5_000);
    expect(e1.kind).toBe('net');

    const contactVel = ballVelocity(first, e1.atMs);
    const r = resolveNetCollision(e1.pos, contactVel);
    const second: BallLaunch = { ...first, origin: r.origin, velocity: r.velocity, serverTime: first.serverTime + e1.atMs, isNetTouch: true };
    const e2 = firstEvent(second, 5_000);

    expect(e2.kind).not.toBe('net');
    // The rebound landing time is strictly after the contact time (real time flows forward).
    expect(second.serverTime + e2.atMs).toBeGreaterThan(first.serverTime + e1.atMs);
    // The rebound lands on the incoming side (z<0) — the hitter's own half.
    const landing = ballPosition(second, e2.atMs);
    expect(landing.z).toBeLessThan(HALF_WIDTH); // sanity: within the world
    expect(landing.z).toBeLessThanOrEqual(0);
  });
});
