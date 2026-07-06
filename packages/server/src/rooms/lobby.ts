// Pure lobby helpers (M2.1 §d + M2.6 §1). No Colyseus/room state here — the room
// adapts its schema into these plain shapes so slot assignment, start gating, and
// LobbyState assembly stay testable and side-effect free.
import {
  SLOTS_PER_TEAM,
  type Captains,
  type LobbyState,
  type MapId,
  type Side,
  type TeamNames,
  type TeamSlot,
} from '@spike/shared';

export interface RosterPlayer {
  id: string;
  name: string;
  side: Side;
  slotIndex: number; // M2.6 §1 — 0..SLOTS_PER_TEAM-1
  connected: boolean;
}

// M2.6 §1 auto-assign: seat the joiner in the fewer-team's lowest empty slot
// (tiebreak to A). Falls back to the other side if the preferred side is full.
// Returns null only when both sides are full (room already at maxClients).
export function autoAssignSlot(
  players: readonly Pick<RosterPlayer, 'side' | 'slotIndex'>[],
): { side: Side; index: number } | null {
  const countA = players.filter((p) => p.side === 'A').length;
  const countB = players.filter((p) => p.side === 'B').length;
  const preferred: Side = countA <= countB ? 'A' : 'B';
  const other: Side = preferred === 'A' ? 'B' : 'A';
  for (const side of [preferred, other]) {
    const index = lowestEmptyIndex(players, side);
    if (index !== null) return { side, index };
  }
  return null;
}

function lowestEmptyIndex(
  players: readonly Pick<RosterPlayer, 'side' | 'slotIndex'>[],
  side: Side,
): number | null {
  const used = new Set(players.filter((p) => p.side === side).map((p) => p.slotIndex));
  for (let i = 0; i < SLOTS_PER_TEAM; i++) if (!used.has(i)) return i;
  return null;
}

// M2.6 §1 — is (side, index) currently free? (REQUEST_SLOT target must be empty.)
export function isSlotFree(
  players: readonly Pick<RosterPlayer, 'side' | 'slotIndex'>[],
  side: Side,
  index: number,
): boolean {
  return !players.some((p) => p.side === side && p.slotIndex === index);
}

// Start gate (§d / §b.6): >=2 players AND each side has >=1.
export function canStart(players: readonly RosterPlayer[]): boolean {
  const a = players.filter((p) => p.side === 'A').length;
  const b = players.filter((p) => p.side === 'B').length;
  return players.length >= 2 && a >= 1 && b >= 1;
}

// Derived match size at start: 2 players -> 1v1, 3+ -> 2v2 (HUD/positioning hint).
export function matchSizeOf(count: number): 1 | 2 {
  return count <= 2 ? 1 : 2;
}

export function defaultName(seat: number): string {
  return `Player ${seat}`;
}

// M2.6 §1 — assemble the FULL slot grid (SLOTS_PER_TEAM per side, 12 total).
// Empty slots carry playerId/name === null.
export function buildLobbyState(
  code: string,
  hostId: string,
  players: readonly RosterPlayer[],
  map: MapId,
  captains: Captains,
  teamNames: TeamNames,
): LobbyState {
  const slots: TeamSlot[] = [];
  for (const side of ['A', 'B'] as const) {
    for (let index = 0; index < SLOTS_PER_TEAM; index++) {
      const p = players.find((pl) => pl.side === side && pl.slotIndex === index);
      slots.push({ side, index, playerId: p ? p.id : null, name: p ? p.name : null });
    }
  }
  return {
    code,
    hostId,
    slots,
    canStart: canStart(players),
    matchSize: matchSizeOf(players.length),
    map,
    captains,
    teamNames,
  };
}
