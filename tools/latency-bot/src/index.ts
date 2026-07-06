/**
 * SPIKE LAB latency-validation bot.
 *
 * Usage:
 *   cd tools/latency-bot
 *   npm install
 *   npm run latency-test -- --players 2
 *   npm run latency-test -- --players 4 --probe all
 *   npm run latency-test -- --self-test
 *
 * Options:
 *   --url ws://0.0.0.0:2567         Colyseus endpoint; use ws://localhost:2567 if needed.
 *   --players 2|4                   Lobby size. 4 creates a 2v2 room for teammate dig scenarios.
 *   --probe all|matrix|jump-arc|dive|weak-serve|angle|curve Which live probe(s) to run. Default: all.
 *   --latency 100                   Run one artificial outbound-delay value.
 *   --latencies 0,50,100,150        Run a delay matrix.
 *   --offset 50                     Run one touch timing offset.
 *   --offsets 0,50,120              Run a touch-offset matrix.
 *   --samples 5                     Clock-sync pong samples before testing.
 *   --timeout 12000                 Per-scenario timeout in ms.
 *   --short-jump-frames 2           jumpHeld=true frames for short-tap comparison.
 *   --full-jump-hold-ms 300         jumpHeld=true duration for the full-hold comparison.
 *   --self-test                     Run local model/helper tests without a server.
 */

// @ts-ignore: this package owns the colyseus.js dependency, but local dry type-checks may run before npm install.
import { Client } from 'colyseus.js';
import {
  ballPosition,
  firstEvent,
  CH,
  distXZ,
  gradeOf,
  GRAVITY,
  DIG_REACH_MAX,
  DIG_VERTICAL_MAX,
  DIVE_REACH_MAX,
  JUMP_BOOST_MAX_S,
  JUMP_GRAVITY,
  JUMP_V0,
  PERFECT_WINDOW_MS,
  REACH_MAX,
  ROOM_NAME,
  SERVE_SIDESPIN_MAX,
  SERVE_SWEEP_PERIOD_MS,
  SPIN_MAX,
  TICK_MS,
  forwardZ,
  startJump,
  stepJump,
  sweepAngleDeg,
  type Axis,
  type BallLaunch,
  type DeathEvent,
  type InputFrame,
  type LobbyState,
  type PlayerSnapshot,
  type Pong,
  type Side,
  type StateSnapshot,
  type TouchGrade,
  type TouchIntent,
  type TouchMode,
  type TouchResult,
  type TrajectoryEvent,
  type Vec3,
} from '../../../packages/shared/src/index';

declare const process: {
  argv: string[];
  exitCode?: number;
};

type MessageHandler<T> = (message: T) => void;
type PlayerCount = 2 | 4;
type ProbeMode = 'all' | 'matrix' | 'jump-arc' | 'dive' | 'weak-serve' | 'angle' | 'curve';

interface RoomLike {
  roomId: string;
  sessionId: string;
  send(type: string, message?: unknown): void;
  onMessage<T = unknown>(type: string, callback: MessageHandler<T>): unknown;
  leave(consented?: boolean): Promise<unknown> | unknown;
}

interface LobbySession {
  rooms: RoomLike[];
  host: RoomLike;
  code: string;
  latestLobby?: LobbyState;
}

interface ScenarioResult {
  latencyMs: number;
  offsetMs: number;
  expected: TouchGrade;
  actual: TouchGrade | 'NO_RESULT' | 'ERROR';
  accepted: boolean;
  pass: boolean;
  detail: string;
}

interface JumpArcResult {
  players: PlayerCount;
  shortHoldFrames: number;
  fullHoldFrames: number;
  pass: boolean;
  detail: string;
}

interface DiveProbeResult {
  players: PlayerCount;
  pass: boolean;
  detail: string;
}

interface WeakServeProbeResult {
  players: PlayerCount;
  pass: boolean;
  detail: string;
}

interface AngleProbeResult {
  players: PlayerCount;
  pass: boolean;
  detail: string;
}

interface CliOptions {
  url: string;
  players: PlayerCount;
  probe: ProbeMode;
  latencies: number[];
  offsets: number[];
  samples: number;
  timeoutMs: number;
  shortJumpFrames: number;
  fullJumpHoldMs: number;
  selfTest: boolean;
}

interface ClockSync {
  offsetMs: number;
  rttMs: number;
  samples: number;
}

interface PlannedTouch {
  clientTime: number;
  effectiveServerTime: number;
  effectiveDeltaMs: number;
  expectedGrade: TouchGrade;
}

interface JumpArcSample {
  serverTime: number;
  y: number;
}

interface JumpArcCheck {
  pass: boolean;
  detail: string;
  baselineY?: number;
  apexY?: number;
  apexHeight?: number;
}

const DEFAULT_LATENCIES = [0, 50, 100, 150];
const DEFAULT_OFFSETS = [0, 50, 120];
const DEFAULT_URL = 'ws://0.0.0.0:2567';
const MAX_TRAJECTORY_MS = 5000;
const TRAJECTORY_SCAN_STEP_MS = 4;
const JUMP_ARC_SAMPLE_MS = 1600;
const ARC_EPSILON = 0.025;
const APEX_COMPARISON_MIN_DELTA = 0.15;
const DIVE_TARGET_DISTANCE = 2.8;
const DIVE_DISTANCE_TOLERANCE = 0.35;
const SERVE_IN_PLAY_CHARGE = 0.7;
const WEAK_SERVE_CHARGE = 0.05;
const SERVE_ANGLE_TOLERANCE_DEG = 6;

// ---- curve probe (M3.0a §8.8) -------------------------------------------------
// Off-center serve release angle for the DUAL-END CONSISTENCY case (the ball flies
// untouched to its landing): sweepAngleDeg > 0 ⇒ serveSpin picks side-L (world
// ω = +Y·rate), a sidespin whose Magnus bends the flight laterally. 30° carries a
// clearly non-zero |ω| = (30/90)·SERVE_SIDESPIN_MAX ≈ 6.7 rad/s; whether it lands
// in or out is irrelevant (DeathEvent carries the landing either way).
const CURVE_SERVE_ANGLE_DEG = 30;
// Off-center angle for the LAG-COMP scenarios: the receiver must still be able to
// chase a reachable in-bounds contact on its half. Live calibration: a 15° target
// (+ the ~2° setTimeout release lateness) curves the descending band past the
// |x| < 4.2 contact window on some runs; 10° (|ω| ≈ 2.2–2.7 measured) bends the
// flight ~0.5m yet always leaves a chaseable contact.
const CURVE_LAGCOMP_ANGLE_DEG = 10;
// Curved lag-comp serve must carry at least this |ω| (nominal 2.2 at 10°); the
// straight baseline may carry up to this residual |ω| from release-timing jitter
// on the sweep center (~1° ⇒ 0.22 rad/s; observed 0.1–0.2, so 0.6 ≈ ±2.7° slack).
const CURVE_LAGCOMP_MIN_OMEGA = 1.5;
const CURVE_STRAIGHT_MAX_OMEGA = 0.6;
// Rally spike charge for the topspin case: nominal ω = SPIN_MAX·charge (world axis
// ⟂ the hit direction, horizontal), Magnus presses the ball DOWN; fidelity shrinks
// it by f^SPIN_FIDELITY_EXP for an imperfectly timed touch.
const CURVE_SPIKE_CHARGE = 0.7;
// Dual-end position agreement: the bot re-derives every server-computed position
// (net-rebound chain origins, touch rewind origins, DeathEvent.landing) from the
// SAME wire BallLaunch via the shared flight API. Identical code + identical inputs
// ⇒ ~ulp agreement in a faithful pipeline; 5cm is a generous envelope (ring-buffer
// interp ≈ mm, net anti-jitter nudge ≈ mm) that still catches any true Magnus
// divergence (which on a curved flight is meters, not cm).
const CURVE_POS_TOLERANCE = 0.05;
// Materiality floor: how far Magnus must have shifted the landing vs a spin-free
// (ω=0) twin of the same launch. Guards the consistency check from passing
// trivially on a straight ball (a degenerate ω≈0 launch sneaking through).
const CURVE_MIN_LANDING_SHIFT = 0.15;
// Release-timing slack when checking the serve's |ω| against the targeted sweep
// angle: the sweep moves 0.225°/ms, so ±10° absorbs scheduling + clock-offset
// jitter (the angle probe's own pass tolerance is 6°).
const CURVE_ANGLE_SLACK_DEG = 10;
// Spike |ω| floor: nominal 31.5 (SPIN_MAX·0.7); even a sloppily timed accepted
// touch (f ≈ 0.3, ω·f^1.5) stays above 5. Lower means spin never hit the wire.
const CURVE_SPIKE_MIN_OMEGA = 5;
const CURVE_HORIZON_MS = MAX_TRAJECTORY_MS;
// Lag-comp-no-skew sweep: ideal-moment (offset 0) touches under these outbound
// delays, curved serve vs straight (angle-0, zero-sidespin) baseline.
const CURVE_LAGCOMP_LATENCIES = [0, 100, 150];

function nowMs(): number {
  return performance.now();
}

function parseCsvNumbers(value: string, label: string): number[] {
  const parsed = value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value));

  if (parsed.length === 0) {
    throw new Error(`${label} must contain at least one finite number.`);
  }

  return parsed;
}

function parsePlayers(value: string): PlayerCount {
  const parsed = Number(value);
  if (parsed !== 2 && parsed !== 4) {
    throw new Error('--players must be 2 or 4.');
  }
  return parsed;
}

function parseProbe(value: string): ProbeMode {
  if (
    value === 'all' ||
    value === 'matrix' ||
    value === 'jump-arc' ||
    value === 'dive' ||
    value === 'weak-serve' ||
    value === 'angle' ||
    value === 'curve'
  ) {
    return value;
  }
  throw new Error('--probe must be all, matrix, jump-arc, dive, weak-serve, angle, or curve.');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    url: DEFAULT_URL,
    players: 2,
    probe: 'all',
    latencies: DEFAULT_LATENCIES,
    offsets: DEFAULT_OFFSETS,
    samples: 5,
    timeoutMs: 12000,
    shortJumpFrames: 2,
    fullJumpHoldMs: JUMP_BOOST_MAX_S * 1000,
    selfTest: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--url' && next) {
      options.url = next;
      i += 1;
    } else if (arg === '--players' && next) {
      options.players = parsePlayers(next);
      i += 1;
    } else if (arg === '--probe' && next) {
      options.probe = parseProbe(next);
      i += 1;
    } else if (arg === '--latency' && next) {
      options.latencies = [Number(next)];
      i += 1;
    } else if (arg === '--latencies' && next) {
      options.latencies = parseCsvNumbers(next, '--latencies');
      i += 1;
    } else if (arg === '--offset' && next) {
      options.offsets = [Number(next)];
      i += 1;
    } else if (arg === '--offsets' && next) {
      options.offsets = parseCsvNumbers(next, '--offsets');
      i += 1;
    } else if (arg === '--samples' && next) {
      options.samples = Number(next);
      i += 1;
    } else if (arg === '--timeout' && next) {
      options.timeoutMs = Number(next);
      i += 1;
    } else if (arg === '--short-jump-frames' && next) {
      options.shortJumpFrames = Number(next);
      i += 1;
    } else if (arg === '--full-jump-hold-ms' && next) {
      options.fullJumpHoldMs = Number(next);
      i += 1;
    } else if (arg === '--self-test') {
      options.selfTest = true;
    } else {
      throw new Error(`Unknown or incomplete option: ${arg ?? '(missing)'}`);
    }
  }

  return options;
}

