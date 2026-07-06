// Physical rally engine (M2.1 WP2). Owns the authoritative ball, lag-comp
// history buffers, per-session clocks, and touch counting — everything the
// rally simulation needs, with NO Colyseus/networking dependency. Methods
// mutate the passed-in schema (score/phase/positions) and RETURN plain effect
// objects (launches, deaths); the room does all broadcasting. This keeps the
// room focused on networking/lobby and keeps the sim unit-testable.
import {
  SERVE_BASE_SPEED,
  SERVE_JUMP_SPEED_MULT,
  SERVE_QUALITY_GROUND,
  SERVE_QUALITY_JUMP,
  RALLY_TARGET,
  WIN_BY,
  BACK_BOUND_Z,
  DIG_REACH_MAX,
  DIVE_LOCK_S,
  DIVE_LUNGE_MAX,
  DIVE_QUALITY,
  DIVE_STAMINA,
  buildBallLaunch,
  ballVelocity,
  diveSuccessProbability,
  overchargeQualityMult,
  resolveIntent,
  resolveNetCollision,
  sweepAngleDeg,
  type BallLaunch,
  type DeathCause,
  type DeathEvent,
  type Side,
  type TouchIntent,
  type TouchMode,
  type TouchRejection,
  type TrajectoryEventKind,
  type Vec3,
} from '@spike/shared';
import type { MatchState } from './schema/MatchState';
import type { PlayerState } from './schema/PlayerState';
import { HALF_WIDTH, RESET_DELAY_MS, receiveSpawn, serveSpawn } from '../config';
import { ClockSync } from '../sim/clockSync';
import { BallRingBuffer, PlayerHistory } from '../sim/ballRingBuffer';
import { BallServer } from '../sim/ballServer';
import { adjudicateTouch } from '../sim/lagComp';
import { SERVE_HAND_HEIGHT, SERVE_LOFT, AIRBORNE_EPS, serveUnitDir, solveJumpLoft } from '../sim/serveAim';
import { applyPoint, isGameOver } from '../game/scoring';
import { initialTouchState, classifyTouch, registerTouch, resolveDeath, type RallyTouchState } from '../game/rally';

export const RESET_DELAY = RESET_DELAY_MS;

// M2.2 §3.2 dive result the room applies to schema (lunge, stamina, lock) + broadcasts.
export interface DiveResult {
  outcome: 'dive_success' | 'dive_fail';
  lunge: Vec3; // new player position after the capped lunge toward the ball
  staminaCost: number;
  lockUntilMs: number; // Date.now() epoch until which movement is locked
}

export interface TouchOutcome {
  accepted: boolean;
  quality: number;
  serverTime: number;
  deltaMs?: number;
  launch?: BallLaunch; // a legal return that put a new ball in play
  // M2.7 §2 — an illegal touch (double contact / over the 3-touch cap). The rally
  // does NOT end: no launch is produced, the ball flies on, and the client shows
  // the rejection feedback. Present only when the touch was refused.
  rejection?: TouchRejection;
  dive?: DiveResult; // M2.2 §3.2 — present for any dig dive attempt (success or fail)
}

export interface EndResult {
  death: DeathEvent;
  gameover: boolean;
}
// M2.3 §3.3 — serve result. `isJump` (released airborne) => ×2 serve stamina.
export interface ServeOutcome {
  launch: BallLaunch;
  isJump: boolean;
}
export class MatchSim {
  private readonly ball = new BallServer();
  private readonly ballBuffer = new BallRingBuffer();
  private readonly playerHistory = new PlayerHistory();
  private readonly clockSync = new ClockSync();
  private touchState: RallyTouchState = initialTouchState();
  private lastHitterSide: Side = 'A';

  observePing(sessionId: string, clientTime: number, serverRecvTime: number): void {
    this.clockSync.observePing(sessionId, clientTime, serverRecvTime);
  }

  forget(sessionId: string): void {
    this.playerHistory.remove(sessionId);
    this.clockSync.remove(sessionId);
  }

  // ---- serve --------------------------------------------------------------

