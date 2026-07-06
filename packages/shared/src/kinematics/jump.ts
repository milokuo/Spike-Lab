// Pure vertical jump kinematics (spec M2.2 §1.2/§1.3). Variable jump: press
// Space to launch instantly at JUMP_V0; holding extends the rising phase
// (reduced gravity) for up to JUMP_BOOST_MAX_S, at a stamina cost per second.
// Identical code runs on server sim and client prediction so both agree
// bit-for-bit — no rubber-banding. No side effects: every function returns a
// new state.

import {
  JUMP_BOOST_MAX_S,
  JUMP_GRAVITY,
  JUMP_HOLD_GRAVITY_MULT,
  JUMP_STAMINA_HOLD_PER_S,
  JUMP_V0,
} from '../constants';

export interface JumpState {
  y: number; // height above ground, units
  vy: number; // vertical velocity, units/s
  airborneS: number; // seconds elapsed since this jump started
}

// Press-to-jump: launches instantly at JUMP_V0. Caller is responsible for
// gating this on grounded + stamina (§1.1) and for deducting
// JUMP_STAMINA_BASE exactly once, on the same frame this is invoked.
export function startJump(): JumpState {
  return { y: 0, vy: JUMP_V0, airborneS: 0 };
}

// True while `held` AND still rising AND within the boost window measured
// from jump start. Evaluated against the state BEFORE this step's
// integration, matching §1.1: "按住期間：僅在上升段且起跳後 <= JUMP_BOOST_MAX_S 內".
function isBoosting(state: JumpState, held: boolean): boolean {
  const rising = state.vy > 0;
  const withinBoostWindow = state.airborneS <= JUMP_BOOST_MAX_S;
  return held && rising && withinBoostWindow;
}

// Fixed-step vertical integration — call every tick/frame regardless of
// input (gravity keeps pulling even with no input). Semi-implicit Euler:
// velocity updates first, then position uses the updated velocity. Height is
// floored at 0 (no tunneling below ground); vy is left as computed so
// isLanded can observe the y<=0 && vy<0 landing condition (§1.1).
export function stepJump(state: JumpState, dtS: number, held: boolean): JumpState {
  const gravity = isBoosting(state, held) ? JUMP_GRAVITY * JUMP_HOLD_GRAVITY_MULT : JUMP_GRAVITY;
  const vy = state.vy - gravity * dtS;
  const y = Math.max(0, state.y + vy * dtS);
  const airborneS = state.airborneS + dtS;
  return { y, vy, airborneS };
}

// Landing condition per §1.1: y<=0 (at/through the ground) while still moving
// downward (vy<0) — distinguishes the launch instant (y=0, vy=JUMP_V0>0,
// airborne) from an actual landing.
export function isLanded(state: JumpState): boolean {
  return state.y <= 0 && state.vy < 0;
}

// Stamina cost for one tick of boosting (§1.2: JUMP_STAMINA_HOLD_PER_S per
// second, ~3 max across the full JUMP_BOOST_MAX_S window). Caller determines
// `boosting` (e.g. via the same held/rising/window check stepJump uses) and
// stops charging once stamina is exhausted (boost aborts, per §1.1).
export function jumpHoldStaminaCost(dtS: number, boosting: boolean): number {
  return boosting ? JUMP_STAMINA_HOLD_PER_S * dtS : 0;
}
