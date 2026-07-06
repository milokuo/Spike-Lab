// Code-based lobby types (§d, feedback #3). Room code = Colyseus's built-in
// `room.roomId` — no custom code-generation or collision handling needed.
//
// M2.6 §1 — team-slot lobby: each side exposes SLOTS_PER_TEAM fixed slots
// (index 0..5). LobbyState carries the FULL slot grid (12 entries) so the client
// renders two columns of slot cards; an empty slot has playerId/name === null.

import type { Side } from './state';

// M2.9 §1 — room-creation mode (the only new wire surface this round). The client
// passes `{ mode }` to `client.create(ROOM_NAME, options)`; the server parses it
// defensively (anything other than the exact 'practice' literal => versus). No CH
// channel and no snapshot/lobby shape changes — this is create-options only.
export type RoomMode = 'versus' | 'practice';
export const ROOM_MODE_PRACTICE = 'practice' as const;

// M2.7 §4 — map selection. Purely visual (gameplay is identical); the host picks
// it in the lobby and clients keep the lobby's map after the match starts.
export type MapId = 'indoor' | 'outdoor';

// M2.7 §5 — per-side captain (playerId) + editable team name.
export interface Captains {
  A: string | null; // earliest-joined current member of side A (null if empty)
  B: string | null;
}

export interface TeamNames {
  A: string; // default 'A 隊'
  B: string; // default 'B 隊'
}

export interface SetName {
  // client -> server, CH.SET_NAME
  name: string;
}

// M2.7 §4 — client -> server, CH.SET_MAP (host-only, lobby phase).
export interface SetMap {
  map: MapId;
}

// M2.7 §5 — client -> server, CH.SET_TEAM_NAME (captain-only). The server infers
// which side from the sender; the payload carries only the new name.
export interface SetTeamName {
  name: string;
}

// M2.6 §1 — a single team slot. Empty when playerId === null.
export interface TeamSlot {
  side: Side;
  index: number; // 0..5 (SLOTS_PER_TEAM - 1)
  playerId: string | null;
  name: string | null;
}

// M2.6 §1 — client -> server, CH.REQUEST_SLOT. Ask to move self into the given
// empty slot (lobby phase only; illegal requests are silently ignored).
export interface RequestSlot {
  side: Side;
  index: number; // 0..5
}

export interface LobbyState {
  // server -> client, CH.LOBBY_STATE
  code: string; // shareable room code (Colyseus roomId)
  hostId: string;
  slots: TeamSlot[]; // M2.6 §1 — full grid: SLOTS_PER_TEAM per side (12 total)
  canStart: boolean; // >=2 players AND each side >=1
  matchSize: 1 | 2; // 1v1 or 2v2, derived from roster at start
  map: MapId; // M2.7 §4 — selected map (default 'indoor')
  captains: Captains; // M2.7 §5 — per-side captain playerId (recomputed on leave)
  teamNames: TeamNames; // M2.7 §5 — per-side display names
}