  // M2.3 §1/§3: angle-sweep serve. Charge from 0 (no floor — a weak serve dies
  // naturally and scores the opponent). Horizontal aim = the protractor angle at
  // the lag-comped release, sweepAngleDeg(release − phaseStart); dirInput ignored.
  // Airborne at that instant => JUMP serve (§3.3): higher origin, ×1.25 speed,
  // tighter scatter, flatter solved arc, ×2 stamina (room applies it via isJump).
  serve(player: PlayerState, intent: TouchIntent, servePhaseStartServerTime: number): ServeOutcome {
    const mappedRelease = this.clockSync.toServerTime(player.id, intent.clientTime);
    const releaseServerTime = Number.isFinite(mappedRelease) ? mappedRelease : Date.now();
    const angleDeg = sweepAngleDeg(releaseServerTime - servePhaseStartServerTime);

    // Jump detection uses the lag-comped release height (falls back to the live
    // schema y when no history is recorded yet — e.g. unit tests).
    const releaseY = this.playerHistory.query(player.id, releaseServerTime)?.y ?? player.y;
    const isJump = releaseY > AIRBORNE_EPS;
    const originY = SERVE_HAND_HEIGHT + (isJump ? releaseY : 0);
    // §5: red-zone overcharge (c > 1.0) worsens quality before it feeds the
    // shared scatter/height pipeline — applies to serves same as rally touches.
    const quality = (isJump ? SERVE_QUALITY_JUMP : SERVE_QUALITY_GROUND) * overchargeQualityMult(intent.charge);
    const baseSpeed = SERVE_BASE_SPEED * (isJump ? SERVE_JUMP_SPEED_MULT : 1);
    const loft = isJump
      ? solveJumpLoft(originY, Math.abs(player.z), angleDeg, intent.charge)
      : SERVE_LOFT;

    const rawLaunch = buildBallLaunch({
      origin: { x: player.x, y: originY, z: player.z },
      direction: serveUnitDir(player.side, angleDeg, loft),
      baseSpeed,
      arcType: 'serve',
      quality,
      charge: intent.charge, // §1: raw charge, from 0 — no floor
      serverTime: releaseServerTime,
      rngSeed: this.makeSeed(releaseServerTime),
    });
    // §3: mark jump serves so the client can recolor the ball + trail;
    // grounded serves leave the flag unset (falsy).
    const launch: BallLaunch = isJump ? { ...rawLaunch, isJumpServe: true } : rawLaunch;
    this.lastHitterSide = player.side;
    this.touchState = registerTouch(initialTouchState(), player.side, player.id);
    this.beginTrajectory(launch);
    return { launch, isJump };
  }

  // ---- rally touch --------------------------------------------------------

  rallyTouch(
    sessionId: string,
    player: PlayerState,
    intent: TouchIntent,
    teammates: Vec3[],
    canAffordDive: boolean,
    bypassLegality = false, // M2.9 §2 practice: allow self-juggle (no illegal_double/illegal_count)
  ): TouchOutcome {
    const serverNow = Date.now();
    // M2.2 §2.2 cross-validation: the SERVER-authoritative touchMode wins. The
    // client also reports intent.mode (mode at mouse-up), but a mismatch is
    // ignored — we adjudicate with player.mode, never the client value. (Chosen
    // per §2.2's "server 端為準" option: authoritative state is the source of
    // truth; a divergent intent.mode is treated as a stale/spoofed hint.)
    const mode = player.mode;
    const verdict = adjudicateTouch({
      sessionId,
      playerId: player.id,
      clientTime: intent.clientTime,
      serverNow,
      mode,
      clockSync: this.clockSync,
      ballBuffer: this.ballBuffer,
      playerHistory: this.playerHistory,
      ballPosAt: (t) => this.ball.positionAt(t),
    });

    if (!verdict.accepted || !verdict.ballPos) {
      return { accepted: false, quality: 0, serverTime: serverNow };
    }

    // §2: an illegal touch (same-player double contact, or the side already at 3
    // touches) is REFUSED — but the rally continues; the ball keeps its current
    // trajectory and its landing decides the point. No launch, no death.
    // M2.9 §2 — the practice sandbox bypasses this legality gate so the lone
    // player can juggle (chain consecutive same-player / >3 touches) freely. This
    // is the ONLY relaxation: no gameplay threshold constant is touched.
    if (!bypassLegality) {
      const legality = classifyTouch(this.touchState, player.side, player.id);
      if (!legality.legal) {
        return { accepted: false, quality: 0, serverTime: serverNow, rejection: legality.rejection };
      }
    }

    // §3.2: a dig beyond DIG_REACH_MAX (but within DIVE_REACH_MAX, guaranteed by
    // the mode-aware reach gate) is a dive attempt — a server-authoritative dice
    // roll, not a deterministic touch.
    if (mode === 'dig' && verdict.distance > DIG_REACH_MAX) {
      return this.resolveDive(player, intent, teammates, verdict.ballPos, verdict.distance, verdict.touchServerTime, canAffordDive);
    }

    // §5: overcharge (c > 1.0) worsens the adjudicated quality before it feeds
    // buildBallLaunch's scatter/height pipeline — applies to every touch.
    const quality = verdict.quality * overchargeQualityMult(intent.charge);
    const launch = this.buildReturn(player, intent, mode, verdict.ballPos, quality, verdict.touchServerTime, teammates);
    return { accepted: true, quality, serverTime: verdict.touchServerTime, deltaMs: verdict.deltaMs, launch };
  }

