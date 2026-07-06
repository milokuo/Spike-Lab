import type { Vec3 } from '../math/vec3';
import type { BlockDef, PendingBlock } from './blocks';
import type { MatchPhase, ScoreState, Side } from './state';

// M2.2 §2.1/§2.2: was `Mode` — renamed so it's unambiguous as a cross-boundary
// protocol type (InputFrame.touchMode, PlayerSnapshot.mode, TouchIntent.mode).
export type TouchMode = 'dig' | 'set' | 'spike'; // J / K / L
export type ArcType = 'dig' | 'set' | 'spike' | 'serve';
export type Axis = -1 | 0 | 1;

/* ---- clock sync ---- */
export interface Ping {
  clientTime: number;
} // client -> server

export interface Pong {
  clientTime: number;
  serverTime: number;
} // server -> client (echoes clientTime)

/* ---- movement (prediction / reconciliation) ---- */
// M2.2 §1.4: replaces the M2.1 discrete JumpCommand (fired on release) with a
// per-frame held flag — Space now jumps on press (rising edge), and holding
// extends the rise (see kinematics/jump.ts). Server triggers startJump on the
// rising edge (grounded gate + stamina check) and runs stepJump every tick
// with that frame's jumpHeld.
export interface InputFrame {
  // client -> server, CH.INPUT
  seq: number; // monotonically increasing per client
  clientTime: number;
  move: { x: Axis; y: Axis }; // 8-dir intent (y = forward/back on court's Z)
  jumpHeld: boolean; // was: jump: JumpCommand | null — reported every frame
  touchMode: TouchMode; // M2.2 §2.2 — reported every frame; server writes authoritative state
  isCharging: boolean; // M2.8 §1 — charge-button held this frame; reported every frame, server writes authoritative state
  dtMs: number; // frame delta this input covers
  // M2.3 §5.2 — FPV heading in radians; null = third-person (existing
  // viewToWorld mirrored-per-side path). When present, server validates it's
  // finite and wraps to [-π, π] (see intent/viewSpace.ts wrapYaw); invalid
  // values are treated as null. See moveToWorld for the yaw convention.
  yaw: number | null;
}

export interface PlayerSnapshot {
  // element of StateSnapshot
  id: string;
  side: Side;
  name: string; // M2.1 §b.6 — shown in HUD/lobby roster
  pos: Vec3;
  stamina: number; // 0..100 (§7)
  mode: TouchMode; // M2.2 §2.2 — authoritative; lets any client render any player's mode
  isCharging: boolean; // M2.8 §1 — authoritative charge-hold state; lets any client render any player's charge-up
  lastProcessedSeq: number; // for reconciliation of THIS player
  // M2.5 §1 — horizontal facing in radians (yaw convention, see
  // intent/viewSpace.ts / intent/facing.ts). Authoritative for remote
  // rendering; the local player renders its own facing instantly instead of
  // waiting for the snapshot (see client WP2).
  facing: number;
}

export interface StateSnapshot {
  // server -> client, CH.SNAPSHOT, 30Hz
  serverTime: number;
  players: PlayerSnapshot[];
  score: ScoreState;
  phase: MatchPhase;
  servingId: string | null;
  // M2.3 §3.1 — server clock (ms) at which the current serve phase began, or
  // null when not in serve phase. The angle-sweep protractor pointer is a PURE
  // function of (renderTime - servePhaseStartServerTime) via sweepAngleDeg;
  // this is the ONLY serve-angle value on the wire (the angle itself is never
  // sent — both ends recompute it). Clients render their local pointer from
  // this + the synced clock; the server substitutes the lag-comped release.
  servePhaseStartServerTime: number | null;
}

/* ---- touch (J/K/L) ---- */
export interface TouchIntent {
  // client -> server, CH.TOUCH (spec §14)
  playerId: string;
  clientTime: number; // used for lag compensation (§12); M2.2 §2.1 — sampled at mouse-up
  mode: TouchMode; // M2.2 §2.1 — mode at the moment of release; server cross-checks vs its own authoritative mode
  charge: number; // 0..1, distance only (§6.2)
  dirInput: { x: Axis; y: Axis }; // arrow/WASD state at touch instant (§5.1)
  // skillSlot omitted in M2 (blocks out of scope)
}

export type TouchGrade = 'PERFECT' | 'GOOD' | 'OK' | 'WHIFF';

// M2.7 §2 — a touch the server refuses to convert into a return. The rally does
// NOT end; the ball flies on and its landing decides the point. `illegal_double`
// = same player as their team's previous touch; `illegal_count` = the side is
// already at its 3-touch cap. Client shows red feedback, no key lock.
export type TouchRejection = 'illegal_double' | 'illegal_count';

export interface TouchResult {
  // server -> ALL (broadcast), CH.TOUCH_RESULT. Identifies which player the
  // result belongs to so every client can render that player's character-level
  // reaction (happy/dazed face, dive lunge) for both local and remote players;
  // HUD text feedback stays local-only (gated on playerId === own sessionId).
  playerId: string;
  accepted: boolean; // false = ball unreachable (d > REACH_MAX) or illegal touch
  quality: number; // 0..1
  grade: TouchGrade; // derived from Δt band (§6.2, HUD feedback)
  serverTime: number;
  // M2.2 §3.2 dive outcome, or M2.7 §2 illegal-touch rejection. Absent for a
  // plain accepted/whiffed touch.
  outcome?: 'dive_success' | 'dive_fail' | TouchRejection;
}

/* ---- ball (pure-function packet) §6.4 / §14 ---- */
export interface BallLaunch {
  // server -> all, CH.BALL_LAUNCH
  origin: Vec3;
  velocity: Vec3;
  arcType: ArcType;
  quality: number;
  gravity: number; // units/s^2 (from constants; carried for determinism)
  serverTime: number; // t0 of this trajectory (authoritative clock)
  rngSeed: number;
  appliedBlocks?: BlockDef[]; // always empty/absent in M2
  pendingBlocks?: PendingBlock[]; // always empty/absent in M2
  // M2.4 §3 — true when the server released this ball from an airborne (jump)
  // serve; absent/false otherwise. Client uses this to recolor the ball +
  // trail until the ball's next touch/death. Never sent for non-serve arcs.
  isJumpServe?: boolean;
  // M2.7 §1 — true when this launch was spawned by a net contact (a rebound off
  // the face or a damped pass-over the tape), not a player touch. The trajectory
  // is continuous from the contact point; the client needs no special handling
  // beyond consuming the new packet (an optional net-shake VFX is a bonus).
  isNetTouch?: boolean;
}

/* ---- rally end ---- */
// M2.7 §3 — the only two death causes now: the ball hit the floor in-bounds
// ('ground') or landed out-of-bounds ('out'). Net contact no longer ends a rally
// (it rebounds — see BallLaunch.isNetTouch), and illegal touches no longer end it
// either (§2). `cause` (renamed from the old `reason`) + `scoringSide` drive the
// client's scoring banner ("{teamName} 得分 — {cause}").
export type DeathCause = 'ground' | 'out';

export interface DeathEvent {
  // server -> all, CH.DEATH
  cause: DeathCause;
  landing: Vec3;
  scoringSide: Side;
  score: ScoreState;
  nextServerId: string;
  serverTime: number;
}