function assertFiniteList(values: number[], label: string): void {
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error(`${label} must be non-negative finite numbers.`);
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${label} must be a positive finite number.`);
  }
  return Math.max(1, Math.round(value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

async function waitUntil(
  predicate: () => boolean,
  intervalMs: number,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = nowMs() + timeoutMs;
  while (!predicate()) {
    if (nowMs() >= deadline) {
      throw new Error(`${label} timed out`);
    }
    await sleep(intervalMs);
  }
}

interface OutboundLatencyControl {
  // Change the simulated delay for subsequent sends (e.g. drop to 0 while
  // chasing to a contact point — chase movement isn't what's graded, and each
  // delayed send is its own setTimeout, so a fast 25ms movement loop can queue
  // dozens of them and add real timer-queue jitter right when the FINAL
  // graded touch needs precise wall-clock scheduling; restore it just before
  // that touch to still faithfully test "does grading survive a delayed send").
  setDelayMs: (ms: number) => void;
}

function wrapOutboundLatency(room: RoomLike, latencyMs: number): OutboundLatencyControl {
  const sendNow = room.send.bind(room);
  let delayMs = latencyMs;
  room.send = (type: string, message?: unknown) => {
    if (delayMs <= 0) {
      sendNow(type, message);
      return;
    }

    setTimeout(() => sendNow(type, message), delayMs);
  };
  return {
    setDelayMs: (ms: number) => {
      delayMs = ms;
    },
  };
}

function updateClock(sync: ClockSync, pong: Pong, receivedAtMs: number): void {
  const rttMs = Math.max(0, receivedAtMs - pong.clientTime);
  const oneWayMs = rttMs / 2;
  const measuredOffsetMs = pong.serverTime + oneWayMs - receivedAtMs;
  const alpha = sync.samples === 0 ? 1 : 0.2;

  sync.offsetMs = sync.offsetMs * (1 - alpha) + measuredOffsetMs * alpha;
  sync.rttMs = sync.rttMs * (1 - alpha) + rttMs * alpha;
  sync.samples += 1;
}

async function startClockSync(room: RoomLike, minSamples: number): Promise<ClockSync> {
  const sync: ClockSync = { offsetMs: 0, rttMs: 0, samples: 0 };
  let active = true;

  room.onMessage<Pong>(CH.PONG, (pong) => {
    updateClock(sync, pong, nowMs());
  });

  const loop = async () => {
    while (active) {
      room.send(CH.PING, { clientTime: nowMs() });
      await sleep(250);
    }
  };

  const loopDone = loop();
  try {
    await waitUntil(() => sync.samples >= minSamples, 50, 5000, `clock sync for ${room.sessionId}`);
    return sync;
  } finally {
    active = false;
    await loopDone.catch(() => undefined);
  }
}

function inferredServerClockOffset(sync: ClockSync): number {
  // Server ClockSync observes serverReceiveTime - clientTime. The client-side
  // ping/pong offset is skew + (up - down) / 2, so adding RTT / 2 yields skew + up.
  return sync.offsetMs + sync.rttMs / 2;
}

function serverMappedClientTime(sync: ClockSync, clientTime: number): number {
  return clientTime + inferredServerClockOffset(sync);
}

function clientTimeForServerMappedTime(sync: ClockSync, serverTime: number): number {
  return serverTime - inferredServerClockOffset(sync);
}

function planTouch(idealServerTime: number, requestedOffsetMs: number, sync: ClockSync): PlannedTouch {
  const targetServerTime = idealServerTime + requestedOffsetMs;
  const clientTime = clientTimeForServerMappedTime(sync, targetServerTime);
  const effectiveServerTime = serverMappedClientTime(sync, clientTime);
  const effectiveDeltaMs = Math.abs(effectiveServerTime - idealServerTime);

  return {
    clientTime,
    effectiveServerTime,
    effectiveDeltaMs,
    expectedGrade: gradeOf(effectiveDeltaMs),
  };
}

function estimateIdealTouchServerTime(launch: BallLaunch, playerPos: Vec3): number | null {
  let bestElapsedMs = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let elapsedMs = 0; elapsedMs <= MAX_TRAJECTORY_MS; elapsedMs += TRAJECTORY_SCAN_STEP_MS) {
    const pos = ballPosition(launch, elapsedMs);
    const distance = distXZ(pos, playerPos);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestElapsedMs = elapsedMs;
    }
  }

  if (bestDistance > REACH_MAX) {
    return null;
  }

  return launch.serverTime + bestElapsedMs;
}

function latestPlayer(snapshot: StateSnapshot | undefined, playerId: string): PlayerSnapshot | undefined {
  return snapshot?.players.find((player: PlayerSnapshot) => player.id === playerId);
}

const oppositeSide = (side: Side): Side => (side === 'A' ? 'B' : 'A');

function makeTouchIntent(
  playerId: string,
  clientTime: number,
  mode: TouchIntent['mode'] = 'dig',
  charge = 0,
): TouchIntent {
  return {
    playerId,
    clientTime,
    mode,
    charge: clamp01(charge),
    dirInput: { x: 0 as Axis, y: 0 as Axis },
  };
}

function makeInputFrame(seq: number, jumpHeld: boolean, touchMode: TouchMode = 'dig'): InputFrame {
  return {
    seq,
    clientTime: nowMs(),
    move: { x: 0 as Axis, y: 0 as Axis },
    jumpHeld,
    touchMode,
    // M2.8 wire added isCharging; a resting/idle bot never holds the charge
    // button, so it reports false every frame (server writes authoritative state).
    isCharging: false,
    dtMs: TICK_MS,
    yaw: null,
  };
}

function sendModeInput(room: RoomLike, seq: number, touchMode: TouchMode): void {
  room.send(CH.INPUT, makeInputFrame(seq, false, touchMode));
}

async function createLobby(url: string, players: PlayerCount, timeoutMs: number): Promise<LobbySession> {
  const client = new Client(url);
  const rooms: RoomLike[] = [];
  let latestLobby: LobbyState | undefined;

  const host = (await client.create(ROOM_NAME)) as RoomLike;
  rooms.push(host);
  const code = host.roomId;

  const trackLobby = (room: RoomLike) => {
    room.onMessage<StateSnapshot>(CH.SNAPSHOT, () => undefined);
    room.onMessage<LobbyState>(CH.LOBBY_STATE, (state) => {
      latestLobby = state;
    });
  };

  trackLobby(host);
  host.send(CH.SET_NAME, { name: 'Latency Host' });

  for (let index = 1; index < players; index += 1) {
    const room = (await client.joinById(code)) as RoomLike;
    rooms.push(room);
    trackLobby(room);
    room.send(CH.SET_NAME, { name: `Latency P${index + 1}` });
  }

  await waitUntil(
    () => latestLobby !== undefined && latestLobby.slots.length >= players && latestLobby.canStart,
    50,
    timeoutMs,
    `lobby ${code} ready with ${players} players`,
  );

  return {
    rooms,
    host,
    code,
    get latestLobby() {
      return latestLobby;
    },
  };
}

async function startLobbyMatch(session: LobbySession, timeoutMs: number, started: () => boolean): Promise<void> {
  session.host.send(CH.START_MATCH);
  await waitUntil(started, 50, timeoutMs, `host START_MATCH for lobby ${session.code}`);
}

async function closeRooms(rooms: RoomLike[]): Promise<void> {
  await Promise.all(rooms.map((room) => Promise.resolve(room.leave(true)).catch(() => undefined)));
}

function requireRoom(session: LobbySession, index: number, label: string): RoomLike {
  const room = session.rooms[index];
  if (!room) {
    throw new Error(`missing ${label} room at index ${index}`);
  }
  return room;
}

function muteSnapshotsForIdleRooms(session: LobbySession, activeRooms: RoomLike[]): void {
  const active = new Set(activeRooms);
  for (const room of session.rooms) {
    if (!active.has(room)) {
      room.onMessage<StateSnapshot>(CH.SNAPSHOT, () => undefined);
      room.onMessage<BallLaunch>(CH.BALL_LAUNCH, () => undefined);
      room.onMessage<TouchResult>(CH.TOUCH_RESULT, () => undefined);
      room.onMessage(CH.DEATH, () => undefined);
    }
  }
}

async function runScenario(
  url: string,
  players: PlayerCount,
  latencyMs: number,
  offsetMs: number,
  samples: number,
  timeoutMs: number,
): Promise<ScenarioResult> {
  let session: LobbySession | undefined;
  let expected: TouchGrade = gradeOf(offsetMs);
  let expectedDeltaMs = offsetMs;

  try {
    session = await createLobby(url, players, timeoutMs);
    // rooms[0] is always the FIRST server (host — rotation starts at A slot 0,
    // §m2.6); rooms[1] auto-assigns to the OPPOSITE side, so it's the one that
    // can LEGALLY dig the serve. Before M2.7 this scenario had the server also
    // send the graded touch itself (distance 0 from its own launch origin, a
    // convenient shortcut). §2 now enforces the no-double-touch rule server-side
    // (classifyTouch: same toucher as the team's last contact => illegal_double),
    // so a self-touch after serving is correctly rejected — the graded,
    // latency-wrapped touch must come from a genuinely different toucher.
    const serverRoom = requireRoom(session, 0, 'server');
    const testedRoom = requireRoom(session, 1, 'tested receiver');
    muteSnapshotsForIdleRooms(session, [serverRoom, testedRoom]);
    // Clock sync must observe the injected latency (so the lag-comp offset it
    // derives matches what the server actually saw), so start wrapped; drop to
    // 0 for the chase (see wrapOutboundLatency) and restore before the graded touch.
    const outbound = wrapOutboundLatency(testedRoom, latencyMs);

    let latestSnapshot: StateSnapshot | undefined;
    let pendingLaunch: BallLaunch | undefined;
    let result: TouchResult | undefined;
    let awaitingRallyTouchResult = false;
    let testedSeq = 1;

    testedRoom.onMessage<StateSnapshot>(CH.SNAPSHOT, (snapshot) => {
      latestSnapshot = snapshot;
    });
    testedRoom.onMessage<TouchResult>(CH.TOUCH_RESULT, (message) => {
      if (!awaitingRallyTouchResult) return;
      result = message;
    });
    testedRoom.onMessage<BallLaunch>(CH.BALL_LAUNCH, (launch) => {
      // §1 — a net rebound/tape-pass chains a NEW launch continuing from the
      // contact point (isNetTouch: true) but keeps arcType 'serve'. Always
      // adopt the latest so the estimates below follow the chain instead of a
      // pre-bounce trajectory that never actually plays out past contact.
      if (launch.arcType === 'serve') pendingLaunch = launch;
    });
    testedRoom.onMessage(CH.DEATH, () => undefined);
    serverRoom.onMessage<StateSnapshot>(CH.SNAPSHOT, () => undefined);
    serverRoom.onMessage<BallLaunch>(CH.BALL_LAUNCH, () => undefined);
    serverRoom.onMessage<TouchResult>(CH.TOUCH_RESULT, () => undefined);
    serverRoom.onMessage(CH.DEATH, () => undefined);

    const [serverSync, testedSync] = await Promise.all([
      startClockSync(serverRoom, samples),
      startClockSync(testedRoom, samples),
    ]);

    await startLobbyMatch(session, timeoutMs, () => latestSnapshot?.phase === 'serve');
    await waitUntil(
      () => latestSnapshot?.servingId != null && latestSnapshot?.servePhaseStartServerTime != null,
      50,
      timeoutMs,
      'matrix serve setup',
    );

    if (latestSnapshot?.servingId !== serverRoom.sessionId) {
      throw new Error(`expected rooms[0] to be the initial server (got servingId=${latestSnapshot?.servingId})`);
    }

    // Release at a sweep center (angle 0, straight at the net) — the same
    // deterministic timing the dive/angle probes use — so the serve reliably
    // crosses to the receiver's half near center court instead of whatever
    // angle the ambient release moment happens to sweep to.
    const phaseStart = latestSnapshot.servePhaseStartServerTime!;
    const centerServerTime = nextSweepCenterServerTime(phaseStart, serverMappedClientTime(serverSync, nowMs()));
    await sleep(Math.max(0, clientTimeForServerMappedTime(serverSync, centerServerTime) - nowMs()));
    sendModeInput(serverRoom, 1, 'spike');
    serverRoom.send(CH.TOUCH, makeTouchIntent(serverRoom.sessionId, nowMs(), 'spike', SERVE_IN_PLAY_CHARGE));

    await withTimeout(waitUntil(() => pendingLaunch !== undefined, 50, timeoutMs, 'matrix serve launch'), timeoutMs + 100, 'matrix scenario launch');

    const receiver0 = latestPlayer(latestSnapshot, testedRoom.sessionId);
    if (!receiver0) {
      throw new Error('tested receiver snapshot missing before chase');
    }
    const receiverSide = receiver0.side;

    // Chase to the reachable contact point (like the dive probe) instead of
    // assuming the receiver's default stationary position is already in reach.
    // Movement frames aren't what's graded, so drop the simulated delay for
    // them (see wrapOutboundLatency) — restored below before the graded touch.
    outbound.setDelayMs(0);
    const contact = reachableContact(pendingLaunch!, receiverSide);
    let chased = false;
    if (contact) {
      const contactClientTime = clientTimeForServerMappedTime(testedSync, contact.serverTime);
      const moveBudget = Math.max(200, Math.min(1600, contactClientTime - nowMs() - 200));
      testedSeq = await moveToward(
        testedRoom,
        testedRoom.sessionId,
        receiverSide,
        () => latestSnapshot,
        contact.pos.x,
        contact.pos.z,
        testedSeq,
        moveBudget,
        0.5,
      );
      chased = true;
    }
    outbound.setDelayMs(latencyMs);

    // Re-read pendingLaunch fresh (not the earlier snapshot): the chase above
    // can take up to ~1.4s — long enough for a net contact to chain a new
    // launch mid-chase (§1) — and re-fetch the receiver's post-chase position.
    const receiverNow = latestPlayer(latestSnapshot, testedRoom.sessionId);
    if (!receiverNow) {
      throw new Error('tested receiver snapshot missing after chase');
    }
    const idealServerTime = estimateIdealTouchServerTime(pendingLaunch!, receiverNow.pos);
    if (idealServerTime === null) {
      return {
        latencyMs,
        offsetMs,
        expected,
        actual: 'NO_RESULT',
        accepted: false,
        pass: false,
        detail: `no reachable contact point on the served trajectory (chased=${chased ? 'yes' : 'no'})`,
      };
    }

    const planned = planTouch(idealServerTime, offsetMs, testedSync);
    expected = planned.expectedGrade;
    expectedDeltaMs = planned.effectiveDeltaMs;
    await sleep(Math.max(0, planned.clientTime - nowMs()));

    awaitingRallyTouchResult = true;
    sendModeInput(testedRoom, testedSeq, 'dig');
    testedSeq += 1;
    testedRoom.send(CH.TOUCH, makeTouchIntent(testedRoom.sessionId, planned.clientTime));

    await withTimeout(waitUntil(() => result !== undefined, 50, timeoutMs, 'touch result'), timeoutMs + 100, 'scenario');

    const actual = result?.grade ?? 'NO_RESULT';
    const accepted = result?.accepted === true;
    const pass = accepted && actual === expected;
    const serverOffset = inferredServerClockOffset(testedSync);

    return {
      latencyMs,
      offsetMs,
      expected,
      actual,
      accepted,
      pass,
      detail: `effectiveDelta=${expectedDeltaMs.toFixed(1)}ms rtt=${testedSync.rttMs.toFixed(1)}ms serverOffset=${serverOffset.toFixed(1)}ms perfectWindow=${PERFECT_WINDOW_MS}ms players=${players} chased=${chased ? 'yes' : 'no'}`,
    };
  } catch (error) {
    return {
      latencyMs,
      offsetMs,
      expected,
      actual: 'ERROR',
      accepted: false,
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (session) {
      await closeRooms(session.rooms);
    }
  }
}

function printResults(results: ScenarioResult[]): void {
  const latencyWidth = Math.max('latency'.length, ...results.map((row) => String(row.latencyMs).length));
  const offsetWidth = Math.max('offset'.length, ...results.map((row) => String(row.offsetMs).length));
  const statusWidth = 'status'.length;

  console.log(
    `${'latency'.padEnd(latencyWidth)}  ${'offset'.padEnd(offsetWidth)}  ${'expected'.padEnd(8)}  ${'actual'.padEnd(9)}  ${'accepted'.padEnd(8)}  ${'status'.padEnd(statusWidth)}  detail`,
  );

  for (const row of results) {
    console.log(
      `${String(row.latencyMs).padEnd(latencyWidth)}  ${String(row.offsetMs).padEnd(offsetWidth)}  ${row.expected.padEnd(8)}  ${row.actual.padEnd(9)}  ${String(row.accepted).padEnd(8)}  ${(row.pass ? 'PASS' : 'FAIL').padEnd(statusWidth)}  ${row.detail}`,
    );
  }
}

function assertJumpArc(samples: JumpArcSample[]): JumpArcCheck {
  if (samples.length < 6) {
    return { pass: false, detail: `not enough snapshots (${samples.length})` };
  }

  const ys = samples.map((sample) => sample.y);
  const baseline = ys[0]!;
  let apexIndex = 0;
  let apexY = ys[0]!;

  for (let index = 1; index < ys.length; index += 1) {
    const prev = samples[index - 1]!;
    const curr = samples[index]!;
    const dtSec = Math.max(0.001, (curr.serverTime - prev.serverTime) / 1000);
    const maxStep = JUMP_V0 * dtSec + 0.5 * JUMP_GRAVITY * dtSec * dtSec + 0.25;
    const dy = Math.abs(curr.y - prev.y);
    if (dy > maxStep) {
      return {
        pass: false,
        detail: `teleport between snapshots ${index - 1}->${index}: dy=${dy.toFixed(3)} max=${maxStep.toFixed(3)}`,
      };
    }

    if (curr.y > apexY) {
      apexY = curr.y;
      apexIndex = index;
    }
  }

  if (apexY - baseline < 0.1) {
    return { pass: false, detail: `no meaningful rise: baseline=${baseline.toFixed(3)} apex=${apexY.toFixed(3)}` };
  }

  if (apexIndex === 0 || apexIndex === ys.length - 1) {
    return { pass: false, detail: `apex at edge: index=${apexIndex} samples=${ys.length}` };
  }

  for (let index = 1; index <= apexIndex; index += 1) {
    const prevY = ys[index - 1]!;
    const currY = ys[index]!;
    if (currY + ARC_EPSILON < prevY) {
      return {
        pass: false,
        detail: `rise not monotonic at ${index - 1}->${index}: ${prevY.toFixed(3)} to ${currY.toFixed(3)}`,
      };
    }
  }

  for (let index = apexIndex + 1; index < ys.length; index += 1) {
    const prevY = ys[index - 1]!;
    const currY = ys[index]!;
    if (currY > prevY + ARC_EPSILON) {
      return {
        pass: false,
        detail: `fall not monotonic at ${index - 1}->${index}: ${prevY.toFixed(3)} to ${currY.toFixed(3)}`,
      };
    }
  }

  return {
    pass: true,
    detail: `samples=${samples.length} baseline=${baseline.toFixed(3)} apex=${apexY.toFixed(3)} apexHeight=${(apexY - baseline).toFixed(3)} apexIndex=${apexIndex}`,
    baselineY: baseline,
    apexY,
    apexHeight: apexY - baseline,
  };
}

async function driveJumpAttempt(
  room: RoomLike,
  seqStart: number,
  holdFrames: number,
  sampleMs: number,
  touchMode: TouchMode = 'dig',
): Promise<number> {
  let seq = seqStart;
  const totalFrames = Math.max(holdFrames + 1, Math.ceil(sampleMs / TICK_MS));

  for (let frame = 0; frame < totalFrames; frame += 1) {
    room.send(CH.INPUT, makeInputFrame(seq, frame < holdFrames, touchMode));
    seq += 1;
    await sleep(TICK_MS);
  }

  return seq;
}

async function waitForGrounded(
  player: () => PlayerSnapshot | undefined,
  timeoutMs: number,
  label: string,
): Promise<void> {
  await waitUntil(() => {
    const current = player();
    return current !== undefined && current.pos.y <= ARC_EPSILON;
  }, 50, timeoutMs, label);
}

function assertApexComparison(shortCheck: JumpArcCheck, fullCheck: JumpArcCheck): JumpArcCheck {
  if (!shortCheck.pass) {
    return { pass: false, detail: `short tap arc failed: ${shortCheck.detail}` };
  }
  if (!fullCheck.pass) {
    return { pass: false, detail: `full hold arc failed: ${fullCheck.detail}` };
  }

  const shortApex = shortCheck.apexHeight ?? 0;
  const fullApex = fullCheck.apexHeight ?? 0;
  if (shortApex + APEX_COMPARISON_MIN_DELTA >= fullApex) {
    return {
      pass: false,
      detail: `short tap apex not measurably lower: short=${shortApex.toFixed(3)} full=${fullApex.toFixed(3)} requiredDelta=${APEX_COMPARISON_MIN_DELTA.toFixed(3)}`,
    };
  }

  return {
    pass: true,
    detail: `shortApex=${shortApex.toFixed(3)} fullApex=${fullApex.toFixed(3)} delta=${(fullApex - shortApex).toFixed(3)}`,
    apexHeight: fullApex,
  };
}

async function runJumpArcProbe(
  url: string,
  players: PlayerCount,
  shortHoldFrames: number,
  fullHoldMs: number,
  timeoutMs: number,
): Promise<JumpArcResult> {
  let session: LobbySession | undefined;
  const normalizedShortHoldFrames = positiveInteger(shortHoldFrames, '--short-jump-frames');
  const fullHoldFrames = positiveInteger(Math.ceil(fullHoldMs / TICK_MS), '--full-jump-hold-ms');

  try {
    session = await createLobby(url, players, timeoutMs);
    const jumper = requireRoom(session, 0, 'jumper');
    muteSnapshotsForIdleRooms(session, [jumper]);
    let activeSamples: JumpArcSample[] | undefined;
    let shortSamples: JumpArcSample[] = [];
    let fullSamples: JumpArcSample[] = [];
    let latestSnapshot: StateSnapshot | undefined;
    let seq = 1;

    jumper.onMessage<StateSnapshot>(CH.SNAPSHOT, (snapshot) => {
      latestSnapshot = snapshot;
      const player = latestPlayer(snapshot, jumper.sessionId);
      if (player && activeSamples) {
        activeSamples.push({ serverTime: snapshot.serverTime, y: player.pos.y });
      }
    });

    await startLobbyMatch(session, timeoutMs, () => latestSnapshot?.phase === 'serve' || latestSnapshot?.phase === 'rally');

    await waitUntil(() => latestPlayer(latestSnapshot, jumper.sessionId) !== undefined, 50, timeoutMs, 'first jumper snapshot');
    await waitForGrounded(() => latestPlayer(latestSnapshot, jumper.sessionId), timeoutMs, 'jumper grounded before short tap');

    shortSamples = [];
    activeSamples = shortSamples;
    const shortStart = latestSnapshot;
    const shortPlayer = latestPlayer(shortStart, jumper.sessionId);
    if (shortStart && shortPlayer) {
      shortSamples.push({ serverTime: shortStart.serverTime, y: shortPlayer.pos.y });
    }
    seq = await driveJumpAttempt(jumper, seq, normalizedShortHoldFrames, JUMP_ARC_SAMPLE_MS);
    activeSamples = undefined;
    const shortCheck = assertJumpArc(shortSamples);

    await waitForGrounded(() => latestPlayer(latestSnapshot, jumper.sessionId), timeoutMs, 'jumper grounded before full hold');

    fullSamples = [];
    activeSamples = fullSamples;
    const fullStart = latestSnapshot;
    const fullPlayer = latestPlayer(fullStart, jumper.sessionId);
    if (fullStart && fullPlayer) {
      fullSamples.push({ serverTime: fullStart.serverTime, y: fullPlayer.pos.y });
    }
    seq = await driveJumpAttempt(jumper, seq, fullHoldFrames, JUMP_ARC_SAMPLE_MS);
    activeSamples = undefined;
    void seq;

    const fullCheck = assertJumpArc(fullSamples);
    const comparison = assertApexComparison(shortCheck, fullCheck);

    return {
      players,
      shortHoldFrames: normalizedShortHoldFrames,
      fullHoldFrames,
      pass: comparison.pass,
      detail: `${comparison.detail}; short=(${shortCheck.detail}); full=(${fullCheck.detail})`,
    };
  } catch (error) {
    return {
      players,
      shortHoldFrames: normalizedShortHoldFrames,
      fullHoldFrames,
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (session) {
      await closeRooms(session.rooms);
    }
  }
}

function printJumpArcResult(result: JumpArcResult): void {
  console.log(
    `jump-arc players=${result.players} shortHoldFrames=${result.shortHoldFrames} fullHoldFrames=${result.fullHoldFrames} status=${result.pass ? 'PASS' : 'FAIL'} detail=${result.detail}`,
  );
}

function estimateDiveTouchServerTime(
  launch: BallLaunch,
  playerPos: Vec3,
  targetDistance = DIVE_TARGET_DISTANCE,
): { serverTime: number; distance: number; ballY: number } | null {
  let best: { elapsedMs: number; distance: number; ballY: number; error: number } | undefined;

  for (let elapsedMs = 0; elapsedMs <= MAX_TRAJECTORY_MS; elapsedMs += TRAJECTORY_SCAN_STEP_MS) {
    const pos = ballPosition(launch, elapsedMs);
    if (pos.y < 0) {
      break;
    }

    const verticalReach = playerPos.y + DIG_VERTICAL_MAX;
    if (pos.y > verticalReach) {
      continue;
    }

    const distance = distXZ(pos, playerPos);
    if (distance <= DIG_REACH_MAX || distance > DIVE_REACH_MAX) {
      continue;
    }

    const error = Math.abs(distance - targetDistance);
    if (!best || error < best.error) {
      best = { elapsedMs, distance, ballY: pos.y, error };
    }
  }

  if (!best || best.error > DIVE_DISTANCE_TOLERANCE) {
    return null;
  }

  return {
    serverTime: launch.serverTime + best.elapsedMs,
    distance: best.distance,
    ballY: best.ballY,
  };
}

function isDiveOutcome(outcome: unknown): outcome is NonNullable<TouchResult['outcome']> {
  return outcome === 'dive_success' || outcome === 'dive_fail';
}

function assertDiveOutcome(result: TouchResult | undefined): { pass: boolean; detail: string } {
  if (!result) {
    return { pass: false, detail: 'no touch result received' };
  }
  if (!isDiveOutcome(result.outcome)) {
    return { pass: false, detail: `missing or invalid dive outcome: ${String(result.outcome)}` };
  }
  return {
    pass: true,
    detail: `outcome=${result.outcome} accepted=${result.accepted} grade=${result.grade} quality=${result.quality.toFixed(3)}`,
  };
}

// First point on the ball's KNOWN trajectory that is on `side`'s half, in-bounds
// and at a reachable height — a deterministic contact target. Serves now scatter
// (q=0.8) and are angle-swept, so a receiver can't stand still; it chases this
// point (mirrors integration.ts reachableContact, per the WP2 chase note).
function reachableContact(launch: BallLaunch, side: Side): { serverTime: number; pos: Vec3 } | null {
  for (let e = 0; e <= MAX_TRAJECTORY_MS; e += TRAJECTORY_SCAN_STEP_MS) {
    const p = ballPosition(launch, e);
    const onSide = side === 'A' ? p.z < 0 : p.z > 0;
    if (onSide && Math.abs(p.z) < 8.5 && Math.abs(p.x) < 4.2 && p.y > 0.5 && p.y < 2.0) {
      return { serverTime: launch.serverTime + e, pos: p };
    }
  }
  return null;
}

// Drive a player toward (tx,tz) via player-view INPUT frames until within `near`
// units or the budget elapses. View-local axes mirror per side exactly like the
// server's third-person movement (yaw=null path). Returns the next seq to use.
async function moveToward(
  room: RoomLike,
  sessionId: string,
  side: Side,
  getSnapshot: () => StateSnapshot | undefined,
  tx: number,
  tz: number,
  seqStart: number,
  budgetMs: number,
  near: number,
): Promise<number> {
  const rx = side === 'A' ? -1 : 1; // rightX(side)
  const fz = side === 'A' ? 1 : -1; // forwardZ(side)
  let seq = seqStart;
  const t0 = nowMs();
  while (nowMs() - t0 < budgetMs) {
    const pos = latestPlayer(getSnapshot(), sessionId)?.pos;
    if (!pos) break;
    const dx = tx - pos.x;
    const dz = tz - pos.z;
    if (Math.hypot(dx, dz) < near) break;
    const mx = (Math.abs(dx) < 0.12 ? 0 : Math.sign(dx) * rx) as Axis;
    const my = (Math.abs(dz) < 0.12 ? 0 : Math.sign(dz) * fz) as Axis;
    room.send(CH.INPUT, {
      seq: seq++,
      clientTime: nowMs(),
      move: { x: mx, y: my },
      jumpHeld: false,
      touchMode: 'dig',
      // M2.8 wire field: a pure movement frame isn't charging.
      isCharging: false,
      dtMs: 33,
      yaw: null,
    } satisfies InputFrame);
    await sleep(25);
  }
  await sleep(90); // let the last frames + a snapshot land
  return seq;
}

// Next FUTURE sweep center (angle 0, straight at the net): centers recur at
// phaseStart + 400 + 800·k (§3.1 SERVE_SWEEP_PERIOD_MS=1600, half-period 800).
function nextSweepCenterServerTime(phaseStart: number, afterServerTime: number): number {
  const base = phaseStart + 400;
  const k = Math.max(0, Math.ceil((afterServerTime + 40 - base) / 800));
  return base + 800 * k;
}

// Next FUTURE serverTime whose sweep angle == targetAngleDeg on the RISING edge
// (phase ∈ [0,0.5): angle = -90 + 360·phase ⇒ phase = (angle+90)/360). A positive
// target gives a deterministic off-center serve carrying sidespin (serveSpin picks
// side-L for angle ≥ 0). Occurrences recur once per full SERVE_SWEEP_PERIOD_MS.
function nextSweepAngleServerTime(phaseStart: number, afterServerTime: number, targetAngleDeg: number): number {
  const phase = (targetAngleDeg + 90) / 360; // rising-edge phase for this angle
  const elapsedInCycle = phase * SERVE_SWEEP_PERIOD_MS;
  const base = phaseStart + elapsedInCycle;
  const k = Math.max(0, Math.ceil((afterServerTime + 40 - base) / SERVE_SWEEP_PERIOD_MS));
  return base + SERVE_SWEEP_PERIOD_MS * k;
}

function vmag(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

interface CurveSubCheck {
  pass: boolean;
  detail: string;
}

// Expected serve sidespin magnitude band for a release targeted at `angleDeg`:
// |ω| = (|angle|/90)·SERVE_SIDESPIN_MAX with ±CURVE_ANGLE_SLACK_DEG release jitter.
function serveSpinBand(angleDeg: number): { min: number; max: number } {
  const lo = Math.max(0, Math.abs(angleDeg) - CURVE_ANGLE_SLACK_DEG);
  const hi = Math.abs(angleDeg) + CURVE_ANGLE_SLACK_DEG;
  return { min: (lo / 90) * SERVE_SIDESPIN_MAX, max: (hi / 90) * SERVE_SIDESPIN_MAX };
}

interface SpinSpec {
  minMag: number;
  maxMag: number;
  // sidespin ⇒ ω ∥ ±Y (spinIntentToWorld side-L/R axis = ±UP);
  // topspin ⇒ ω ⟂ Y (axis = up × forward, horizontal). Fidelity only SCALES ω,
  // so the axis orientation is an exact wire invariant, not an approximation.
  axis: 'vertical' | 'horizontal';
  requirePositiveY?: boolean; // side-L (+angle release) ⇒ ω = +Y·rate exactly
}

// Assert a wire launch carries the spin signature the shared presets promise.
function assertSpinSignature(label: string, launch: BallLaunch, spec: SpinSpec): CurveSubCheck {
  const mag = vmag(launch.omega);
  if (mag < spec.minMag || mag > spec.maxMag) {
    return {
      pass: false,
      detail: `${label}: |ω|=${mag.toFixed(2)}rad/s outside [${spec.minMag.toFixed(2)}, ${spec.maxMag.toFixed(2)}]`,
    };
  }
  const yFraction = Math.abs(launch.omega.y) / (mag || 1);
  if (spec.axis === 'vertical' && yFraction < 0.95) {
    return { pass: false, detail: `${label}: sidespin ω not vertical (|ωy|/|ω|=${yFraction.toFixed(3)})` };
  }
  if (spec.axis === 'horizontal' && yFraction > 0.05) {
    return { pass: false, detail: `${label}: topspin ω not horizontal (|ωy|/|ω|=${yFraction.toFixed(3)})` };
  }
  if (spec.requirePositiveY && launch.omega.y <= 0) {
    return { pass: false, detail: `${label}: +angle serve must carry ω = +Y (side-L), got ωy=${launch.omega.y.toFixed(2)}` };
  }
  return { pass: true, detail: `${label}: |ω|=${mag.toFixed(2)}rad/s axis=${spec.axis} ok` };
}

// How far Magnus displaced this launch's landing vs a spin-free (ω = 0) twin —
// the trajectory's "did it actually curve" materiality measure. A fresh object
// simply gets its own flight-cache entry; determinism is cache-independent.
function magnusShiftOf(launch: BallLaunch): number {
  const curved: TrajectoryEvent = firstEvent(launch, CURVE_HORIZON_MS);
  const straightTwin: BallLaunch = { ...launch, omega: { x: 0, y: 0, z: 0 } };
  const straight = firstEvent(straightTwin, CURVE_HORIZON_MS);
  return dist3(curved.pos, straight.pos);
}

// DUAL-END CONSISTENCY over a whole rally chain: every server-computed position on
// the wire must equal the bot's local shared-flight rederivation of the SAME data.
//   link i  : ballPosition(launch[i-1], launch[i].serverTime − launch[i-1].serverTime)
//             vs launch[i].origin — a net-rebound contact origin (server bisection)
//             or a touch-return origin (server ring-buffer rewind), both of which
//             must sit ON the previous launch's pure trajectory.
//   landing : local firstEvent(final launch) vs DeathEvent.landing (+ cause kind).
// Any drift beyond CURVE_POS_TOLERANCE = the two ends disagree about where the
// curved ball IS — an engine-level P1 bug, reported with numbers.
function assertChainConsistency(
  label: string,
  launches: BallLaunch[],
  deathLanding: Vec3,
  deathCause: DeathEvent['cause'],
): CurveSubCheck {
  const finalLaunch = launches[launches.length - 1];
  if (!finalLaunch) {
    return { pass: false, detail: `${label}: no launches observed` };
  }

  let worstLinkCm = 0;
  for (let i = 1; i < launches.length; i += 1) {
    const prev = launches[i - 1]!;
    const next = launches[i]!;
    const predicted = ballPosition(prev, next.serverTime - prev.serverTime);
    const errCm = dist3(predicted, next.origin) * 100;
    worstLinkCm = Math.max(worstLinkCm, errCm);
    if (errCm > CURVE_POS_TOLERANCE * 100) {
      return {
        pass: false,
        detail:
          `${label}: chain link ${i} (${next.isNetTouch ? 'net-rebound' : 'touch'} origin) drifted ` +
          `${errCm.toFixed(2)}cm > ${(CURVE_POS_TOLERANCE * 100).toFixed(0)}cm — dual-end divergence at ` +
          `t=${(next.serverTime - prev.serverTime).toFixed(1)}ms after launch`,
      };
    }
  }

  const ev: TrajectoryEvent = firstEvent(finalLaunch, CURVE_HORIZON_MS);
  if (ev.kind !== 'ground' && ev.kind !== 'out') {
    return { pass: false, detail: `${label}: local firstEvent predicted '${ev.kind}', server saw a '${deathCause}' landing` };
  }
  const landErrCm = dist3(ev.pos, deathLanding) * 100;
  if (landErrCm > CURVE_POS_TOLERANCE * 100) {
    return {
      pass: false,
      detail:
        `${label}: landing drifted ${landErrCm.toFixed(2)}cm > ${(CURVE_POS_TOLERANCE * 100).toFixed(0)}cm ` +
        `(local=${ev.pos.x.toFixed(3)},${ev.pos.y.toFixed(3)},${ev.pos.z.toFixed(3)} ` +
        `server=${deathLanding.x.toFixed(3)},${deathLanding.y.toFixed(3)},${deathLanding.z.toFixed(3)}) — dual-end divergence`,
    };
  }
  if (ev.kind !== deathCause) {
    return { pass: false, detail: `${label}: local event kind '${ev.kind}' ≠ server death cause '${deathCause}'` };
  }
  return {
    pass: true,
    detail: `${label}: links=${launches.length - 1} worstLink=${worstLinkCm.toFixed(2)}cm landingErr=${landErrCm.toFixed(2)}cm cause=${deathCause}`,
  };
}

async function runDiveProbe(url: string, players: PlayerCount, samples: number, timeoutMs: number): Promise<DiveProbeResult> {
  let session: LobbySession | undefined;

  try {
    session = await createLobby(url, players, timeoutMs);
    const rooms = session.rooms;
    let latestSnapshot: StateSnapshot | undefined;
    let pendingLaunch: BallLaunch | undefined;
    let result: TouchResult | undefined;

    for (const room of rooms) {
      room.onMessage<StateSnapshot>(CH.SNAPSHOT, (snapshot) => {
        latestSnapshot = snapshot;
      });
      room.onMessage<BallLaunch>(CH.BALL_LAUNCH, (launch) => {
        // §1: a net rebound/tape-pass chains a NEW BallLaunch (isNetTouch: true)
        // that keeps arcType 'serve' and continues the same trajectory from the
        // contact point. Always adopt the latest so the estimates below follow
        // the chain instead of predicting off a pre-bounce launch that never
        // actually plays out past the net contact.
        if (launch.arcType === 'serve') pendingLaunch = launch;
      });
      room.onMessage<TouchResult>(CH.TOUCH_RESULT, () => undefined);
      room.onMessage(CH.DEATH, () => undefined);
    }

    const syncs = await Promise.all(rooms.map((room) => startClockSync(room, samples)));
    await startLobbyMatch(session, timeoutMs, () => latestSnapshot?.phase === 'serve');
    await waitUntil(
      () => latestSnapshot?.servingId != null && latestSnapshot?.servePhaseStartServerTime != null,
      50,
      timeoutMs,
      'dive serve setup',
    );

    // Roles follow the server's choice: whoever serves aims straight; the OTHER
    // peer is the diver so it chases the opponent's serve across the net.
    const servingId = latestSnapshot!.servingId!;
    const servingRoom = rooms.find((room) => room.sessionId === servingId);
    const diverRoom = rooms.find((room) => room !== servingRoom);
    if (!servingRoom || !diverRoom) {
      throw new Error('could not identify dive serve/diver rooms');
    }
    const servingSync = syncs[rooms.indexOf(servingRoom)]!;
    const diverSync = syncs[rooms.indexOf(diverRoom)]!;
    // TouchResult is broadcast to the WHOLE room for EVERY touch (M2.8) — the
    // serve itself emits one (playerId = server). Arm the capture only once the
    // dive touch is actually sent and filter to the diver's own result, or the
    // stale serve result satisfies the wait and reads as "no dive outcome".
    let awaitingDiveResult = false;
    diverRoom.onMessage<TouchResult>(CH.TOUCH_RESULT, (message) => {
      if (awaitingDiveResult && message.playerId === diverRoom.sessionId) {
        result = result ?? message;
      }
    });

    let serverSeq = 1;
    let diverSeq = 1;

    // Serve straight at the net (release at a sweep center => angle 0), the same
    // deterministic timing integration.ts uses, so the ball flies toward the
    // receiver's half instead of off at the release-moment sweep angle.
    const phaseStart = latestSnapshot!.servePhaseStartServerTime!;
    sendModeInput(servingRoom, serverSeq, 'spike');
    serverSeq += 1;
    void serverSeq;
    const centerServerTime = nextSweepCenterServerTime(phaseStart, serverMappedClientTime(servingSync, nowMs()));
    await sleep(Math.max(0, clientTimeForServerMappedTime(servingSync, centerServerTime) - nowMs()));
    servingRoom.send(CH.TOUCH, makeTouchIntent(servingRoom.sessionId, nowMs(), 'spike', SERVE_IN_PLAY_CHARGE));

    await withTimeout(waitUntil(() => pendingLaunch !== undefined, 50, timeoutMs, 'dive serve launch'), timeoutMs + 100, 'dive probe launch');

    const diver0 = latestPlayer(latestSnapshot, diverRoom.sessionId);
    if (!diver0) {
      throw new Error('diver snapshot missing before chase');
    }
    const diverSide = diver0.side;

    // Stand ~DIVE_TARGET_DISTANCE away from the reachable contact point so the
    // ball descends through the dive annulus (DIG_REACH_MAX, DIVE_REACH_MAX] —
    // close enough to trigger a dive, far enough not to be a plain dig. This is
    // an explicit stand point (contact + 2.8u offset away from the spawn side,
    // clamped in-bounds), NOT "chase toward contact and stop at 2.8": the M3.0a
    // drag-era serve is short enough that the diver's SPAWN can already be
    // INSIDE 2.8u of the contact (measured 1.58u), which parked the old chase in
    // plain-dig range and starved estimateDiveTouchServerTime of annulus points.
    // Read pendingLaunch fresh (not a snapshot taken once) since a net contact
    // before this point would have superseded it with the continuation (§1).
    const contact = reachableContact(pendingLaunch!, diverSide);
    let chased = false;
    if (contact) {
      const awayX = diver0.pos.x - contact.pos.x;
      const awayZ = diver0.pos.z - contact.pos.z;
      const awayLen = Math.hypot(awayX, awayZ);
      const deeperZ = diverSide === 'A' ? -1 : 1; // fallback: deeper on own half
      const ux = awayLen > 0.25 ? awayX / awayLen : 0;
      const uz = awayLen > 0.25 ? awayZ / awayLen : deeperZ;
      const standX = Math.max(-4.2, Math.min(4.2, contact.pos.x + ux * DIVE_TARGET_DISTANCE));
      const standZRaw = contact.pos.z + uz * DIVE_TARGET_DISTANCE;
      const standZ =
        diverSide === 'A' ? Math.max(-8.5, Math.min(-0.3, standZRaw)) : Math.max(0.3, Math.min(8.5, standZRaw));
      const contactClientTime = clientTimeForServerMappedTime(diverSync, contact.serverTime);
      const moveBudget = Math.max(200, Math.min(1600, contactClientTime - nowMs() - 200));
      diverSeq = await moveToward(
        diverRoom,
        diverRoom.sessionId,
        diverSide,
        () => latestSnapshot,
        standX,
        standZ,
        diverSeq,
        moveBudget,
        0.4,
      );
      chased = true;
    }

    // Schedule the dive touch at the ~2.8m trajectory point from the chased pos.
    // Re-read pendingLaunch here too: the chase above can take up to ~1.6s, long
    // enough for a net contact to chain a new launch mid-chase (§1).
    const diverNow = latestPlayer(latestSnapshot, diverRoom.sessionId);
    if (!diverNow) {
      throw new Error('diver snapshot missing after chase');
    }
    const target = estimateDiveTouchServerTime(pendingLaunch!, diverNow.pos);
    let plannedDistance = Number.NaN;
    let plannedBallY = Number.NaN;
    let resultSeen = false;
    if (target) {
      plannedDistance = target.distance;
      plannedBallY = target.ballY;
      const clientTime = clientTimeForServerMappedTime(diverSync, target.serverTime);
      await sleep(Math.max(0, clientTime - nowMs()));
      sendModeInput(diverRoom, diverSeq, 'dig');
      diverSeq += 1;
      void diverSeq;
      resultSeen = true;
      awaitingDiveResult = true;
      diverRoom.send(CH.TOUCH, makeTouchIntent(diverRoom.sessionId, clientTime, 'dig', 0));
    }

    await withTimeout(waitUntil(() => resultSeen && result !== undefined, 50, timeoutMs, 'dive touch result'), timeoutMs + 100, 'dive probe');

    const check = assertDiveOutcome(result);
    return {
      players,
      pass: check.pass,
      detail: `${check.detail}; plannedDistance=${plannedDistance.toFixed(3)} target=${DIVE_TARGET_DISTANCE.toFixed(1)} ballY=${plannedBallY.toFixed(3)} chased=${chased ? 'yes' : 'no'}`,
    };
  } catch (error) {
    return {
      players,
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (session) {
      await closeRooms(session.rooms);
    }
  }
}

function printDiveResult(result: DiveProbeResult): void {
  console.log(`dive players=${result.players} status=${result.pass ? 'PASS' : 'FAIL'} detail=${result.detail}`);
}

async function runWeakServeProbe(url: string, players: PlayerCount, timeoutMs: number): Promise<WeakServeProbeResult> {
  let session: LobbySession | undefined;

  try {
    session = await createLobby(url, players, timeoutMs);
    let latestSnapshot: StateSnapshot | undefined;
    let death: DeathEvent | undefined;
    let seq = 1;

    for (const room of session.rooms) {
      room.onMessage<StateSnapshot>(CH.SNAPSHOT, (snapshot) => {
        latestSnapshot = snapshot;
      });
      room.onMessage<DeathEvent>(CH.DEATH, (message) => {
        death = death ?? message;
      });
      room.onMessage<BallLaunch>(CH.BALL_LAUNCH, () => undefined);
      room.onMessage<TouchResult>(CH.TOUCH_RESULT, () => undefined);
    }

    await startLobbyMatch(session, timeoutMs, () => latestSnapshot?.phase === 'serve');
    await waitUntil(() => latestSnapshot?.servingId !== null, 50, timeoutMs, 'weak-serve serving player');

    const servingId = latestSnapshot?.servingId;
    const servingRoom = session.rooms.find((room) => room.sessionId === servingId);
    const servingPlayer = latestPlayer(latestSnapshot, servingId ?? '');
    if (!servingId || !servingRoom || !servingPlayer) {
      throw new Error('could not identify weak-serve server');
    }

    const receiverSide = oppositeSide(servingPlayer.side);
    sendModeInput(servingRoom, seq, 'spike');
    seq += 1;
    void seq;
    servingRoom.send(CH.TOUCH, makeTouchIntent(servingRoom.sessionId, nowMs(), 'spike', WEAK_SERVE_CHARGE));

    await withTimeout(waitUntil(() => death !== undefined, 50, timeoutMs, 'weak-serve death'), timeoutMs + 100, 'weak-serve probe');

    const pass = death?.scoringSide === receiverSide;
    return {
      players,
      pass,
      detail: `charge=${WEAK_SERVE_CHARGE.toFixed(2)} serverSide=${servingPlayer.side} receiverSide=${receiverSide} cause=${death?.cause ?? 'none'} scoringSide=${death?.scoringSide ?? 'none'} score=${death ? `${death.score.A}-${death.score.B}` : 'none'}`,
    };
  } catch (error) {
    return {
      players,
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (session) {
      await closeRooms(session.rooms);
    }
  }
}

function printWeakServeResult(result: WeakServeProbeResult): void {
  console.log(`weak-serve players=${result.players} status=${result.pass ? 'PASS' : 'FAIL'} detail=${result.detail}`);
}

interface ServePhaseStartCarrier {
  value: number;
  field: string;
  explicit: boolean;
}

const SERVE_PHASE_START_FIELD_CANDIDATES = [
  'servePhaseStartServerTime',
  'phaseStartServerTime',
  'serveStartServerTime',
  'serveStartedServerTime',
  'servePhaseStartTime',
  'phaseStartedServerTime',
];

function readNumberPath(value: unknown, path: string[]): number | undefined {
  let current: unknown = value;
  for (const part of path) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'number' && Number.isFinite(current) ? current : undefined;
}

function explicitServePhaseStart(snapshot: StateSnapshot): ServePhaseStartCarrier | undefined {
  // WP2 owns the exact wire carrier. Until that lands everywhere, poll the
  // plausible snapshot names defensively and fall back at the call site.
  for (const field of SERVE_PHASE_START_FIELD_CANDIDATES) {
    const value = readNumberPath(snapshot, [field]);
    if (value !== undefined) {
      return { value, field, explicit: true };
    }
  }

  const nestedCandidates: Array<[string, string[]]> = [
    ['serve.phaseStartServerTime', ['serve', 'phaseStartServerTime']],
    ['serve.startServerTime', ['serve', 'startServerTime']],
    ['phase.startServerTime', ['phase', 'startServerTime']],
  ];
  for (const [field, path] of nestedCandidates) {
    const value = readNumberPath(snapshot, path);
    if (value !== undefined) {
      return { value, field, explicit: true };
    }
  }

  return undefined;
}

// Mirror the SERVER authority (packages/server/src/sim/serveAim.ts
// serveHorizontalDir): "toward the net" = (0, forwardZ(side)) rotated about +Y
// by the protractor angle (three.js rotation.y), i.e. x = fz·sin, z = fz·cos —
// the SAME sign on both axes. NOT viewToWorld: that is the mirrored *movement*
// convention (right = -forwardZ), whose X is flipped vs the serve aim, so it
// only agrees at angle 0 and fails the probe at any real sweep angle.
function expectedServeHorizontalDirection(side: Side, angleDeg: number): { x: number; z: number } {
  const fz = forwardZ(side);
  const rad = (angleDeg * Math.PI) / 180;
  const x = fz * Math.sin(rad);
  const z = fz * Math.cos(rad);
  const len = Math.hypot(x, z) || 1;
  return { x: x / len, z: z / len };
}

function launchHorizontalDirection(launch: BallLaunch): { x: number; z: number } {
  const len = Math.hypot(launch.velocity.x, launch.velocity.z) || 1;
  return { x: launch.velocity.x / len, z: launch.velocity.z / len };
}

function angleBetweenXZ(a: { x: number; z: number }, b: { x: number; z: number }): number {
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.z * b.z));
  return (Math.acos(dot) * 180) / Math.PI;
}

async function runAngleProbe(
  url: string,
  players: PlayerCount,
  samples: number,
  timeoutMs: number,
): Promise<AngleProbeResult> {
  let session: LobbySession | undefined;

  try {
    session = await createLobby(url, players, timeoutMs);
    const syncs = await Promise.all(session.rooms.map((room) => startClockSync(room, samples)));
    let latestSnapshot: StateSnapshot | undefined;
    let servePhaseStart: ServePhaseStartCarrier | undefined;
    let launch: BallLaunch | undefined;
    let releaseServerTime = Number.NaN;
    let seq = 1;

    for (const room of session.rooms) {
      room.onMessage<StateSnapshot>(CH.SNAPSHOT, (snapshot) => {
        latestSnapshot = snapshot;
        if (snapshot.phase !== 'serve') {
          return;
        }
        const explicit = explicitServePhaseStart(snapshot);
        if (explicit) {
          servePhaseStart = explicit;
        } else if (!servePhaseStart) {
          servePhaseStart = {
            value: snapshot.serverTime,
            field: 'snapshot.serverTime(first observed serve snapshot fallback)',
            explicit: false,
          };
        }
      });
      room.onMessage<BallLaunch>(CH.BALL_LAUNCH, (message) => {
        if (message.arcType === 'serve') {
          launch = launch ?? message;
        }
      });
      room.onMessage<TouchResult>(CH.TOUCH_RESULT, () => undefined);
      room.onMessage(CH.DEATH, () => undefined);
    }

    await startLobbyMatch(session, timeoutMs, () => latestSnapshot?.phase === 'serve');
    await waitUntil(() => latestSnapshot?.servingId !== null && servePhaseStart !== undefined, 50, timeoutMs, 'angle serve setup');

    const servingId = latestSnapshot?.servingId;
    const servingIndex = session.rooms.findIndex((room) => room.sessionId === servingId);
    const servingRoom = servingIndex >= 0 ? session.rooms[servingIndex] : undefined;
    const servingSync = servingIndex >= 0 ? syncs[servingIndex] : undefined;
    const servingPlayer = latestPlayer(latestSnapshot, servingId ?? '');
    if (!servingId || !servingRoom || !servingSync || !servingPlayer || !servePhaseStart) {
      throw new Error('could not identify angle-probe server');
    }

    sendModeInput(servingRoom, seq, 'spike');
    seq += 1;
    void seq;
    const releaseClientTime = nowMs();
    releaseServerTime = serverMappedClientTime(servingSync, releaseClientTime);
    servingRoom.send(
      CH.TOUCH,
      makeTouchIntent(servingRoom.sessionId, releaseClientTime, 'spike', SERVE_IN_PLAY_CHARGE),
    );

    await withTimeout(waitUntil(() => launch !== undefined, 50, timeoutMs, 'angle serve launch'), timeoutMs + 100, 'angle probe');

    const serveLaunch = launch;
    if (!serveLaunch) {
      throw new Error('angle serve launch missing after wait');
    }

    const elapsedMs = releaseServerTime - servePhaseStart.value;
    const expectedAngle = sweepAngleDeg(elapsedMs);
    const expectedDir = expectedServeHorizontalDirection(servingPlayer.side, expectedAngle);
    const actualDir = launchHorizontalDirection(serveLaunch);
    const deltaDeg = angleBetweenXZ(expectedDir, actualDir);
    const pass = deltaDeg <= SERVE_ANGLE_TOLERANCE_DEG;

    return {
      players,
      pass,
      detail: `delta=${deltaDeg.toFixed(2)}deg tolerance=${SERVE_ANGLE_TOLERANCE_DEG}deg expectedAngle=${expectedAngle.toFixed(1)}deg side=${servingPlayer.side} carrier=${servePhaseStart.field}${servePhaseStart.explicit ? '' : ' (fallback; WP2 field not observed)'} charge=${SERVE_IN_PLAY_CHARGE.toFixed(2)}`,
    };
  } catch (error) {
    return {
      players,
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (session) {
      await closeRooms(session.rooms);
    }
  }
}

function printAngleResult(result: AngleProbeResult): void {
  console.log(`angle players=${result.players} status=${result.pass ? 'PASS' : 'FAIL'} detail=${result.detail}`);
}

/* ---- curve probe (M3.0a §8.8): spinning-launch dual-end consistency +
   curved-ball lag-comp no-skew ------------------------------------------- */

interface CurveProbeResult {
  players: PlayerCount;
  pass: boolean;
  detail: string;
}

interface CurveLagCompRun {
  latencyMs: number;
  angleDeg: number;
  expected: TouchGrade;
  actual: TouchGrade | 'NO_RESULT' | 'ERROR';
  accepted: boolean;
  serveOmegaMag: number;
  detail: string;
}

// Release the serve at a targeted sweep angle (0 = the deterministic center the
// other probes use; non-zero = the off-center release that carries sidespin).
async function releaseServeAtSweepAngle(
  servingRoom: RoomLike,
  servingSync: ClockSync,
  phaseStart: number,
  angleDeg: number,
  seq: number,
): Promise<number> {
  sendModeInput(servingRoom, seq, 'spike');
  const nowServer = serverMappedClientTime(servingSync, nowMs());
  const targetServerTime =
    angleDeg === 0
      ? nextSweepCenterServerTime(phaseStart, nowServer)
      : nextSweepAngleServerTime(phaseStart, nowServer, angleDeg);
  await sleep(Math.max(0, clientTimeForServerMappedTime(servingSync, targetServerTime) - nowMs()));
  servingRoom.send(CH.TOUCH, makeTouchIntent(servingRoom.sessionId, nowMs(), 'spike', SERVE_IN_PLAY_CHARGE));
  return seq + 1;
}

// Consistency case 1 — SIDESPIN SERVE: release at +30°, let the ball fly UNTOUCHED
// to its landing, then assert (a) the wire launch carries the promised sidespin
// signature, (b) the trajectory materially curved (Magnus shift vs a spin-free
// twin), and (c) the server's chain/landing positions equal the bot's local
// shared-flight rederivation.
async function runCurveServeCase(
  url: string,
  players: PlayerCount,
  samples: number,
  timeoutMs: number,
): Promise<CurveSubCheck> {
  let session: LobbySession | undefined;

  try {
    session = await createLobby(url, players, timeoutMs);
    const rooms = session.rooms;
    let latestSnapshot: StateSnapshot | undefined;
    const launches: BallLaunch[] = [];
    let death: DeathEvent | undefined;

    const host = session.host;
    host.onMessage<StateSnapshot>(CH.SNAPSHOT, (snapshot) => {
      latestSnapshot = snapshot;
    });
    host.onMessage<BallLaunch>(CH.BALL_LAUNCH, (launch) => {
      launches.push(launch);
    });
    host.onMessage<DeathEvent>(CH.DEATH, (message) => {
      death = death ?? message;
    });
    host.onMessage<TouchResult>(CH.TOUCH_RESULT, () => undefined);
    muteSnapshotsForIdleRooms(session, [host]);

    const syncs = await Promise.all(rooms.map((room) => startClockSync(room, samples)));
    await startLobbyMatch(session, timeoutMs, () => latestSnapshot?.phase === 'serve');
    await waitUntil(
      () => latestSnapshot?.servingId != null && latestSnapshot?.servePhaseStartServerTime != null,
      50,
      timeoutMs,
      'curve serve setup',
    );

    const servingId = latestSnapshot!.servingId!;
    const servingIndex = rooms.findIndex((room) => room.sessionId === servingId);
    const servingRoom = servingIndex >= 0 ? rooms[servingIndex] : undefined;
    const servingSync = servingIndex >= 0 ? syncs[servingIndex] : undefined;
    if (!servingRoom || !servingSync) {
      throw new Error('could not identify curve-probe serving room');
    }

    await releaseServeAtSweepAngle(
      servingRoom,
      servingSync,
      latestSnapshot!.servePhaseStartServerTime!,
      CURVE_SERVE_ANGLE_DEG,
      1,
    );
    await withTimeout(
      waitUntil(() => death !== undefined, 50, timeoutMs, 'curve serve death'),
      timeoutMs + 100,
      'curve serve case',
    );

    const serveLaunch = launches.find((launch) => launch.arcType === 'serve' && !launch.isNetTouch);
    if (!serveLaunch) {
      return { pass: false, detail: 'serve-consistency: no serve BallLaunch observed' };
    }

    const band = serveSpinBand(CURVE_SERVE_ANGLE_DEG);
    const spin = assertSpinSignature('serve sidespin', serveLaunch, {
      minMag: band.min,
      maxMag: band.max,
      axis: 'vertical',
      requirePositiveY: true,
    });
    if (!spin.pass) return spin;

    const shiftCm = magnusShiftOf(serveLaunch) * 100;
    if (shiftCm < CURVE_MIN_LANDING_SHIFT * 100) {
      return {
        pass: false,
        detail: `serve-consistency: Magnus landing shift ${shiftCm.toFixed(1)}cm < ${(CURVE_MIN_LANDING_SHIFT * 100).toFixed(0)}cm — ball did not actually curve`,
      };
    }

    const chain = assertChainConsistency('serve-consistency', launches, death!.landing, death!.cause);
    if (!chain.pass) return chain;
    return { pass: true, detail: `${spin.detail}; magnusShift=${shiftCm.toFixed(0)}cm; ${chain.detail}` };
  } catch (error) {
    return { pass: false, detail: `serve-consistency: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (session) {
      await closeRooms(session.rooms);
    }
  }
}