  // §3.2 dive: lunge toward the rewound ball point (capped, net-clamped), lock
  // movement, spend DIVE_STAMINA, and roll for a low-quality save. Both success
  // and failure lunge + lock + cost; only success touches the ball. Insufficient
  // stamina => plain whiff (no dive triggered), per spec.
  private resolveDive(
    player: PlayerState,
    intent: TouchIntent,
    teammates: Vec3[],
    ballPos: Vec3,
    distance: number,
    touchServerTime: number,
    canAffordDive: boolean,
  ): TouchOutcome {
    if (!canAffordDive) {
      return { accepted: false, quality: 0, serverTime: touchServerTime };
    }
    const lunge = this.lungeToward(player, ballPos);
    const dive: DiveResult = {
      outcome: 'dive_fail',
      lunge,
      staminaCost: DIVE_STAMINA,
      lockUntilMs: Date.now() + DIVE_LOCK_S * 1000,
    };
    const success = this.diveRoll(touchServerTime) < diveSuccessProbability(distance);
    if (!success) {
      return { accepted: false, quality: 0, serverTime: touchServerTime, dive };
    }
    // Success: fixed low-quality dig from the ball point toward the nearest
    // teammate (1v1 self-set fallback preserved inside resolveIntent), still
    // subject to the §5 overcharge quality penalty like any other touch.
    const quality = DIVE_QUALITY * overchargeQualityMult(intent.charge);
    const launch = this.buildReturn(player, intent, 'dig', ballPos, quality, touchServerTime, teammates);
    return { accepted: true, quality, serverTime: touchServerTime, launch, dive: { ...dive, outcome: 'dive_success' } };
  }

  // Shared launch builder for a legal return (normal touch or successful dive):
  // resolves the intent direction from the AUTHORITATIVE mode, registers the
  // touch, and installs the new trajectory.
  private buildReturn(
    player: PlayerState,
    intent: TouchIntent,
    mode: TouchMode,
    origin: Vec3,
    quality: number,
    touchServerTime: number,
    teammates: Vec3[],
  ): BallLaunch {
    const intentResult = resolveIntent({
      mode,
      dirInput: intent.dirInput,
      charge: intent.charge,
      toucherPos: { x: player.x, y: player.y, z: player.z },
      toucherSide: player.side,
      teammates, // §b.7 2v2 dig targeting
    });
    const launch = buildBallLaunch({
      origin,
      direction: intentResult.direction,
      baseSpeed: intentResult.baseSpeed,
      arcType: intentResult.arcType,
      quality,
      charge: intent.charge,
      serverTime: touchServerTime,
      rngSeed: this.makeSeed(touchServerTime),
    });
    this.lastHitterSide = player.side;
    this.touchState = registerTouch(this.touchState, player.side, player.id);
    this.beginTrajectory(launch);
    return launch;
  }

  // Capped lunge toward the ball's XZ, clamped so the player never crosses the
  // net (z sign stays on their half) nor leaves the sidelines / back bound (§3.2).
  private lungeToward(player: PlayerState, ballPos: Vec3): Vec3 {
    const dx = ballPos.x - player.x;
    const dz = ballPos.z - player.z;
    const dist = Math.hypot(dx, dz);
    const step = Math.min(dist, DIVE_LUNGE_MAX);
    const nx = dist > 1e-6 ? player.x + (dx / dist) * step : player.x;
    const nz = dist > 1e-6 ? player.z + (dz / dist) * step : player.z;
    const clampedX = Math.min(HALF_WIDTH, Math.max(-HALF_WIDTH, nx));
    const clampedZ =
      player.side === 'A' ? Math.min(0, Math.max(-BACK_BOUND_Z, nz)) : Math.max(0, Math.min(BACK_BOUND_Z, nz));
    return { x: clampedX, y: 0, z: clampedZ };
  }

