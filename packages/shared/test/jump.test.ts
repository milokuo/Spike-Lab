import { describe, expect, it } from 'vitest';
import {
  isLanded,
  JUMP_BOOST_MAX_S,
  JUMP_GRAVITY,
  JUMP_STAMINA_HOLD_PER_S,
  JUMP_V0,
  jumpHoldStaminaCost,
  startJump,
  stepJump,
  type JumpState,
} from '../src/index';

const DT = 1 / 60;

function apexOf(held: boolean): { maxY: number; landedAt: JumpState } {
  let state = startJump();
  let maxY = state.y;
  for (let i = 0; i < 600; i++) {
    state = stepJump(state, DT, held);
    maxY = Math.max(maxY, state.y);
    if (isLanded(state)) break;
  }
  return { maxY, landedAt: state };
}

describe('startJump (§1.3: press-to-jump)', () => {
  it('launches instantly at JUMP_V0 from the ground with zero airborne time', () => {
    const state = startJump();
    expect(state).toEqual({ y: 0, vy: JUMP_V0, airborneS: 0 });
  });
});

describe('stepJump (§1.1/§1.3: variable jump, boost window, gravity rules)', () => {
  it('is deterministic: identical inputs produce an identical JumpState', () => {
    const state: JumpState = { y: 0.3, vy: 1.5, airborneS: 0.1 };
    const a = stepJump(state, DT, true);
    const b = stepJump(state, DT, true);
    expect(a).toEqual(b);
  });

  it('never returns a negative height', () => {
    const falling: JumpState = { y: 0.01, vy: -5, airborneS: 1 };
    const next = stepJump(falling, 0.1, false);
    expect(next.y).toBeGreaterThanOrEqual(0);
  });

  it('advances airborneS by dt every step regardless of held', () => {
    const state = startJump();
    const next = stepJump(state, DT, false);
    expect(next.airborneS).toBeCloseTo(DT, 9);
  });

  it('applies reduced gravity (JUMP_HOLD_GRAVITY_MULT) while rising, held, and within the boost window', () => {
    const state = startJump();
    const boosted = stepJump(state, DT, true);
    const unboosted = stepJump(state, DT, false);
    // Held: vy decays slower (less negative delta) than unheld under full gravity.
    expect(boosted.vy).toBeGreaterThan(unboosted.vy);
    expect(boosted.y).toBeGreaterThan(unboosted.y);
  });

  it('reverts to full JUMP_GRAVITY once the boost window (JUMP_BOOST_MAX_S) has elapsed, even while still held', () => {
    // Fast-forward state to just past the boost window while still rising.
    const atWindowEdge: JumpState = { y: 0.5, vy: 2, airborneS: JUMP_BOOST_MAX_S + 0.001 };
    const heldPastWindow = stepJump(atWindowEdge, DT, true);
    const neverHeld = stepJump(atWindowEdge, DT, false);
    expect(heldPastWindow).toEqual(neverHeld);
  });

  it('reverts to full gravity once falling, even if still held (boost only applies while rising)', () => {
    const falling: JumpState = { y: 0.5, vy: -1, airborneS: 0.05 };
    const heldWhileFalling = stepJump(falling, DT, true);
    const notHeld = stepJump(falling, DT, false);
    expect(heldWhileFalling).toEqual(notHeld);
  });
});