// Consistency case 2 — TOPSPIN SPIKE: straight serve to the receiver, who chases
// and returns it with a charged SPIKE at the ideal moment; the spike launch must
// carry horizontal topspin, materially curve (Magnus presses it down), and the
// whole chain (serve → spike origin → landing) must rederive locally.
async function runCurveSpikeCase(
  url: string,
  players: PlayerCount,
  samples: number,
  timeoutMs: number,
): Promise<CurveSubCheck> {
  let session: LobbySession | undefined;

  try {
    session = await createLobby(url, players, timeoutMs);
    const serverRoom = requireRoom(session, 0, 'server');
    const testedRoom = requireRoom(session, 1, 'spiker');
    muteSnapshotsForIdleRooms(session, [serverRoom, testedRoom]);

    let latestSnapshot: StateSnapshot | undefined;
    const launches: BallLaunch[] = [];
    let result: TouchResult | undefined;
    let awaitingSpikeResult = false;
    let death: DeathEvent | undefined;
    let testedSeq = 1;

    testedRoom.onMessage<StateSnapshot>(CH.SNAPSHOT, (snapshot) => {
      latestSnapshot = snapshot;
    });
    testedRoom.onMessage<BallLaunch>(CH.BALL_LAUNCH, (launch) => {
      launches.push(launch);
    });
    testedRoom.onMessage<TouchResult>(CH.TOUCH_RESULT, (message) => {
      if (awaitingSpikeResult && message.playerId === testedRoom.sessionId) {
        result = result ?? message;
      }
    });
    testedRoom.onMessage<DeathEvent>(CH.DEATH, (message) => {
      death = death ?? message;
    });
    serverRoom.onMessage<StateSnapshot>(CH.SNAPSHOT, () => undefined);
    serverRoom.onMessage<BallLaunch>(CH.BALL_LAUNCH, () => undefined);
    serverRoom.onMessage<TouchResult>(CH.TOUCH_RESULT, () => undefined);
    serverRoom.onMessage(CH.DEATH, () => undefined);

    const [serverSync, testedSync] = await Promise.all([
      startClockSync(serverRoom, samples),
      startClockSync(testedRoom, samples),
    ]);

    await startLobbyMatch(session, timeoutMs, () => latestSnapshot?.phase === 'serve');
    await waitUntil(
      () => latestSnapshot?.servingId != null && latestSnapshot?.servePhaseStartServerTime != null,
      50,
      timeoutMs,
      'curve spike serve setup',
    );
    if (latestSnapshot?.servingId !== serverRoom.sessionId) {
      throw new Error(`expected rooms[0] to serve (got servingId=${latestSnapshot?.servingId})`);
    }

    // Straight serve (sweep center) so the chase is deterministic; the CURVE in
    // this case comes from the receiver's topspin spike return.
    await releaseServeAtSweepAngle(serverRoom, serverSync, latestSnapshot.servePhaseStartServerTime!, 0, 1);
    const latestServeLaunch = (): BallLaunch | undefined => {
      for (let i = launches.length - 1; i >= 0; i -= 1) {
        if (launches[i]!.arcType === 'serve') return launches[i];
      }
      return undefined;
    };
    await withTimeout(
      waitUntil(() => latestServeLaunch() !== undefined, 50, timeoutMs, 'curve spike serve launch'),
      timeoutMs + 100,
      'curve spike launch',
    );

    const receiver0 = latestPlayer(latestSnapshot, testedRoom.sessionId);
    if (!receiver0) {
      throw new Error('spiker snapshot missing before chase');
    }
    const receiverSide = receiver0.side;

    const contact = reachableContact(latestServeLaunch()!, receiverSide);
    if (contact) {
      const contactClientTime = clientTimeForServerMappedTime(testedSync, contact.serverTime);
      const moveBudget = Math.max(200, Math.min(1600, contactClientTime - nowMs() - 200));
      testedSeq = await moveToward(
        testedRoom,
        testedRoom.sessionId,
        receiverSide,
        () => latestSnapshot,
        contact.pos.x,
        contact.pos.z,
        testedSeq,
        moveBudget,
        0.5,
      );
    }

    // Switch the authoritative mode to spike NOW (≥200ms before the touch, per the
    // chase budget's reserve) so the server has consumed the INPUT frame by then.
    sendModeInput(testedRoom, testedSeq, 'spike');
    testedSeq += 1;
    void testedSeq;

    const receiverNow = latestPlayer(latestSnapshot, testedRoom.sessionId);
    if (!receiverNow) {
      throw new Error('spiker snapshot missing after chase');
    }
    const idealServerTime = estimateIdealTouchServerTime(latestServeLaunch()!, receiverNow.pos);
    if (idealServerTime === null) {
      return { pass: false, detail: 'spike-consistency: no reachable contact point on the served trajectory' };
    }
    const planned = planTouch(idealServerTime, 0, testedSync);
    await sleep(Math.max(0, planned.clientTime - nowMs()));

    awaitingSpikeResult = true;
    testedRoom.send(CH.TOUCH, makeTouchIntent(testedRoom.sessionId, planned.clientTime, 'spike', CURVE_SPIKE_CHARGE));

    await withTimeout(
      waitUntil(() => result !== undefined, 50, timeoutMs, 'curve spike touch result'),
      timeoutMs + 100,
      'curve spike result',
    );
    if (result?.accepted !== true) {
      return {
        pass: false,
        detail: `spike-consistency: spike touch not accepted (grade=${result?.grade} outcome=${String(result?.outcome)})`,
      };
    }
    await withTimeout(
      waitUntil(() => death !== undefined, 50, timeoutMs, 'curve spike death'),
      timeoutMs + 100,
      'curve spike death',
    );

    const spikeLaunch = launches.find((launch) => launch.arcType === 'spike' && !launch.isNetTouch);
    if (!spikeLaunch) {
      return { pass: false, detail: 'spike-consistency: no spike BallLaunch observed after accepted spike touch' };
    }

    const spin = assertSpinSignature('spike topspin', spikeLaunch, {
      minMag: CURVE_SPIKE_MIN_OMEGA,
      maxMag: SPIN_MAX + 0.1,
      axis: 'horizontal',
    });
    if (!spin.pass) return spin;

    const shiftCm = magnusShiftOf(spikeLaunch) * 100;
    if (shiftCm < CURVE_MIN_LANDING_SHIFT * 100) {
      return {
        pass: false,
        detail: `spike-consistency: Magnus landing shift ${shiftCm.toFixed(1)}cm < ${(CURVE_MIN_LANDING_SHIFT * 100).toFixed(0)}cm — spike did not actually curve`,
      };
    }

    const chain = assertChainConsistency('spike-consistency', launches, death!.landing, death!.cause);
    if (!chain.pass) return chain;
    return {
      pass: true,
      detail: `${spin.detail} (grade=${result.grade}); magnusShift=${shiftCm.toFixed(0)}cm; ${chain.detail}`,
    };
  } catch (error) {
    return { pass: false, detail: `spike-consistency: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (session) {
      await closeRooms(session.rooms);
    }
  }
}

// One lag-comp run: serve at `angleDeg` (0 = straight baseline), receiver under
// `latencyMs` simulated outbound delay chases and digs at the IDEAL moment
// (offset 0). Mirrors the matrix scenario except for the parameterized release
// angle + captured serve |ω|. Deliberately a separate function: the matrix probe
// is a shipped gate and stays byte-identical.
async function runCurveLagCompScenario(
  url: string,
  players: PlayerCount,
  angleDeg: number,
  latencyMs: number,
  samples: number,
  timeoutMs: number,
): Promise<CurveLagCompRun> {
  let session: LobbySession | undefined;
  let expected: TouchGrade = gradeOf(0);
  let serveOmegaMag = Number.NaN;

  try {
    session = await createLobby(url, players, timeoutMs);
    const serverRoom = requireRoom(session, 0, 'server');
    const testedRoom = requireRoom(session, 1, 'tested receiver');
    muteSnapshotsForIdleRooms(session, [serverRoom, testedRoom]);
    const outbound = wrapOutboundLatency(testedRoom, latencyMs);

    let latestSnapshot: StateSnapshot | undefined;
    let pendingLaunch: BallLaunch | undefined;
    let result: TouchResult | undefined;
    let awaitingRallyTouchResult = false;
    let testedSeq = 1;

    testedRoom.onMessage<StateSnapshot>(CH.SNAPSHOT, (snapshot) => {
      latestSnapshot = snapshot;
    });
    testedRoom.onMessage<TouchResult>(CH.TOUCH_RESULT, (message) => {
      if (!awaitingRallyTouchResult) return;
      result = result ?? message;
    });
    testedRoom.onMessage<BallLaunch>(CH.BALL_LAUNCH, (launch) => {
      // Track the latest serve-arc launch (a net contact chains a continuation —
      // same rule as the matrix/dive probes) and remember the ORIGINAL launch's
      // |ω| for the curved-vs-straight bookkeeping.
      if (launch.arcType === 'serve') {
        if (!launch.isNetTouch && !Number.isFinite(serveOmegaMag)) {
          serveOmegaMag = vmag(launch.omega);
        }
        pendingLaunch = launch;
      }
    });
    testedRoom.onMessage(CH.DEATH, () => undefined);
    serverRoom.onMessage<StateSnapshot>(CH.SNAPSHOT, () => undefined);
    serverRoom.onMessage<BallLaunch>(CH.BALL_LAUNCH, () => undefined);
    serverRoom.onMessage<TouchResult>(CH.TOUCH_RESULT, () => undefined);
    serverRoom.onMessage(CH.DEATH, () => undefined);

    const [serverSync, testedSync] = await Promise.all([
      startClockSync(serverRoom, samples),
      startClockSync(testedRoom, samples),
    ]);

    await startLobbyMatch(session, timeoutMs, () => latestSnapshot?.phase === 'serve');
    await waitUntil(
      () => latestSnapshot?.servingId != null && latestSnapshot?.servePhaseStartServerTime != null,
      50,
      timeoutMs,
      'curve lag-comp serve setup',
    );
    if (latestSnapshot?.servingId !== serverRoom.sessionId) {
      throw new Error(`expected rooms[0] to serve (got servingId=${latestSnapshot?.servingId})`);
    }

    await releaseServeAtSweepAngle(serverRoom, serverSync, latestSnapshot.servePhaseStartServerTime!, angleDeg, 1);
    await withTimeout(
      waitUntil(() => pendingLaunch !== undefined, 50, timeoutMs, 'curve lag-comp serve launch'),
      timeoutMs + 100,
      'curve lag-comp launch',
    );

    const receiver0 = latestPlayer(latestSnapshot, testedRoom.sessionId);
    if (!receiver0) {
      throw new Error('tested receiver snapshot missing before chase');
    }
    const receiverSide = receiver0.side;

    // Chase with the delay dropped (movement is not what is graded — matrix rule),
    // restore it right before the graded ideal-moment touch.
    outbound.setDelayMs(0);
    const contact = reachableContact(pendingLaunch!, receiverSide);
    let chased = false;
    if (contact) {
      const contactClientTime = clientTimeForServerMappedTime(testedSync, contact.serverTime);
      const moveBudget = Math.max(200, Math.min(1600, contactClientTime - nowMs() - 200));
      testedSeq = await moveToward(
        testedRoom,
        testedRoom.sessionId,
        receiverSide,
        () => latestSnapshot,
        contact.pos.x,
        contact.pos.z,
        testedSeq,
        moveBudget,
        0.5,
      );
      chased = true;
    }
    outbound.setDelayMs(latencyMs);

    const receiverNow = latestPlayer(latestSnapshot, testedRoom.sessionId);
    if (!receiverNow) {
      throw new Error('tested receiver snapshot missing after chase');
    }
    const idealServerTime = estimateIdealTouchServerTime(pendingLaunch!, receiverNow.pos);
    if (idealServerTime === null) {
      return {
        latencyMs,
        angleDeg,
        expected,
        actual: 'NO_RESULT',
        accepted: false,
        serveOmegaMag,
        detail: `no reachable contact point (chased=${chased ? 'yes' : 'no'})`,
      };
    }

    const planned = planTouch(idealServerTime, 0, testedSync);
    expected = planned.expectedGrade;
    await sleep(Math.max(0, planned.clientTime - nowMs()));

    awaitingRallyTouchResult = true;
    sendModeInput(testedRoom, testedSeq, 'dig');
    testedSeq += 1;
    testedRoom.send(CH.TOUCH, makeTouchIntent(testedRoom.sessionId, planned.clientTime));

    await withTimeout(
      waitUntil(() => result !== undefined, 50, timeoutMs, 'curve lag-comp touch result'),
      timeoutMs + 100,
      'curve lag-comp scenario',
    );

    return {
      latencyMs,
      angleDeg,
      expected,
      actual: result?.grade ?? 'NO_RESULT',
      accepted: result?.accepted === true,
      serveOmegaMag,
      detail: `effectiveDelta=${planned.effectiveDeltaMs.toFixed(1)}ms rtt=${testedSync.rttMs.toFixed(1)}ms chased=${chased ? 'yes' : 'no'}`,
    };
  } catch (error) {
    return {
      latencyMs,
      angleDeg,
      expected,
      actual: 'ERROR',
      accepted: false,
      serveOmegaMag,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (session) {
      await closeRooms(session.rooms);
    }
  }
}

async function runCurveProbe(
  url: string,
  players: PlayerCount,
  samples: number,
  timeoutMs: number,
): Promise<CurveProbeResult> {
  const checks: CurveSubCheck[] = [];
  checks.push(await runCurveServeCase(url, players, samples, timeoutMs));
  checks.push(await runCurveSpikeCase(url, players, samples, timeoutMs));

  // Lag-comp no-skew: at every latency, an ideal-moment touch on the CURVED serve
  // must grade exactly like the STRAIGHT baseline (and both must be the planned
  // PERFECT — the known ~latency/2 skew only afflicts deliberately offset touches,
  // testing.md §4, so any curvature-correlated deviation here is a real bug).
  const lagLines: string[] = [];
  let lagPass = true;
  for (const latencyMs of CURVE_LAGCOMP_LATENCIES) {
    const curved = await runCurveLagCompScenario(url, players, CURVE_LAGCOMP_ANGLE_DEG, latencyMs, samples, timeoutMs);
    const straight = await runCurveLagCompScenario(url, players, 0, latencyMs, samples, timeoutMs);
    const spinOk =
      curved.serveOmegaMag >= CURVE_LAGCOMP_MIN_OMEGA &&
      curved.serveOmegaMag <= serveSpinBand(CURVE_LAGCOMP_ANGLE_DEG).max &&
      straight.serveOmegaMag <= CURVE_STRAIGHT_MAX_OMEGA;
    const bothAccepted = curved.accepted && straight.accepted;
    const noSkew = curved.actual === straight.actual;
    const bothIdeal = curved.actual === curved.expected && straight.actual === straight.expected;
    const ok = spinOk && bothAccepted && noSkew && bothIdeal;
    lagPass = lagPass && ok;
    lagLines.push(
      `lat=${latencyMs}ms curved=${curved.actual}(|ω|=${curved.serveOmegaMag.toFixed(1)}) ` +
        `straight=${straight.actual}(|ω|=${straight.serveOmegaMag.toFixed(1)}) ${ok ? 'ok' : 'FAIL'}` +
        (ok ? '' : ` [spinOk=${spinOk} accepted=${bothAccepted} noSkew=${noSkew} ideal=${bothIdeal}; curved: ${curved.detail}; straight: ${straight.detail}]`),
    );
  }
  checks.push({ pass: lagPass, detail: `lag-comp ideal-touch no-skew: ${lagLines.join(' | ')}` });

  const pass = checks.every((check) => check.pass);
  return {
    players,
    pass,
    detail: checks.map((check) => `[${check.pass ? 'ok' : 'FAIL'}] ${check.detail}`).join(' ;; '),
  };
}

function printCurveResult(result: CurveProbeResult): void {
  console.log(`curve players=${result.players} status=${result.pass ? 'PASS' : 'FAIL'} detail=${result.detail}`);
}

function assertSelf(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`self-test failed: ${message}`);
  }
}

function syntheticJumpArc(holdFrames: number, sampleMs: number): JumpArcSample[] {
  const samples: JumpArcSample[] = [{ serverTime: 10_000, y: 0 }];
  let state = startJump();
  const totalFrames = Math.ceil(sampleMs / TICK_MS);

  for (let frame = 0; frame < totalFrames; frame += 1) {
    state = stepJump(state, TICK_MS / 1000, frame < holdFrames);
    samples.push({ serverTime: 10_000 + (frame + 1) * TICK_MS, y: state.y });
  }

  return samples;
}

function runSelfTest(): void {
  const sync: ClockSync = { offsetMs: 1000, rttMs: 120, samples: 5 };
  const ideal = 5000;
  const planned = planTouch(ideal, 0, sync);
  assertSelf(Math.abs(planned.effectiveDeltaMs) < 0.001, 'planned zero-offset touch maps to ideal server time');
  assertSelf(Math.abs(inferredServerClockOffset(sync) - 1060) < 0.001, 'server clock offset inference');

  const arc: JumpArcSample[] = [];
  const v0 = JUMP_V0;
  const start = 10_000;
  for (let elapsedMs = 0; elapsedMs <= 800; elapsedMs += TICK_MS) {
    const t = elapsedMs / 1000;
    const y = Math.max(0, v0 * t - 0.5 * JUMP_GRAVITY * t * t);
    arc.push({ serverTime: start + elapsedMs, y });
  }
  const goodArc = assertJumpArc(arc);
  assertSelf(goodArc.pass, `valid synthetic jump arc rejected: ${goodArc.detail}`);

  const teleportArc = arc.map((sample, index) => ({
    ...sample,
    y: index === 3 ? sample.y + 5 : sample.y,
  }));
  assertSelf(!assertJumpArc(teleportArc).pass, 'teleport arc accepted');

  const nonMonotonicArc = arc.map((sample, index) => ({
    ...sample,
    y: index === 4 ? sample.y - 0.5 : sample.y,
  }));
  assertSelf(!assertJumpArc(nonMonotonicArc).pass, 'non-monotonic arc accepted');

  const shortHoldFrames = 2;
  const fullHoldFrames = Math.ceil((JUMP_BOOST_MAX_S * 1000) / TICK_MS);
  const syntheticShort = assertJumpArc(syntheticJumpArc(shortHoldFrames, JUMP_ARC_SAMPLE_MS));
  const syntheticFull = assertJumpArc(syntheticJumpArc(fullHoldFrames, JUMP_ARC_SAMPLE_MS));
  const comparison = assertApexComparison(syntheticShort, syntheticFull);
  assertSelf(comparison.pass, `synthetic short/full apex comparison failed: ${comparison.detail}`);

  const diveSuccess: TouchResult = {
    playerId: 'bot',
    accepted: true,
    quality: 0.35,
    grade: 'PERFECT',
    serverTime: 100,
    outcome: 'dive_success',
  };
  const diveWithoutOutcome: TouchResult = {
    playerId: 'bot',
    accepted: false,
    quality: 0,
    grade: 'WHIFF',
    serverTime: 100,
  };
  assertSelf(assertDiveOutcome(diveSuccess).pass, 'dive_success outcome rejected');
  assertSelf(!assertDiveOutcome(diveWithoutOutcome).pass, 'missing dive outcome accepted');

  const sideAZero = expectedServeHorizontalDirection('A', 0);
  const sideBZero = expectedServeHorizontalDirection('B', 0);
  assertSelf(Math.abs(sideAZero.z - 1) < 0.001, 'side A zero-angle serve points toward +Z');
  assertSelf(Math.abs(sideBZero.z + 1) < 0.001, 'side B zero-angle serve points toward -Z');
  // Non-zero angle locks the aim to the SERVER authority (x = fz·sin): +angle
  // sweeps toward the server's +X on side A and toward -X on side B. This is the
  // assertion the prior viewToWorld-based expected direction failed (mirror bug).
  const sideA45 = expectedServeHorizontalDirection('A', 45);
  const sideB45 = expectedServeHorizontalDirection('B', 45);
  assertSelf(sideA45.x > 0.5, 'side A +45 serve sweeps toward +X (matches serveHorizontalDir)');
  assertSelf(sideB45.x < -0.5, 'side B +45 serve sweeps toward -X (matches serveHorizontalDir)');
  assertSelf(Math.abs(sweepAngleDeg(0) + 90) < 0.001, 'serve sweep starts at -90 degrees');

  // ---- curve probe helpers (no server needed) ----
  assertSelf(Math.abs(nextSweepAngleServerTime(0, 0, 0) - 400) < 1e-9, 'angle-0 rising edge occurs at +400ms');
  const t30 = nextSweepAngleServerTime(0, 0, 30);
  assertSelf(Math.abs(sweepAngleDeg(t30)) - 30 < 1e-6 && Math.abs(sweepAngleDeg(t30) - 30) < 1e-6, 'targeted sweep time maps back to +30 degrees');
  const t30Future = nextSweepAngleServerTime(0, 5000, 30);
  assertSelf(t30Future > 5000 && Math.abs(sweepAngleDeg(t30Future) - 30) < 1e-6, 'future occurrence stays on the +30 rising edge');

  // Synthetic sidespin serve (side-L world ω = +Y): the probe's own rederivation
  // must agree with itself, a 20cm-perturbed landing must fail, and Magnus must
  // shift the landing materially vs the spin-free twin.
  const spinningLaunch: BallLaunch = {
    origin: { x: 0, y: 1.7, z: -7 },
    velocity: { x: 0, y: 6.5, z: 7.8 }, // lofted enough to clear the 2.43 net
    omega: { x: 0, y: 6.7, z: 0 },
    arcType: 'serve',
    quality: 1,
    gravity: GRAVITY,
    serverTime: 1000,
    rngSeed: 1,
  };
  const localEv = firstEvent(spinningLaunch, CURVE_HORIZON_MS);
  assertSelf(localEv.kind === 'ground' || localEv.kind === 'out', `synthetic spinning serve lands (got ${localEv.kind})`);
  const landingCause = localEv.kind as DeathEvent['cause'];
  const selfChain = assertChainConsistency('self', [spinningLaunch], localEv.pos, landingCause);
  assertSelf(selfChain.pass, `chain consistency on own rederivation rejected: ${selfChain.detail}`);
  const driftedLanding = { x: localEv.pos.x + 0.2, y: localEv.pos.y, z: localEv.pos.z };
  assertSelf(!assertChainConsistency('self', [spinningLaunch], driftedLanding, landingCause).pass, '20cm-drifted landing accepted');
  assertSelf(magnusShiftOf(spinningLaunch) >= CURVE_MIN_LANDING_SHIFT, 'sidespin launch lacks a material Magnus landing shift');

  // Two-launch chain: a continuation whose origin sits ON the first trajectory
  // passes the link check; a 20cm-off origin fails it.
  const mid = ballPosition(spinningLaunch, 500);
  const chainedLaunch: BallLaunch = {
    ...spinningLaunch,
    origin: mid,
    omega: { x: 0, y: 3.35, z: 0 },
    serverTime: 1500,
    isNetTouch: true,
  };
  const chainedEv = firstEvent(chainedLaunch, CURVE_HORIZON_MS);
  const goodChain = assertChainConsistency('self', [spinningLaunch, chainedLaunch], chainedEv.pos, chainedEv.kind as DeathEvent['cause']);
  assertSelf(goodChain.pass, `on-trajectory chain link rejected: ${goodChain.detail}`);
  const badLink: BallLaunch = { ...chainedLaunch, origin: { x: mid.x + 0.2, y: mid.y, z: mid.z } };
  assertSelf(
    !assertChainConsistency('self', [spinningLaunch, badLink], firstEvent(badLink, CURVE_HORIZON_MS).pos, 'ground').pass,
    '20cm-off chain link accepted',
  );

  // Spin signatures: sidespin is vertical +Y; topspin is horizontal; cross-reject.
  assertSelf(
    assertSpinSignature('self side-L', spinningLaunch, { minMag: 4, maxMag: 9, axis: 'vertical', requirePositiveY: true }).pass,
    'valid sidespin signature rejected',
  );
  assertSelf(
    !assertSpinSignature('self cross', spinningLaunch, { minMag: 4, maxMag: 9, axis: 'horizontal' }).pass,
    'vertical ω accepted as topspin',
  );
  const topLaunch: BallLaunch = { ...spinningLaunch, omega: { x: 31.5, y: 0, z: 0 } };
  assertSelf(
    assertSpinSignature('self top', topLaunch, { minMag: CURVE_SPIKE_MIN_OMEGA, maxMag: SPIN_MAX + 0.1, axis: 'horizontal' }).pass,
    'valid topspin signature rejected',
  );
  const band30 = serveSpinBand(30);
  assertSelf(band30.min < (30 / 90) * SERVE_SIDESPIN_MAX && band30.max > (30 / 90) * SERVE_SIDESPIN_MAX, 'serve spin band straddles the nominal rate');

  console.log('self-test PASS: clock mapping, jump arc/apex, dive outcome, serve-angle, and curve-probe helpers');
}

async function runMatrix(options: CliOptions): Promise<boolean> {
  const results: ScenarioResult[] = [];
  for (const latencyMs of options.latencies) {
    for (const offsetMs of options.offsets) {
      results.push(
        await runScenario(options.url, options.players, latencyMs, offsetMs, options.samples, options.timeoutMs),
      );
    }
  }

  printResults(results);
  return results.every((row) => row.pass);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv);
  assertFiniteList(options.latencies, '--latencies');
  assertFiniteList(options.offsets, '--offsets');
  assertFiniteList([options.samples], '--samples');
  assertFiniteList([options.timeoutMs], '--timeout');
  assertFiniteList([options.shortJumpFrames], '--short-jump-frames');
  assertFiniteList([options.fullJumpHoldMs], '--full-jump-hold-ms');

  if (options.selfTest) {
    runSelfTest();
    return;
  }

  let ok = true;
  if (options.probe === 'all' || options.probe === 'matrix') {
    ok = (await runMatrix(options)) && ok;
  }

  if (options.probe === 'all' || options.probe === 'jump-arc') {
    const jumpResult = await runJumpArcProbe(
      options.url,
      options.players,
      options.shortJumpFrames,
      options.fullJumpHoldMs,
      options.timeoutMs,
    );
    printJumpArcResult(jumpResult);
    ok = jumpResult.pass && ok;
  }

  if (options.probe === 'all' || options.probe === 'dive') {
    const diveResult = await runDiveProbe(options.url, options.players, options.samples, options.timeoutMs);
    printDiveResult(diveResult);
    ok = diveResult.pass && ok;
  }

  if (options.probe === 'all' || options.probe === 'weak-serve') {
    const weakServeResult = await runWeakServeProbe(options.url, options.players, options.timeoutMs);
    printWeakServeResult(weakServeResult);
    ok = weakServeResult.pass && ok;
  }

  if (options.probe === 'all' || options.probe === 'angle') {
    const angleResult = await runAngleProbe(options.url, options.players, options.samples, options.timeoutMs);
    printAngleResult(angleResult);
    ok = angleResult.pass && ok;
  }

  if (options.probe === 'all' || options.probe === 'curve') {
    const curveResult = await runCurveProbe(options.url, options.players, options.samples, options.timeoutMs);
    printCurveResult(curveResult);
    ok = curveResult.pass && ok;
  }

  if (!ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