  // Deterministic dive dice (mulberry32), seeded from the adjudicated touch time
  // XOR a salt so it is independent of the launch scatter seed. Same seed =>
  // same roll on any run — the result is authoritative and broadcast (§3.2).
  private diveRoll(touchServerTime: number): number {
    let state = (this.makeSeed(touchServerTime) ^ 0x9e3779b9) >>> 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // ---- per-tick recording + event detection -------------------------------

  // Records the active ball + every player's position (incl. Y) for lag-comp
  // rewind, and returns a due death/net event during a rally (else null).
  recordTick(state: MatchState, serverNow: number): Exclude<TrajectoryEventKind, 'none'> | null {
    let due: Exclude<TrajectoryEventKind, 'none'> | null = null;
    if (this.ball.active) {
      const pos = this.ball.positionAt(serverNow);
      const vel = this.ball.velocityAt(serverNow);
      if (pos && vel) this.ballBuffer.record(serverNow, pos, vel);
      if (state.phase === 'rally' && this.ball.eventDue(serverNow)) {
        const event = this.ball.predictedEvent;
        if (event && event.kind !== 'none') due = event.kind as Exclude<TrajectoryEventKind, 'none'>;
      }
    }
    for (const p of state.players.values()) {
      this.playerHistory.record(p.id, serverNow, { x: p.x, y: p.y, z: p.z });
    }
    return due;
  }

  eventPos(): Vec3 | null {
    const e = this.ball.predictedEvent;
    return e && e.kind !== 'none' ? e.pos : null;
  }

  // M2.7 §1 — resolve a due net contact into a NEW BallLaunch that starts at the
  // exact contact point/time (a face rebound or a damped tape pass-over), install
  // it, and return it for broadcast. Touch counting is untouched: net contact is
  // not a player touch. Returns null if the current event isn't a net contact.
  resolveNet(): BallLaunch | null {
    const launch = this.ball.currentLaunch;
    const ev = this.ball.predictedEvent;
    if (!launch || !ev || ev.kind !== 'net') return null;
    const incomingVel = ballVelocity(launch, ev.atMs);
    if (!incomingVel) return null;
    const resolved = resolveNetCollision(ev.pos, incomingVel);
    const next: BallLaunch = {
      origin: resolved.origin,
      velocity: resolved.velocity,
      arcType: launch.arcType,
      quality: launch.quality,
      gravity: launch.gravity,
      serverTime: launch.serverTime + ev.atMs, // exact contact instant
      rngSeed: launch.rngSeed,
      isNetTouch: true,
    };
    this.installRebound(next);
    return next;
  }

  // Finding #3: re-check the CURRENT (rebounded) ball for an event already due at
  // the same tick instant, so the room can drain an already-due rebound landing
  // WITHIN the tick — closing the sub-tick window where a touch could be accepted
  // on an already-dead trajectory. Read-only (no history recording).
  pollDueEvent(state: MatchState, serverNow: number): Exclude<TrajectoryEventKind, 'none'> | null {
    if (state.phase !== 'rally' || !this.ball.active) return null;
    if (!this.ball.eventDue(serverNow)) return null;
    const event = this.ball.predictedEvent;
    return event && event.kind !== 'none' ? (event.kind as Exclude<TrajectoryEventKind, 'none'>) : null;
  }

  // Findings #1/#2: install a net rebound WITHOUT wiping the pre-bounce lag-comp
  // history. A laggy touch whose clientTime maps to BEFORE the contact must still
  // adjudicate against the pre-bounce ball, so we keep the ring buffer continuous:
  //   1. drop the post-contact overshoot sample the old trajectory recorded this
  //      tick (its position is past the net — a place the ball never really was),
  //   2. anchor an EXACT sample at the contact instant (rebound origin/velocity)
  //      so a rewind straddling the bounce interpolates the right segment,
  //   3. append the live sample, keeping the buffer time-ordered.
  private installRebound(launch: BallLaunch): void {
    this.ballBuffer.dropFrom(launch.serverTime);
    this.ballBuffer.record(launch.serverTime, launch.origin, launch.velocity);
    this.ball.setLaunch(launch);
    const now = Date.now();
    const pos = this.ball.positionAt(now);
    const vel = this.ball.velocityAt(now);
    if (pos && vel && now > launch.serverTime) this.ballBuffer.record(now, pos, vel);
  }

  lastHitter(): Side {
    return this.lastHitterSide;
  }

  // ---- rally end / scoring ------------------------------------------------

  endRally(
    state: MatchState,
    cause: DeathCause,
    landing: Vec3,
    lastHitterSide: Side,
    serverTime: number,
    frozen = false, // M2.9 §2 practice: freeze scoring/rotation (see below)
  ): EndResult | null {
    if (state.phase !== 'rally') return null; // already dead this rally
    const resolution = resolveDeath(cause, landing, lastHitterSide);
    // M2.9 §2 — practice sandbox freezes the score: the death is still detected
    // and broadcast (cause + scoringSide computed exactly as in versus) but NO
    // point is applied, so the scoreboard stays 0:0 forever.
    const score = frozen
      ? { A: state.scoreA, B: state.scoreB }
      : applyPoint({ A: state.scoreA, B: state.scoreB }, resolution.scoringSide);
    state.scoreA = score.A;
    state.scoreB = score.B;
    state.phase = 'deadball';
    this.ball.clear();

    // Frozen: the lone practice player always re-serves (nextServerId = self);
    // versus: the scoring side's player serves next.
    const nextServer = frozen
      ? state.servingId
      : (this.playerIdForSide(state, resolution.scoringSide) ?? state.servingId);
    const death: DeathEvent = {
      cause,
      landing,
      scoringSide: resolution.scoringSide,
      score,
      nextServerId: nextServer,
      serverTime,
    };
    const gameover = frozen ? false : isGameOver(score); // practice never ends
    if (gameover) state.phase = 'gameover';
    else state.servingId = nextServer;
    return { death, gameover };
  }

  // §d forfeit: a side emptied mid-match; surviving side wins decisively.
  forfeit(state: MatchState): void {
    const winner: Side = this.countSide(state, 'A') > 0 ? 'A' : 'B';
    const loserScore = winner === 'A' ? state.scoreB : state.scoreA;
    const winScore = Math.max(RALLY_TARGET, loserScore + WIN_BY);
    if (winner === 'A') state.scoreA = Math.max(state.scoreA, winScore);
    else state.scoreB = Math.max(state.scoreB, winScore);
    state.phase = 'gameover';
    this.ball.clear();
    this.ballBuffer.clear();
  }

  // ---- serve setup / positioning ------------------------------------------

  enterServe(state: MatchState): void {
    this.positionPlayers(state);
    this.touchState = initialTouchState();
    this.ball.clear();
    this.ballBuffer.clear();
    state.phase = 'serve';
  }

  // Serving player to the back line (feedback #6); receivers to their receive
  // spawns, split on X in 2v2. Returns nothing — caller resets jump states.
  private positionPlayers(state: MatchState): void {
    for (const side of ['A', 'B'] as const) {
      const list = [...state.players.values()].filter((p) => p.side === side);
      list.forEach((p, i) => {
        const spawn = p.id === state.servingId ? serveSpawn(side) : receiveSpawn(side, i, list.length);
        p.x = spawn.x;
        p.y = 0;
        p.z = spawn.z;
      });
    }
  }

  // ---- helpers ------------------------------------------------------------

  private beginTrajectory(launch: BallLaunch): void {
    this.ballBuffer.clear();
    this.ball.setLaunch(launch);
    const now = Date.now();
    const pos = this.ball.positionAt(now);
    const vel = this.ball.velocityAt(now);
    if (pos && vel) this.ballBuffer.record(now, pos, vel);
  }

  private playerIdForSide(state: MatchState, side: Side): string | null {
    for (const p of state.players.values()) if (p.side === side) return p.id;
    return null;
  }

  private countSide(state: MatchState, side: Side): number {
    let n = 0;
    for (const p of state.players.values()) if (p.side === side) n++;
    return n;
  }

  private makeSeed(serverTime: number): number {
    return Math.floor(serverTime) >>> 0;
  }
}
