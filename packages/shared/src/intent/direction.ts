import { COURT_LEN, COURT_WIDTH, DIG_BASE_SPEED, SET_BASE_SPEED, SPIKE_BASE_SPEED } from '../constants';
import { add, distXZ, scale, sub, type Vec3 } from '../math/vec3';
import type { Axis, TouchMode } from '../types/messages';
import type { Side } from '../types/state';
import { rightX, viewToWorld } from './viewSpace';

export interface IntentInput {
  mode: TouchMode;
  dirInput: { x: Axis; y: Axis };
  charge: number;
  toucherPos: Vec3;
  toucherSide: Side;
  // M2.1 §b.7/§5.1: positions of same-side OTHER players, for 2v2 dig
  // targeting. Empty/undefined in 1v1 — resolveDig then falls back to the
  // self-set behavior documented below.
  teammates?: Vec3[];
}

export interface IntentResult {
  direction: Vec3; // unit-ish desired horizontal+vertical launch direction
  arcType: 'dig' | 'set' | 'spike';
  baseSpeed: number; // pre-charge, pre-quality speed (from constants per arc)
}

// Own-half midpoint used as the aim target for L (spike) with no dirInput,
// and as the vertical loft anchor for J (dig) in the 1v1 fallback.
const COURT_CENTER_X = 0;

// §3: A = z<0 half, B = z>0 half. Opponent's baseline sits on the far edge
// of the opposing half; left/right baseline targets are picked in that
// opponent half at the court's X extremes (see constants COURT_WIDTH).
const HALF_WIDTH = COURT_WIDTH / 2;
const HALF_LENGTH = COURT_LEN / 2;

// §5.1 resolveIntent: (mode, dirInput, charge) -> intended launch direction + arc.
// charge is accepted for signature completeness (plan §2.6) but does not
// affect direction here — distance-only scaling happens in ballistics/launch.ts.
export function resolveIntent(input: IntentInput): IntentResult {
  const { mode, dirInput, toucherPos, toucherSide, teammates } = input;

  switch (mode) {
    case 'dig':
      return resolveDig(toucherPos, teammates);
    case 'set':
      return resolveSet(toucherSide, dirInput);
    case 'spike':
      return resolveSpike(toucherPos, toucherSide, dirInput);
    default: {
      const exhaustive: never = mode;
      throw new Error(`Unknown mode: ${String(exhaustive)}`);
    }
  }
}

// J — §5.1/§b.7: in 2v2, dig lofts the ball toward the nearest teammate
// (horizontal distance). In 1v1 (no teammates), falls back to the original
// self-set behavior: loft upward-and-inward on the toucher's own half,
// letting a single player chain dig->set->spike.
function resolveDig(toucherPos: Vec3, teammates?: Vec3[]): IntentResult {
  const target = nearestTeammate(toucherPos, teammates) ?? { x: COURT_CENTER_X, y: toucherPos.y, z: toucherPos.z };
  const towardTarget = sub(target, toucherPos);
  const direction = normalizeHorizontalPlusUp(towardTarget, 0.9);
  return { direction, arcType: 'dig', baseSpeed: DIG_BASE_SPEED };
}

// Nearest same-side teammate by horizontal (X-Z) distance, or undefined when
// there are no teammates (1v1) — caller applies the self-set fallback.
function nearestTeammate(toucherPos: Vec3, teammates?: Vec3[]): Vec3 | undefined {
  if (!teammates || teammates.length === 0) return undefined;
  return teammates.reduce((nearest, candidate) =>
    distXZ(candidate, toucherPos) < distXZ(nearest, toucherPos) ? candidate : nearest,
  );
}

// K — default: straight up. With dirInput: flies toward the pressed direction
// from the HITTER'S view (M2.1 direction fix) — dirInput is player-view-local
// (right = +x, toward-net = +y), transformed to world via viewToWorld so both
// sides set consistently relative to what the player sees.
function resolveSet(toucherSide: Side, dirInput: { x: Axis; y: Axis }): IntentResult {
  if (dirInput.x === 0 && dirInput.y === 0) {
    return { direction: { x: 0, y: 1, z: 0 }, arcType: 'set', baseSpeed: SET_BASE_SPEED };
  }
  const world = viewToWorld(dirInput, toucherSide);
  const horizontal = { x: world.x, y: 0, z: world.z };
  const direction = normalizeHorizontalPlusUp(horizontal, 0.9);
  return { direction, arcType: 'set', baseSpeed: SET_BASE_SPEED };
}

// L — default: opponent's court center. Left/right dirInput aims at a baseline
// corner in the opponent half — from the HITTER'S perspective (M2.1 direction
// fix): dirInput.x is player-view "right", mapped to world via rightX(side), so
// side B's "left" and side A's "left" both mean the hitter's own left hand.
function resolveSpike(
  toucherPos: Vec3,
  toucherSide: Side,
  dirInput: { x: Axis; y: Axis },
): IntentResult {
  const opponentZ = toucherSide === 'A' ? HALF_LENGTH : -HALF_LENGTH;
  const targetX = dirInput.x === 0 ? COURT_CENTER_X : dirInput.x * rightX(toucherSide) * HALF_WIDTH;
  const target: Vec3 = { x: targetX, y: 0, z: opponentZ };
  const toward = sub(target, toucherPos);
  const direction = normalizeHorizontalPlusUp(toward, 0.25);
  return { direction, arcType: 'spike', baseSpeed: SPIKE_BASE_SPEED };
}

// Builds a launch direction from a horizontal vector plus a fixed upward
// component, then normalizes to unit length so downstream speed scaling is
// consistent regardless of arc target distance.
function normalizeHorizontalPlusUp(horizontal: Vec3, upFraction: number): Vec3 {
  const horizLen = Math.hypot(horizontal.x, horizontal.z);
  const normalizedHoriz =
    horizLen > 1e-6 ? { x: horizontal.x / horizLen, y: 0, z: horizontal.z / horizLen } : { x: 0, y: 0, z: 0 };
  const withUp = add(scale(normalizedHoriz, 1 - upFraction), { x: 0, y: upFraction, z: 0 });
  const totalLen = Math.hypot(withUp.x, withUp.y, withUp.z);
  return totalLen > 1e-6 ? scale(withUp, 1 / totalLen) : { x: 0, y: 1, z: 0 };
}
