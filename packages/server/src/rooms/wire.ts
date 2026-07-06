// Pure builders that turn the server-owned schema into the plain wire shapes
// clients consume (StateSnapshot, lobby roster). No side effects.
import type { PlayerSnapshot, StateSnapshot } from '@spike/shared';
import type { MatchState } from './schema/MatchState';
import type { RosterPlayer } from './lobby';

export function buildRoster(state: MatchState): RosterPlayer[] {
  return [...state.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    side: p.side,
    slotIndex: p.slotIndex, // M2.6 §1
    connected: true,
  }));
}

export function buildSnapshot(
  state: MatchState,
  serverTime: number,
  servePhaseStart: number,
): StateSnapshot {
  const players: PlayerSnapshot[] = [...state.players.values()].map((p) => ({
    id: p.id,
    side: p.side,
    name: p.name,
    pos: { x: p.x, y: p.y, z: p.z },
    stamina: p.stamina,
    mode: p.mode, // M2.2 §2.2 — authoritative touch mode, renderable by any client
    isCharging: p.isCharging, // M2.8 §1 — authoritative charge-hold state, renderable by any client
    lastProcessedSeq: p.lastProcessedSeq,
    facing: p.facing, // M2.5 §1 — authoritative horizontal facing (radians)
  }));
  return {
    serverTime,
    players,
    score: { A: state.scoreA, B: state.scoreB },
    phase: state.phase,
    servingId: state.servingId || null,
    // M2.3 §3.1 — carry the serve-phase start only while serving (the client
    // renders the protractor needle from it); null otherwise.
    servePhaseStartServerTime: state.phase === 'serve' ? servePhaseStart : null,
  };
}
