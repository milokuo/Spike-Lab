// Server bootstrap + tuning constants. Room name / gameplay numbers come from
// @spike/shared (single source of truth); only server-process concerns live here.
import { COURT_LEN, COURT_WIDTH, MAX_PLAYERS, SERVE_SPAWN_Z, type Side } from '@spike/shared';

export const HOST = '0.0.0.0';
// Default 2567; override with SPIKE_PORT so multiple instances (e.g. the dev
// server + an in-process jitter/bench harness) can coexist on one machine.
export const PORT = Number(process.env.SPIKE_PORT) || 2567;

// M2.6 §1: code-based lobby holds up to SLOTS_PER_TEAM * 2 = 12 players (6v6).
// Match may start with as few as 2 (1v1) — see MatchRoom canStart / START_MATCH.
export const MAX_CLIENTS = MAX_PLAYERS;

// Deadball -> serve reset countdown (spec §9: "3 秒回位倒數").
export const RESET_DELAY_MS = 3000;

// Movement bounds: keep each player on their own half + inside the sidelines.
export const HALF_WIDTH = COURT_WIDTH / 2;
export const HALF_LENGTH = COURT_LEN / 2;

// Receive spawn: A on z<0 half, B on z>0 half, ~4.5 units off the net. In 2v2
// the two same-side players are offset on X so they never overlap.
const SPAWN_Z = COURT_LEN / 4; // 4.5 units off the net
const SPAWN_X_OFFSET = 1.8; // half-court X separation for 2v2 teammates

// M2.2 §4: the serving player stands OUTSIDE the court, |z| = SERVE_SPAWN_Z
// (9.8, i.e. 0.8u behind the 9u baseline). Standing outside is legal; after the
// serve the player may run back in. Serve arc is re-tuned in MatchSim.serve so
// even a minimum-charge serve from this deeper origin still clears the net.

// M2.3 §2: the all-phase back bound (|z| ≤ BACK_BOUND_Z = 14) now lives in
// @spike/shared and is imported directly by movement/matchSim — the old
// server-local BACK_BOUND_Z (= SERVE_SPAWN_Z, 9.8) is deleted. SERVE_SPAWN_Z
// (9.8) is kept below purely for the serve-station SPAWN position.

function sideZ(side: Side): number {
  return side === 'A' ? -SPAWN_Z : SPAWN_Z;
}

// Receive position for the `slotIndex`-th player on `side` (0-based) out of
// `count` same-side players. count<=1 sits centred; 2 sit split on X.
export function receiveSpawn(
  side: Side,
  slotIndex: number,
  count: number,
): { x: number; y: number; z: number } {
  const x = count <= 1 ? 0 : slotIndex === 0 ? -SPAWN_X_OFFSET : SPAWN_X_OFFSET;
  return { x, y: 0, z: sideZ(side) };
}

// M2.2 §4 serve station: OUTSIDE the court, |z| = SERVE_SPAWN_Z (9.8), centred on X.
export function serveSpawn(side: Side): { x: number; y: number; z: number } {
  const z = side === 'A' ? -SERVE_SPAWN_Z : SERVE_SPAWN_Z;
  return { x: 0, y: 0, z };
}

// Reject touch timestamps that map outside the lag-comp window (see clockSync).
export const MAX_TRAJECTORY_MS = 8000; // safety cap for firstEvent scans