describe('tap vs full-hold apex (§5 WP1 acceptance)', () => {
  it('a tap (release immediately) produces a smaller apex than a full hold', () => {
    const tap = apexOf(false);
    const fullHold = apexOf(true);
    expect(fullHold.maxY).toBeGreaterThan(tap.maxY);
  });

  it('apex height is monotonically non-decreasing as more of the rise is held', () => {
    // Simulate holding for an increasing number of ticks at the start of the
    // jump, then releasing for the remainder of the rise.
    function apexHoldingFor(heldTicks: number): number {
      let state = startJump();
      let maxY = state.y;
      let tick = 0;
      while (!isLanded(state) && tick < 600) {
        const held = tick < heldTicks;
        state = stepJump(state, DT, held);
        maxY = Math.max(maxY, state.y);
        tick++;
      }
      return maxY;
    }
    const ticks = [0, 2, 5, 10, 20, 40];
    const apexes = ticks.map(apexHoldingFor);
    for (let i = 1; i < apexes.length; i++) {
      expect(apexes[i]).toBeGreaterThanOrEqual(apexes[i - 1] - 1e-9);
    }
  });

  it('apex is capped: bounded strictly below the idealized "boost forever" height', () => {
    const fullHold = apexOf(true);
    const tap = apexOf(false);
    // If boosted gravity applied for the whole rise (ignoring the boost
    // window), apex would be v0^2 / (2 * g * mult) — strictly above what the
    // capped, window-limited boost can actually reach.
    const idealizedUncappedApex = (JUMP_V0 * JUMP_V0) / (2 * JUMP_GRAVITY * 0.45);
    expect(fullHold.maxY).toBeLessThan(idealizedUncappedApex);
    expect(fullHold.maxY).toBeGreaterThan(tap.maxY);
  });

  it('boost after the window has already fully expired has no effect on apex vs not holding at all', () => {
    // Start already past the boost window, still rising: held vs not-held from
    // here on should trace identically.
    const start: JumpState = { y: 0.3, vy: 1, airborneS: JUMP_BOOST_MAX_S + 0.5 };
    let heldState = start;
    let unheldState = start;
    for (let i = 0; i < 60 && !isLanded(heldState); i++) {
      heldState = stepJump(heldState, DT, true);
      unheldState = stepJump(unheldState, DT, false);
    }
    expect(heldState).toEqual(unheldState);
  });
});

describe('isLanded (§1.1: y<=0 and vy<0)', () => {
  it('is false at the launch instant even though y=0 (still airborne, moving up)', () => {
    expect(isLanded(startJump())).toBe(false);
  });

  it('is false mid-air (y>0)', () => {
    expect(isLanded({ y: 0.5, vy: -2, airborneS: 0.3 })).toBe(false);
  });

  it('is true once y<=0 while moving downward', () => {
    expect(isLanded({ y: 0, vy: -0.01, airborneS: 0.5 })).toBe(true);
  });

  it('detects landing from a full simulated jump', () => {
    const { landedAt } = apexOf(true);
    expect(isLanded(landedAt)).toBe(true);
    expect(landedAt.y).toBe(0);
  });
});

describe('jumpHoldStaminaCost (§1.2: JUMP_STAMINA_HOLD_PER_S per second while boosting)', () => {
  it('is zero when not boosting', () => {
    expect(jumpHoldStaminaCost(1, false)).toBe(0);
  });

  it('scales linearly with dt while boosting', () => {
    expect(jumpHoldStaminaCost(1, true)).toBeCloseTo(JUMP_STAMINA_HOLD_PER_S, 9);
    expect(jumpHoldStaminaCost(0.5, true)).toBeCloseTo(JUMP_STAMINA_HOLD_PER_S * 0.5, 9);
  });

  it('costs at most ~3 stamina across the full boost window', () => {
    const maxCost = jumpHoldStaminaCost(JUMP_BOOST_MAX_S, true);
    expect(maxCost).toBeCloseTo(3, 0);
  });
});

describe('jump determinism end-to-end (server sim vs client prediction share this module)', () => {
  it('two independent simulations with the same held-input trace produce identical trajectories', () => {
    function simulate(held: boolean): JumpState[] {
      let state = startJump();
      const trace: JumpState[] = [state];
      for (let i = 0; i < 60; i++) {
        state = stepJump(state, DT, held);
        trace.push(state);
      }
      return trace;
    }
    expect(simulate(true)).toEqual(simulate(true));
    expect(simulate(false)).toEqual(simulate(false));
  });
});
