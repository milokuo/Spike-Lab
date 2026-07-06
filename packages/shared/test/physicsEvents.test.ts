// M3.0a WP-P0 §2/§3 — firstFlightEvent edge cases: ground/out/net classification,
// the grazing-net-top boundary, near-zero-vy landing, out-vs-ground priority, the
// net-vs-landing "earliest wins" rule, and determinism. Bounds are passed in (P0
// imports no court constants); we use the real court dimensions as literals here.
import { describe, expect, it } from 'vitest';
import { firstFlightEvent, type FlightBounds } from '../src/physics/events';
import { DEFAULT_FLIGHT_PARAMS, type FlightLaunch, type FlightParams } from '../src/physics/flight';

const BOUNDS: FlightBounds = {
  groundY: 0.15, // BALL_RADIUS
  netZ: 0,
  netHalfWidth: 4.5, // COURT_WIDTH / 2
  netTop: 2.43, // NET_HEIGHT
  courtHalfWidth: 4.5,
  courtHalfLength: 9, // COURT_LEN / 2
  horizonMs: 8000,
};
const NO_DRAG: FlightParams = { ...DEFAULT_FLIGHT_PARAMS, drag: () => 0 };
const launch = (origin: FlightLaunch['origin'], velocity: FlightLaunch['velocity']): FlightLaunch => ({
  origin,
  velocity,
  omega: { x: 0, y: 0, z: 0 },
  startMs: 1000,
});

describe('firstFlightEvent — ground / out / net', () => {
  it('detects an in-court ground landing (straight drop)', () => {
    const ev = firstFlightEvent(launch({ x: 0, y: 3, z: -4 }, { x: 0, y: 0, z: 0 }), BOUNDS);
    expect(ev?.type).toBe('ground');
    expect(ev?.pos.y).toBeCloseTo(BOUNDS.groundY, 3);
    expect(ev?.pos.z).toBeCloseTo(-4, 2);
    expect(ev!.tMs).toBeGreaterThan(1000);
  });

  it('classifies a landing beyond the sideline as out', () => {
    const ev = firstFlightEvent(launch({ x: 0, y: 1.5, z: -4 }, { x: 18, y: 5, z: 1 }), BOUNDS);
    expect(ev?.type).toBe('out');
    expect(Math.abs(ev!.pos.x)).toBeGreaterThan(BOUNDS.courtHalfWidth);
  });

  it('detects a net contact below the tape, inside the antennae', () => {
    const ev = firstFlightEvent(launch({ x: 0, y: 0.5, z: -1 }, { x: 0, y: 0, z: 4 }), BOUNDS);
    expect(ev?.type).toBe('net');
    expect(ev?.pos.z).toBeCloseTo(0, 6);
    expect(ev!.pos.y).toBeLessThan(BOUNDS.netTop);
    expect(ev!.pos.y).toBeGreaterThan(0);
  });

  it('a ball that clears the net top is NOT a net event (lands on the far side)', () => {
    const ev = firstFlightEvent(launch({ x: 0, y: 2, z: -1 }, { x: 0, y: 6, z: 4 }), BOUNDS);
    expect(ev?.type).toBe('ground');
    expect(ev!.pos.z).toBeGreaterThan(0); // far side
  });
});

describe('firstFlightEvent — grazing the net top (擦網頂 boundary)', () => {
  // Same z-crossing time (t≈0.25s, vz=4); only the crossing height differs.
  it('crossing just UNDER netTop is a net contact', () => {
    const ev = firstFlightEvent(launch({ x: 0, y: 2.706, z: -1 }, { x: 0, y: 0, z: 4 }), BOUNDS);
    expect(ev?.type).toBe('net');
    expect(ev!.pos.y).toBeLessThan(BOUNDS.netTop);
    expect(ev!.pos.y).toBeGreaterThan(2.3);
  });

  it('crossing just OVER netTop clears (far-side ground, not net)', () => {
    const ev = firstFlightEvent(launch({ x: 0, y: 2.9, z: -1 }, { x: 0, y: 0, z: 4 }), BOUNDS);
    expect(ev?.type).not.toBe('net');
    expect(ev?.type).toBe('ground');
    expect(ev!.pos.z).toBeGreaterThan(0);
  });
});

describe('firstFlightEvent — near-zero vertical velocity landing', () => {
  it('still detects a soft, low-speed descent onto the floor', () => {
    // Starts just above the floor with no vertical velocity → lands with small vy.
    const ev = firstFlightEvent(launch({ x: 0, y: 0.2, z: -3 }, { x: 0, y: 0, z: 0 }), BOUNDS);
    expect(ev?.type).toBe('ground');
    expect(ev?.pos.y).toBeCloseTo(BOUNDS.groundY, 4);
    expect(Math.abs(ev!.vel.y)).toBeLessThan(1.2); // genuinely low vertical speed at contact
  });
});

describe('firstFlightEvent — priority (adjudicated)', () => {
  it('ground BEFORE the net wins: a ball dying on its own side reports ground, not net', () => {
    // Lands (own half) at t≈0.82s; would not reach z=0 until t≈2.5s.
    const ev = firstFlightEvent(launch({ x: 0, y: 1, z: -5 }, { x: 0, y: 3, z: 2 }), BOUNDS);
    expect(ev?.type).toBe('ground');
    expect(ev!.pos.z).toBeLessThan(0); // died before the net
  });

  it('a line-ball landing inside the baseline is ground; just beyond is out', () => {
    // Drag-free so the landing point is predictable; both clear the net.
    const inside = firstFlightEvent(launch({ x: 0, y: 2, z: -1 }, { x: 0, y: 7, z: 5.9 }), BOUNDS, NO_DRAG);
    const beyond = firstFlightEvent(launch({ x: 0, y: 2, z: -1 }, { x: 0, y: 7, z: 6.5 }), BOUNDS, NO_DRAG);
    expect(inside?.type).toBe('ground');
    expect(inside!.pos.z).toBeLessThanOrEqual(BOUNDS.courtHalfLength);
    expect(beyond?.type).toBe('out');
    expect(beyond!.pos.z).toBeGreaterThan(BOUNDS.courtHalfLength);
  });
});

describe('firstFlightEvent — determinism & horizon', () => {
  it('is bit-identical across repeated calls', () => {
    const l = launch({ x: 1, y: 3, z: -3 }, { x: 1, y: 2, z: 3 });
    expect(firstFlightEvent(l, BOUNDS)).toEqual(firstFlightEvent(l, BOUNDS));
  });

  it('returns null when no event happens within the horizon', () => {
    const ev = firstFlightEvent(launch({ x: 0, y: 100, z: 0 }, { x: 0, y: 0, z: 0 }), {
      ...BOUNDS,
      horizonMs: 10,
    });
    expect(ev).toBeNull();
  });
});
