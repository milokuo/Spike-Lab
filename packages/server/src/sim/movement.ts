// Authoritative movement + stamina integration (spec §7.1, §7.2). Applies a
// validated InputFrame to a player's horizontal position/stamina and returns the
// new values (caller writes them back to schema). Vertical jump motion is NOT
// handled here — variable-jump kinematics are integrated every tick in
// MatchRoom via the shared kinematics/jump module (M2.2 §1); this file only owns
// horizontal move + move-stamina.
import {
  BACK_BOUND_Z,
  MOVE_SPEED,
  SPRINT_SPEED,
  STAMINA_MAX,
  moveToWorld,
  type InputFrame,
  type Side,
} from '@spike/shared';
import { HALF_WIDTH } from '../config';

// Stamina costs (spec §7.1), expressed per second or per event.
const DRAIN_MOVE_PER_S = 2;
const DRAIN_SPRINT_PER_S = 5;
const REGEN_IDLE_PER_S = 4;

// Low-stamina movement penalties (spec §7.2).
const LOW_STAMINA_THRESHOLD = 30;
const LOW_STAMINA_MULT = 0.7;
const EMPTY_STAMINA_MULT = 0.5;

export interface MoveInputs {
  pos: { x: number; y: number; z: number };
  stamina: number;
  side: Side;
  // M2.3 §2 serve-station clamp: when set (serve phase, this player is the
  // GROUNDED server, ball not yet launched), the player may not enter the court
  // — |z| is additionally clamped to >= this value (COURT_HALF_LENGTH). Absent
  // for everyone else and for the airborne server (§2: jumping over the line is
  // legal). After launch the phase leaves 'serve' so no caller sets it.
  serveClampAbsZ?: number;
}

export interface MoveResult {
  pos: { x: number; y: number; z: number };
  stamina: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function speedMultiplier(stamina: number): number {
  if (stamina <= 0) return EMPTY_STAMINA_MULT;
  if (stamina < LOW_STAMINA_THRESHOLD) return LOW_STAMINA_MULT;
  return 1;
}

// Keep each player inside the sidelines and on their own side of the net (z=0).
// M2.2 §4: the back bound is BACK_BOUND_Z (behind the baseline, out of court)
// so standing at the outside serve station is legal; the net plane still caps
// the inner bound so players can never cross to the opponent half.
function clampToHalf(
  x: number,
  z: number,
  side: Side,
  serveClampAbsZ?: number,
): { x: number; z: number } {
  const cx = clamp(x, -HALF_WIDTH, HALF_WIDTH);
  let cz = side === 'A' ? clamp(z, -BACK_BOUND_Z, 0) : clamp(z, 0, BACK_BOUND_Z);
  // §2: grounded server cannot cross the baseline INTO the court — keep |z| at
  // or behind COURT_HALF_LENGTH on their own side (still free to back up to
  // BACK_BOUND_Z). Airborne / other players never pass a clamp value.
  if (serveClampAbsZ !== undefined) {
    cz = side === 'A' ? Math.min(cz, -serveClampAbsZ) : Math.max(cz, serveClampAbsZ);
  }
  return { x: cx, z: cz };
}

// Horizontal move + move/idle stamina only. Y is preserved untouched (jump owns
// it). Jump is applied separately via tryJump on the initiating frame.
export function applyInput(state: MoveInputs, input: InputFrame): MoveResult {
  const dt = clamp(input.dtMs, 0, 100) / 1000; // guard against huge/absurd deltas
  const moving = input.move.x !== 0 || input.move.y !== 0;

  // Transform player-view-local input to world space per side (M2.1 direction
  // fix — the ONE shared helper, identical to client prediction), then
  // normalize the 8-direction intent so diagonals are not faster.
  const mag = Math.hypot(input.move.x, input.move.y) || 1;
  // M2.3 §5.2: single view->world transform — yaw=null keeps the mirrored
  // per-side third-person path; a finite yaw uses the FPV heading. Identical to
  // client prediction (both call moveToWorld).
  const world = moveToWorld(input.move, state.side, input.yaw);
  const dirX = world.x / mag;
  const dirZ = world.z / mag;

  const baseSpeed = MOVE_SPEED * speedMultiplier(state.stamina);
  const nextRaw = { x: state.pos.x + dirX * baseSpeed * dt, z: state.pos.z + dirZ * baseSpeed * dt };
  const clamped = clampToHalf(nextRaw.x, nextRaw.z, state.side, state.serveClampAbsZ);

  let stamina = state.stamina;
  if (moving) {
    stamina -= DRAIN_MOVE_PER_S * dt;
  } else {
    stamina += REGEN_IDLE_PER_S * dt;
  }
  stamina = clamp(stamina, 0, STAMINA_MAX);

  return { pos: { x: clamped.x, y: state.pos.y, z: clamped.z }, stamina };
}

// Exported so future sprint (double-tap) work can reuse the constant.
export const SPRINT_DRAIN_PER_S = DRAIN_SPRINT_PER_S;
export const SPRINT_SPEED_UNITS = SPRINT_SPEED;
