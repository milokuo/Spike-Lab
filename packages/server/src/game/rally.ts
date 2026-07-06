// Rally bookkeeping (spec §5 touch rules, §9 death adjudication + serve rotation).
// Pure/stateless helpers plus a small mutable-by-replacement RallyTracker for
// touch counting. All state transitions return new objects (no in-place edits).
import { type Side, type Vec3, type DeathCause, type TouchRejection } from '@spike/shared';

export const MAX_TOUCHES_PER_SIDE = 3; // spec §5: max 3 per side before crossing

const opposite = (side: Side): Side => (side === 'A' ? 'B' : 'A');

// Which half a landing point belongs to. A owns z<0, B owns z>0 (spec §3).
const sideOfHalf = (pos: Vec3): Side => (pos.z < 0 ? 'A' : 'B');

export interface TouchLegality {
  legal: boolean;
  reason: 'ok' | 'tooManyTouches';
}

// M2.7 §2 — richer legality that distinguishes the two rejection causes and
// enforces the no-double-touch rule (same player as their team's previous
// contact). Returns the wire `TouchRejection` so the sim/room can feed it
// straight into the TouchResult. Unlike checkTouch this needs the toucher id.
export interface TouchClassification {
  legal: boolean;
  rejection?: TouchRejection;
}

export function classifyTouch(
  state: Readonly<RallyTouchState>,
  side: Side,
  toucherId: string,
): TouchClassification {
  const sameSide = state.attackingSide === side;
  // Same player who made their team's previous touch => illegal double contact.
  if (sameSide && state.lastToucherId === toucherId) {
    return { legal: false, rejection: 'illegal_double' };
  }
  const nextCount = sameSide ? state.touchesThisSide + 1 : 1;
  if (nextCount > MAX_TOUCHES_PER_SIDE) {
    return { legal: false, rejection: 'illegal_count' };
  }
  return { legal: true };
}

// Immutable touch-count snapshot for the side currently attacking. In 1v1 the
// no-double-touch rule is relaxed to the documented self-set fallback (plan
// §2.6): one player may chain dig->set->spike, so only the 3-touch cap is
// enforced here, and it resets whenever the ball crosses the net.
export interface RallyTouchState {
  attackingSide: Side | null; // side that last legally contacted the ball
  touchesThisSide: number; // contacts since the ball entered this half
  lastToucherId: string | null;
}

export const initialTouchState = (): RallyTouchState => ({
  attackingSide: null,
  touchesThisSide: 0,
  lastToucherId: null,
});

/** Check a would-be touch by `side` against the current count (no mutation). */
export function checkTouch(state: Readonly<RallyTouchState>, side: Side): TouchLegality {
  const sameSide = state.attackingSide === side;
  const nextCount = sameSide ? state.touchesThisSide + 1 : 1;
  if (nextCount > MAX_TOUCHES_PER_SIDE) {
    return { legal: false, reason: 'tooManyTouches' };
  }
  return { legal: true, reason: 'ok' };
}

/** Register a legal touch, returning the NEW touch state. */
export function registerTouch(
  state: Readonly<RallyTouchState>,
  side: Side,
  toucherId: string,
): RallyTouchState {
  const sameSide = state.attackingSide === side;
  return {
    attackingSide: side,
    touchesThisSide: sameSide ? state.touchesThisSide + 1 : 1,
    lastToucherId: toucherId,
  };
}

/** Reset the count when the ball crosses to the other half. */
export function crossNet(state: Readonly<RallyTouchState>, newAttacking: Side): RallyTouchState {
  return { attackingSide: newAttacking, touchesThisSide: 0, lastToucherId: state.lastToucherId };
}

export interface DeathResolution {
  scoringSide: Side;
  landing: Vec3;
}

// Map a death cause + the last hitter to who scores (spec §9). M2.7 §1/§2: net
// contact and illegal touches no longer end a rally, so only two causes remain:
//  - ground: whoever owns the half it landed in loses; the opponent scores.
//  - out:    the last hitter's side sent it out, so they lose.
export function resolveDeath(
  cause: DeathCause,
  landing: Vec3,
  lastHitterSide: Side,
): DeathResolution {
  if (cause === 'ground') {
    return { scoringSide: opposite(sideOfHalf(landing)), landing };
  }
  // out -> the side that last touched it is at fault.
  return { scoringSide: opposite(lastHitterSide), landing };
}

/** Which side a ball position is heading into once past the net plane. */
export function attackingSideForBall(pos: Vec3): Side {
  return sideOfHalf(pos);
}
