import type { Room } from 'colyseus.js';
import { CH } from '@spike/shared';
import type {
  BallLaunch,
  DeathEvent,
  InputFrame,
  LobbyState,
  Ping,
  Pong,
  SetMap,
  SetName,
  SetTeamName,
  Side,
  StateSnapshot,
  TouchIntent,
  TouchResult,
} from '@spike/shared';

// Typed send()/on() wrappers over channels.ts so call sites never touch raw
// channel string literals (single source of truth stays in @spike/shared).

export function sendPing(room: Room, msg: Ping): void {
  room.send(CH.PING, msg);
}

export function sendInput(room: Room, msg: InputFrame): void {
  room.send(CH.INPUT, msg);
}

export function sendTouch(room: Room, msg: TouchIntent): void {
  room.send(CH.TOUCH, msg);
}

export function onPong(room: Room, handler: (msg: Pong) => void): void {
  room.onMessage(CH.PONG, handler);
}

export function onSnapshot(room: Room, handler: (msg: StateSnapshot) => void): void {
  room.onMessage(CH.SNAPSHOT, handler);
}

export function onBallLaunch(room: Room, handler: (msg: BallLaunch) => void): void {
  room.onMessage(CH.BALL_LAUNCH, handler);
}

export function onTouchResult(room: Room, handler: (msg: TouchResult) => void): void {
  room.onMessage(CH.TOUCH_RESULT, handler);
}

export function onDeath(room: Room, handler: (msg: DeathEvent) => void): void {
  room.onMessage(CH.DEATH, handler);
}

// M2.1 §b.6 — lobby channels (see types/lobby.ts).
export function sendSetName(room: Room, msg: SetName): void {
  room.send(CH.SET_NAME, msg);
}

export function sendStartMatch(room: Room): void {
  room.send(CH.START_MATCH, {});
}

// M2.6 §1 — request a move to team slot {side,index}. Server validates (lobby
// phase + target empty) and silently ignores illegal requests. Click-to-move
// IS the team switch: the lobby sends this on any empty-slot click.
export function sendRequestSlot(room: Room, msg: { side: Side; index: number }): void {
  room.send(CH.REQUEST_SLOT, msg);
}

export function onLobbyState(room: Room, handler: (msg: LobbyState) => void): void {
  room.onMessage(CH.LOBBY_STATE, handler);
}

// M2.7 §4 — host-only, lobby-only map pick.
export function sendSetMap(room: Room, msg: SetMap): void {
  room.send(CH.SET_MAP, msg);
}

// M2.7 §5 — captain-only team rename; server infers the side from the sender.
export function sendSetTeamName(room: Room, msg: SetTeamName): void {
  room.send(CH.SET_TEAM_NAME, msg);
}
