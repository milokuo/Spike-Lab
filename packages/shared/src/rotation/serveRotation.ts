// M2.6 §2 — serve rotation engine (FIVB-adapted, pure + immutable). No Colyseus,
// no side effects: every transition returns a NEW ServeRotation. The room owns
// the per-team rotation order (slot-index ascending at match start) and asks this
// module who serves next after each point / when a player leaves mid-match.
//
// Rules (§2):
//   - Match start: side A's rotationIdx=0 player serves first.
//   - Serving team scores again -> SAME server (no advance).
//   - Side-out (non-serving team scores, gains serve) -> that team advances
//     idx = (idx+1) % teamSize THEN serves, EXCEPT that team's FIRST possession
//     of the set: no advance (serve from idx 0).
//   - Player leaves: remove from order, fix idx modulo; a 1-player team always
//     serves that one player.

import type { Side } from '../types/state';

export interface TeamRotation {
  readonly order: readonly string[]; // playerIds, slot-index ascending at start
  readonly idx: number; // current rotation index into order
  readonly gained: boolean; // has this team held serve at least once this set
}

export interface ServeRotation {
  readonly a: TeamRotation;
  readonly b: TeamRotation;
  readonly serving: Side;
}

function teamOf(rot: ServeRotation, side: Side): TeamRotation {
  return side === 'A' ? rot.a : rot.b;
}

function withTeam(rot: ServeRotation, side: Side, team: TeamRotation): ServeRotation {
  return side === 'A' ? { ...rot, a: team } : { ...rot, b: team };
}

// Build the initial rotation. `orderA`/`orderB` are the playerIds in slot-index
// ascending order. Side A serves first — that is A's first possession, at idx 0
// (so A is marked `gained` while B has not yet taken possession this set).
export function initRotation(
  orderA: readonly string[],
  orderB: readonly string[],
): ServeRotation {
  return {
    a: { order: [...orderA], idx: 0, gained: true },
    b: { order: [...orderB], idx: 0, gained: false },
    serving: 'A',
  };
}

// The playerId currently holding serve ('' if the serving team is empty).
export function currentServerId(rot: ServeRotation): string {
  const t = teamOf(rot, rot.serving);
  if (t.order.length === 0) return '';
  return t.order[t.idx % t.order.length] ?? '';
}

// Apply one rally point. Returns a NEW rotation with the next server resolved.
export function onPoint(rot: ServeRotation, scoringSide: Side): ServeRotation {
  if (scoringSide === rot.serving) {
    return rot; // serving team scored again -> same server, no rotation
  }
  // Side-out: the non-serving team gains serve.
  const gaining = teamOf(rot, scoringSide);
  const size = gaining.order.length;
  // Advance THEN serve — except this team's first possession of the set.
  const nextIdx = gaining.gained && size > 0 ? (gaining.idx + 1) % size : gaining.idx;
  const nextTeam: TeamRotation = { order: gaining.order, idx: nextIdx, gained: true };
  return { ...withTeam(rot, scoringSide, nextTeam), serving: scoringSide };
}

// Remove a player (mid-match leaver) from whichever team holds them, fixing idx
// so the CURRENT server stays the current server when possible, else wrapping
// modulo the smaller order. Serving side is unchanged (the room reassigns the
// live servingId separately if the leaver was serving).
export function removePlayer(rot: ServeRotation, playerId: string): ServeRotation {
  return {
    a: removeFromTeam(rot.a, playerId),
    b: removeFromTeam(rot.b, playerId),
    serving: rot.serving,
  };
}

function removeFromTeam(team: TeamRotation, playerId: string): TeamRotation {
  const pos = team.order.indexOf(playerId);
  if (pos < 0) return team; // not on this team — unchanged
  const order = team.order.filter((id) => id !== playerId);
  if (order.length === 0) return { order, idx: 0, gained: team.gained };
  // Preserve the current server if they remain; otherwise wrap idx modulo.
  const currentId = team.order[team.idx % team.order.length];
  const keptIdx = currentId === undefined ? -1 : order.indexOf(currentId);
  const idx = keptIdx >= 0 ? keptIdx : team.idx % order.length;
  return { order, idx, gained: team.gained };
}
