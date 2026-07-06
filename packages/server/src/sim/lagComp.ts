// Lag-compensated touch adjudication (spec §12, plan §3). Rewinds the ball and
// toucher to the intent's delayed server time, validates reach, derives the
// timing error against the ideal contact instant, and computes quality via the
// shared pure function. No trust in client-reported positions or quality.
import {
  digDistanceQuality,
  distXZ,
  DIG_REACH_MAX,
  DIG_VERTICAL_MAX,
  DIVE_REACH_MAX,
  fDistance,
  fTiming,
  gradeOf,
  isWithinVerticalReach,
  REACH_MAX,
  EVENT_STEP_MS,
  TOUCH_VERTICAL_MARGIN,
  type TouchGrade,
  type TouchMode,
  type Vec3,
} from '@spike/shared';
import type { BallRingBuffer, PlayerHistory } from './ballRingBuffer';
import type { ClockSync } from './clockSync';

export interface AdjudicationInput {
  sessionId: string;
  playerId: string;
  clientTime: number;
  serverNow: number;
  // M2.2 §3: authoritative touch mode. 'dig' widens the horizontal reach gate to
  // DIVE_REACH_MAX (so dive-range balls are surfaced, not rejected), relaxes the
  // vertical gate to DIG_VERTICAL_MAX, and scores distance on the dig curve.
  mode: TouchMode;
  clockSync: ClockSync;
  ballBuffer: BallRingBuffer;
  playerHistory: PlayerHistory;
  // Pure trajectory sampler for the *active* ball (BallServer.positionAt).
  ballPosAt: (serverTime: number) => Vec3 | null;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

// Distance-quality curve per mode (§3.1): dig uses its own wide curve; set/spike
// keep the generic f_distance. Returns 0 outside the mode's normal-touch reach
// (dive-range distances score 0 here and are overridden by the dive adjudicator).
function distanceQuality(mode: TouchMode, d: number): number {
  return mode === 'dig' ? digDistanceQuality(d) : fDistance(d);
}

// Mode-aware reach gates (horizontal + vertical). Dig reaches farther on both
// axes because a dive saves low, wide balls without a jump (§3.2).
function withinReach(mode: TouchMode, distance: number, ballY: number, jumpY: number): boolean {
  if (mode === 'dig') {
    return distance <= DIVE_REACH_MAX && ballY <= DIG_VERTICAL_MAX + TOUCH_VERTICAL_MARGIN;
  }
  return distance <= REACH_MAX && isWithinVerticalReach(ballY, 0, jumpY);
}

export interface Adjudication {
  accepted: boolean;
  reason: 'ok' | 'noBall' | 'noPlayer' | 'outOfReach' | 'badTimestamp';
  quality: number;
  grade: TouchGrade;
  distance: number;
  deltaMs: number;
  touchServerTime: number;
  ballPos: Vec3 | null; // rewound ball position (launch origin for the return)
}

const reject = (
  reason: Adjudication['reason'],
  touchServerTime: number,
  ballPos: Vec3 | null = null,
): Adjudication => ({
  accepted: false,
  reason,
  quality: 0,
  grade: 'WHIFF',
  distance: Number.POSITIVE_INFINITY,
  deltaMs: Number.POSITIVE_INFINITY,
  touchServerTime,
  ballPos,
});

export function adjudicateTouch(input: AdjudicationInput): Adjudication {
  const { sessionId, playerId, clientTime, serverNow, mode, clockSync, ballBuffer, playerHistory } = input;

  if (!ballBuffer.hasData) return reject('noBall', serverNow);

  // 1. Map client time -> server time, then clamp into the history window.
  const windowStart = ballBuffer.windowStart ?? serverNow;
  const windowEnd = ballBuffer.windowEnd ?? serverNow;
  const mapped = clockSync.toServerTime(sessionId, clientTime);
  if (!Number.isFinite(mapped)) return reject('badTimestamp', serverNow);
  const touchServerTime = Math.min(windowEnd, Math.max(windowStart, mapped));

  // 2. Rewind ball + player to that instant.
  const ballPast = ballBuffer.query(touchServerTime);
  if (!ballPast) return reject('noBall', touchServerTime);
  const playerPast = playerHistory.query(playerId, touchServerTime);
  if (!playerPast) return reject('noPlayer', touchServerTime, ballPast.pos);

  // 3. Reach gate — horizontal distance + vertical gate, both mode-aware (§3.2).
  //    playerPast.y is the toucher's rewound jump height (0 when grounded); the
  //    stance base is the ground plane (y=0). For dig, a ball in (DIG_REACH_MAX,
  //    DIVE_REACH_MAX] is still "accepted" here so the dive adjudicator upstream
  //    can roll for it; distanceQuality returns 0 for that band on its own.
  const distance = distXZ(ballPast.pos, playerPast);
  if (!withinReach(mode, distance, ballPast.pos.y, playerPast.y)) {
    return reject('outOfReach', touchServerTime, ballPast.pos);
  }

  // 4. Ideal contact time t*: scan the active trajectory across the window for
  //    the sample that minimizes horizontal ball-player distance (plan §3.5).
  const idealTime = findIdealTime(input, playerPast, windowStart, windowEnd, touchServerTime);
  const deltaMs = Math.abs(touchServerTime - idealTime);

  // 5. Quality + grade from the shared pure functions (§6.1 / §6.2 / §3.1).
  const quality = clamp01(distanceQuality(mode, distance) * fTiming(deltaMs));
  const grade = gradeOf(deltaMs);

  return {
    accepted: true,
    reason: 'ok',
    quality,
    grade,
    distance,
    deltaMs,
    touchServerTime,
    ballPos: ballPast.pos,
  };
}

// Scan for the moment the ball is horizontally closest to the (rewound) player.
// Falls back to touchServerTime if the trajectory sampler yields nothing.
function findIdealTime(
  input: AdjudicationInput,
  playerPos: Vec3,
  windowStart: number,
  windowEnd: number,
  fallback: number,
): number {
  let bestTime = fallback;
  let bestDist = Number.POSITIVE_INFINITY;
  let found = false;

  for (let t = windowStart; t <= windowEnd; t += EVENT_STEP_MS) {
    const pos = input.ballPosAt(t) ?? input.ballBuffer.query(t)?.pos ?? null;
    if (!pos) continue;
    const d = distXZ(pos, playerPos);
    if (d < bestDist) {
      bestDist = d;
      bestTime = t;
      found = true;
    }
  }
  return found ? bestTime : fallback;
}
