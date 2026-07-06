// String-literal message channel names — single source of truth for both
// client and server. Never hardcode a channel string outside this file.

export const ROOM_NAME = 'match';

export const CH = {
  // client -> server
  PING: 'ping',
  INPUT: 'input', // movement input frame (prediction/reconciliation)
  TOUCH: 'touch', // touch intent (J/K/L)
  SET_NAME: 'setName', // M2.1 §b.6 — lobby name entry
  START_MATCH: 'startMatch', // M2.1 §b.6 — host-only, lobby -> serve
  REQUEST_SLOT: 'requestSlot', // M2.6 §1 — lobby-only, move self to an empty team slot
  SET_MAP: 'setMap', // M2.7 §4 — host-only, lobby-only, pick indoor/outdoor
  SET_TEAM_NAME: 'setTeamName', // M2.7 §5 — captain-only, rename own side
  // server -> client
  PONG: 'pong',
  SNAPSHOT: 'snapshot', // authoritative player states (schema also patches; snapshot carries ack seq)
  BALL_LAUNCH: 'ballLaunch', // new pure-function ball trajectory
  TOUCH_RESULT: 'touchResult', // feedback to the toucher (PERFECT/GOOD/OK + quality)
  DEATH: 'death', // rally ended (point scored)
  LOBBY_STATE: 'lobbyState', // M2.1 §b.6 — roster + code + host + canStart
} as const;

export type Channel = (typeof CH)[keyof typeof CH];
