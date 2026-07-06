// Message boundary validation (coding-style: never trust external data). Each
// inbound client message is validated into a strongly-typed shape or rejected;
// malformed payloads are dropped, never applied to authoritative state.
import {
  wrapYaw,
  OVERCHARGE_MAX,
  SLOTS_PER_TEAM,
  type InputFrame,
  type MapId,
  type Ping,
  type RequestSlot,
  type SetMap,
  type SetName,
  type SetTeamName,
  type TouchIntent,
  type TouchMode,
  type Axis,
} from '@spike/shared';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isAxis = (v: unknown): v is Axis => v === -1 || v === 0 || v === 1;
const isMode = (v: unknown): v is TouchMode => v === 'dig' || v === 'set' || v === 'spike';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

// M2.4 §5: the red-zone overcharge extends the wire-legal charge range from
// [0,1] to [0, OVERCHARGE_MAX] — untrusted client charge is clamped here, not
// to 1, so overcharge (extra power, quality penalty) can reach the sim.
const clampCharge = (v: number): number => Math.min(OVERCHARGE_MAX, Math.max(0, v));

export function parsePing(raw: unknown): Ping | null {
  if (!isObj(raw) || !isNum(raw.clientTime)) return null;
  return { clientTime: raw.clientTime };
}

// M2.2 §1.4/§2.2: jump is now a per-frame held flag (rising edge starts the
// jump, server-side), and every frame also reports the current touchMode so the
// server can track authoritative mode. Both are required, strongly typed fields.
export function parseInput(raw: unknown): InputFrame | null {
  if (!isObj(raw)) return null;
  const move = raw.move;
  if (!isObj(move) || !isAxis(move.x) || !isAxis(move.y)) return null;
  if (!isNum(raw.seq) || !isNum(raw.clientTime) || !isNum(raw.dtMs)) return null;
  if (typeof raw.jumpHeld !== 'boolean') return null;
  if (!isMode(raw.touchMode)) return null;
  if (typeof raw.isCharging !== 'boolean') return null;
  if (raw.seq < 0 || raw.dtMs < 0) return null;
  // M2.3 §5.2: yaw is optional on the wire. A finite number is wrapped to
  // [-π, π]; null / missing / non-finite is treated as third-person (null),
  // so moveToWorld falls back to the mirrored per-side path.
  const yaw = typeof raw.yaw === 'number' ? wrapYaw(raw.yaw) : null;
  return {
    seq: raw.seq,
    clientTime: raw.clientTime,
    move: { x: move.x, y: move.y },
    jumpHeld: raw.jumpHeld,
    touchMode: raw.touchMode,
    isCharging: raw.isCharging,
    dtMs: raw.dtMs,
    yaw,
  };
}

export function parseTouch(raw: unknown): TouchIntent | null {
  if (!isObj(raw)) return null;
  const dir = raw.dirInput;
  if (!isObj(dir) || !isAxis(dir.x) || !isAxis(dir.y)) return null;
  if (typeof raw.playerId !== 'string' || raw.playerId.length === 0) return null;
  if (!isNum(raw.clientTime) || !isNum(raw.charge)) return null;
  if (!isMode(raw.mode)) return null;
  return {
    playerId: raw.playerId,
    clientTime: raw.clientTime,
    mode: raw.mode,
    charge: clampCharge(raw.charge), // clamp untrusted charge to [0, OVERCHARGE_MAX] (§5)
    dirInput: { x: dir.x, y: dir.y },
  };
}

// M2.6 §1 — CH.REQUEST_SLOT: a well-formed {side:'A'|'B', index:0..5}. The room
// further validates lobby phase + slot emptiness before applying; a malformed
// payload is dropped here.
export function parseRequestSlot(raw: unknown): RequestSlot | null {
  if (!isObj(raw)) return null;
  if (raw.side !== 'A' && raw.side !== 'B') return null;
  if (!isNum(raw.index) || !Number.isInteger(raw.index)) return null;
  if (raw.index < 0 || raw.index >= SLOTS_PER_TEAM) return null;
  return { side: raw.side, index: raw.index };
}

// M2.1 §b.6 lobby name entry. Trim + validate length and charset (letters,
// digits, spaces, dash/underscore). Rejects control chars, markup, and
// over-long names; caller keeps the previous/default name on rejection.
export const NAME_MAX_LEN = 16;
const NAME_PATTERN = /^[\p{L}\p{N} _-]{1,16}$/u;

export function parseSetName(raw: unknown): SetName | null {
  if (!isObj(raw) || typeof raw.name !== 'string') return null;
  const name = raw.name.trim();
  if (name.length === 0 || name.length > NAME_MAX_LEN) return null;
  if (!NAME_PATTERN.test(name)) return null;
  return { name };
}

// M2.7 §4 — CH.SET_MAP: a well-formed {map:'indoor'|'outdoor'}. Host/phase are
// enforced by the room; here we only validate the payload shape.
const isMapId = (v: unknown): v is MapId => v === 'indoor' || v === 'outdoor';

export function parseSetMap(raw: unknown): SetMap | null {
  if (!isObj(raw) || !isMapId(raw.map)) return null;
  return { map: raw.map };
}

// M2.7 §5 — CH.SET_TEAM_NAME: trim + validate 1..12 chars, SAME charset as
// SET_NAME (letters, digits, spaces, dash/underscore). Captaincy/side are
// enforced by the room (it infers the side from the sender).
export const TEAM_NAME_MAX_LEN = 12;
const TEAM_NAME_PATTERN = /^[\p{L}\p{N} _-]{1,12}$/u;

export function parseSetTeamName(raw: unknown): SetTeamName | null {
  if (!isObj(raw) || typeof raw.name !== 'string') return null;
  const name = raw.name.trim();
  if (name.length === 0 || name.length > TEAM_NAME_MAX_LEN) return null;
  if (!TEAM_NAME_PATTERN.test(name)) return null;
  return { name };
}
