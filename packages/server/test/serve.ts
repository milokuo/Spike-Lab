// M2.3 WP2 deterministic unit tests — no network, no Colyseus. Exercises the
// REAL server modules (MatchSim.serve, applyInput, serveHorizontalDir) so the
// angle-sweep serve, jump serve, weak-serve death, yaw movement and the serve
// grounded clamp are verified bit-for-bit and instantly.
//
// Run: `npx tsx test/serve.ts`.
import {
  firstEvent,
  ballPosition,
  ballVelocity,
  resolveNetCollision,
  sweepAngleDeg,
  SERVE_BASE_SPEED,
  SERVE_JUMP_SPEED_MULT,
  SERVE_QUALITY_GROUND,
  SERVE_QUALITY_JUMP,
  COURT_HALF_LENGTH,
  BACK_BOUND_Z,
  GRAVITY,
  NET_TOP,
  NET_CONTACT_EPS,
  TICK_MS,
  OVERCHARGE_MAX,
  chargeDistanceMult,
  overchargeQualityMult,
  type BallLaunch,
  type InputFrame,
  type Side,
  type TouchIntent,
} from '@spike/shared';
import { MatchSim } from '../src/rooms/matchSim';
import { serveHorizontalDir } from '../src/sim/serveAim';
import type { PlayerState } from '../src/rooms/schema/PlayerState';
import { applyInput } from '../src/sim/movement';
import { resolveDeath } from '../src/game/rally';
import { parseTouch } from '../src/net/validate';
import { BallRingBuffer, PlayerHistory } from '../src/sim/ballRingBuffer';
import { ClockSync } from '../src/sim/clockSync';
import { adjudicateTouch } from '../src/sim/lagComp';

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  PASS  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
const approx = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

// A minimal player row — MatchSim.serve only reads id/x/y/z/side.
function player(side: Side, x: number, z: number, y = 0): PlayerState {
  return { id: 'srv', side, x, y, z } as unknown as PlayerState;
}
function intent(charge: number, clientTime: number): TouchIntent {
  return { playerId: 'srv', clientTime, mode: 'spike', charge, dirInput: { x: 0, y: 0 } };
}
// A MatchSim whose clock offset for 'srv' is 0, so toServerTime(ct) === ct
// (release time is fully controllable via intent.clientTime).
function simWithZeroOffset(): MatchSim {
  const sim = new MatchSim();
  sim.observePing('srv', 1000, 1000); // serverRecv - clientTime = 0
  return sim;
}

// M3.0a — buildBallLaunch now emits the NOMINAL velocity (unit dir × baseSpeed ×
// chargeMult, no scatter/heightFactor); a non-overcharged serve (charge ≤ 1) has
// fidelity f=1, an exact identity. So |velocity| == baseSpeed·chargeMult directly.
function recoverSpeed(l: BallLaunch): number {
  return Math.hypot(l.velocity.x, l.velocity.y, l.velocity.z);
}

// The serve's horizontal unit aim. With no scatter (and f=1 for charge ≤ 1) this
// is exactly serveHorizontalDir(side, angle) — normalize the horizontal velocity.
function recoverHorizAim(l: BallLaunch): { x: number; z: number } {
  const len = Math.hypot(l.velocity.x, l.velocity.z) || 1;
  return { x: l.velocity.x / len, z: l.velocity.z / len };
}

function testGroundVsJump(): void {
  console.log('\n[serve] ground vs jump (§3.3)');
  const charge = 0.85;
  const ps = 1000; // phase start
  // Release at elapsed 400 => sweep angle 0 => straight at the net.
  const ct = ps + 400;

  const ground = simWithZeroOffset().serve(player('A', 0, -COURT_HALF_LENGTH - 0.8, 0), intent(charge, ct), ps);
  assert(ground.isJump === false, 'grounded server (y=0) => ground serve');
  assert(approx(ground.launch.origin.y, 1.5), `ground origin height = SERVE_HAND_HEIGHT (${ground.launch.origin.y})`);
  assert(approx(ground.launch.quality, SERVE_QUALITY_GROUND), `ground serve quality = ${SERVE_QUALITY_GROUND}`);
  assert(!ground.launch.isJumpServe, `ground serve BallLaunch.isJumpServe is falsy (${ground.launch.isJumpServe})`);

  const jumpY = 1.0;
  const jump = simWithZeroOffset().serve(player('A', 0, -COURT_HALF_LENGTH - 0.8, jumpY), intent(charge, ct), ps);
  assert(jump.isJump === true, 'airborne server (y=1.0) => jump serve');
  assert(approx(jump.launch.origin.y, 1.5 + jumpY), `jump origin height = SERVE_HAND_HEIGHT + jumpY (${jump.launch.origin.y})`);
  assert(approx(jump.launch.quality, SERVE_QUALITY_JUMP), `jump serve quality = ${SERVE_QUALITY_JUMP}`);
  assert(jump.launch.isJumpServe === true, `jump serve BallLaunch.isJumpServe === true (${jump.launch.isJumpServe})`);

  const gSpeed = recoverSpeed(ground.launch);
  const jSpeed = recoverSpeed(jump.launch);
  assert(approx(gSpeed, SERVE_BASE_SPEED * chargeDistanceMult(charge), 1e-4), `ground speed = base·chargeMult (${gSpeed.toFixed(3)})`);
  assert(approx(jSpeed / gSpeed, SERVE_JUMP_SPEED_MULT, 1e-4), `jump speed = ground × ${SERVE_JUMP_SPEED_MULT} (ratio ${(jSpeed / gSpeed).toFixed(4)})`);
}

function testAngleDeterminism(): void {
  console.log('\n[serve] angle determinism — aim = sweepAngleDeg(release − phaseStart) (§3.1)');
  const ps = 5000;
  for (const elapsed of [400, 250, 950, 1200, 700]) {
    const l = simWithZeroOffset().serve(player('A', 0, -9.8, 0), intent(0.85, ps + elapsed), ps).launch;
    const expectedAngle = sweepAngleDeg(elapsed);
    const expectedDir = serveHorizontalDir('A', expectedAngle);
    const gotDir = recoverHorizAim(l);
    const ok = approx(gotDir.x, expectedDir.x, 1e-6) && approx(gotDir.z, expectedDir.z, 1e-6);
    assert(ok, `elapsed=${elapsed}ms: serve aim == serveHorizontalDir(A, sweepAngleDeg(${elapsed})=${expectedAngle.toFixed(1)}°)`);
  }
  // Two DIFFERENT release times => two different but exactly-predictable angles.
  const psB = 0;
  const dirEarly = recoverHorizAim(simWithZeroOffset().serve(player('B', 0, 9.8, 0), intent(0.85, 200), psB).launch);
  const dirLate = recoverHorizAim(simWithZeroOffset().serve(player('B', 0, 9.8, 0), intent(0.85, 600), psB).launch);
  assert(
    approx(dirEarly.x, serveHorizontalDir('B', sweepAngleDeg(200)).x, 1e-6) &&
      approx(dirLate.x, serveHorizontalDir('B', sweepAngleDeg(600)).x, 1e-6),
    'side B: two release times reproduce sweepAngleDeg exactly',
  );
}

// Follow a launch through any net contacts (resolving each with the shared pure
// function) until it lands ('ground'/'out'). Mirrors what the server tick does.
function followToLanding(launch: BallLaunch): { kind: 'ground' | 'out'; pos: { x: number; y: number; z: number } } {
  let cur = launch;
  let ev = firstEvent(cur, 8000);
  let guard = 0;
  while (ev.kind === 'net' && guard++ < 8) {
    const r = resolveNetCollision(ev.pos, ballVelocity(cur, ev.atMs));
    cur = { ...cur, origin: r.origin, velocity: r.velocity, serverTime: cur.serverTime + ev.atMs, isNetTouch: true };
    ev = firstEvent(cur, 8000);
  }
  return { kind: ev.kind === 'none' ? 'ground' : (ev.kind as 'ground' | 'out'), pos: ev.pos };
}

function testWeakServeFaults(): void {
  console.log('\n[serve] weak serve dies naturally => opponent point (§1)');
  const ps = 1000;
  const ct = ps + 400; // angle 0, straight forward
  // Side A serves from just behind its baseline with almost no charge: it dies on
  // A's own side (either drops short, or nicks the net and rebounds back) => B.
  const l = simWithZeroOffset().serve(player('A', 0, -COURT_HALF_LENGTH - 0.8, 0), intent(0.05, ct), ps).launch;
  const landed = followToLanding(l);
  const res = resolveDeath(landed.kind, landed.pos, 'A');
  assert(res.scoringSide === 'B', `weak serve by A dies on its own side and scores B (event=${landed.kind}, z=${landed.pos.z.toFixed(2)})`);
}

// M2.7 §1 — a hard ball into the net FACE (below the tape) rebounds back toward
// the hitter's side and lands there, so the opponent scores by 'ground'.
function testNetFaceRebound(): void {
  console.log('\n[net] spike into the net face rebounds to the hitter and opponent scores (§1)');
  // A side-A attacker near the net drives a low, hard ball straight at the net.
  const launch: BallLaunch = {
    origin: { x: 0, y: 1.2, z: -1.2 },
    velocity: { x: 0, y: 0.5, z: 9 }, // low + fast => hits the net face (y ~1 at z=0)
    omega: { x: 0, y: 0, z: 0 },
    arcType: 'spike',
    quality: 1,
    gravity: GRAVITY,
    serverTime: 0,
    rngSeed: 1,
  };
  const contact = firstEvent(launch, 8000);
  assert(contact.kind === 'net' && contact.pos.y < NET_TOP - 0.15, `hard low ball hits the net FACE (kind=${contact.kind}, y=${contact.pos.y.toFixed(2)})`);
  const r = resolveNetCollision(contact.pos, ballVelocity(launch, contact.atMs));
  assert(Math.sign(r.velocity.z) === -1, `rebound reverses z back toward side A (vz=${r.velocity.z.toFixed(2)})`);
  const landed = followToLanding(launch);
  assert(landed.kind === 'ground' && landed.pos.z < 0, `rebound lands on side A's half (z=${landed.pos.z.toFixed(2)})`);
  const res = resolveDeath(landed.kind, landed.pos, 'A');
  assert(res.scoringSide === 'B', 'the opponent B scores after A spikes into the net');
}

// M2.7 §1 — a ball that clips the TAPE (top 0.15u) passes OVER to the far side,
// damped, and the rally continues (let-serve). No net death, no re-collision loop.
function testTapeLetServe(): void {
  console.log('\n[net] a ball clipping the tape passes over and the rally continues (§1 let-serve)');
  // Side A ball reaching z=0 at y≈2.30 (inside the tape band [2.28, 2.43]).
  const launch: BallLaunch = {
    origin: { x: 0, y: 2.5, z: -1 },
    velocity: { x: 0, y: 0, z: 5 },
    omega: { x: 0, y: 0, z: 0 },
    arcType: 'serve',
    quality: 0.8,
    gravity: GRAVITY,
    serverTime: 0,
    rngSeed: 1,
  };
  const contact = firstEvent(launch, 8000);
  const inTape = contact.pos.y >= NET_TOP - 0.15 && contact.pos.y <= NET_TOP;
  assert(contact.kind === 'net' && inTape, `ball clips the tape (kind=${contact.kind}, y=${contact.pos.y.toFixed(3)})`);
  const r = resolveNetCollision(contact.pos, ballVelocity(launch, contact.atMs));
  assert(r.zone === 'tape' && Math.sign(r.velocity.z) === 1, `tape resolve keeps crossing to side B (zone=${r.zone}, vz=${r.velocity.z.toFixed(2)})`);
  const landed = followToLanding(launch);
  assert(landed.pos.z > 0, `let-serve continues over and lands on side B (z=${landed.pos.z.toFixed(2)}, kind=${landed.kind})`);
}

// M2.7 §1 (findings #1/#2) — after a net rebound the pre-bounce lag-comp history
// must SURVIVE, so a laggy (100ms) touch whose clientTime maps to BEFORE the net
// contact adjudicates against the PRE-bounce ball, not the rebound. Reproduces the
// exact buffer sequence MatchSim.installRebound builds (preserve history + drop
// the post-contact overshoot + anchor an exact contact sample), then runs the REAL
// adjudicateTouch and asserts it rewinds to the pre-bounce trajectory.
function testNetReboundPreservesPreBounceHistory(): void {
  console.log('\n[net] a lagged touch just BEFORE net contact adjudicates pre-bounce (§1 #1/#2)');
  const T0 = 100_000;
  const preLaunch: BallLaunch = {
    origin: { x: 0, y: 1.2, z: -1.2 },
    velocity: { x: 0, y: 0.5, z: 9 }, // low + hard => hits the net FACE at z=0
    omega: { x: 0, y: 0, z: 0 },
    arcType: 'spike', quality: 1, gravity: GRAVITY, serverTime: T0, rngSeed: 1,
  };
  const contact = firstEvent(preLaunch, 8000);
  const contactTime = T0 + contact.atMs;
  const serverNow = contactTime + TICK_MS / 2; // the tick that detects the contact
  const resolved = resolveNetCollision(contact.pos, ballVelocity(preLaunch, contact.atMs));
  const rebound: BallLaunch = { ...preLaunch, origin: resolved.origin, velocity: resolved.velocity, serverTime: contactTime, isNetTouch: true };

  // Populate the buffer exactly like the sim: pre-bounce ticks, a pre-bounce
  // OVERSHOOT sample at serverNow, then installRebound's dropFrom + anchors.
  const buffer = new BallRingBuffer();
  for (let tk = T0; tk < contactTime; tk += TICK_MS) {
    buffer.record(tk, ballPosition(preLaunch, tk - T0), ballVelocity(preLaunch, tk - T0));
  }
  buffer.record(serverNow, ballPosition(preLaunch, serverNow - T0), ballVelocity(preLaunch, serverNow - T0)); // overshoot (z>0)
  buffer.dropFrom(contactTime);
  buffer.record(contactTime, rebound.origin, rebound.velocity);
  buffer.record(serverNow, ballPosition(rebound, serverNow - contactTime), ballVelocity(rebound, serverNow - contactTime));

  // #2 anchor: the sample at the contact instant is the rebound start (on the
  // hitter's side), NOT the discarded overshoot that sat past the net.
  const atContact = buffer.query(contactTime)!;
  assert(Math.abs(atContact.pos.z + NET_CONTACT_EPS) < 1e-6, `contact anchor is the rebound origin (z=${atContact.pos.z.toFixed(4)}, not the overshoot)`);

  // A 100ms-lagged touch: clientTime maps (offset 0) to 100ms before serverNow —
  // an instant BEFORE the net contact, while the ball is still short of the net.
  const clock = new ClockSync();
  clock.observePing('tou', 1000, 1000); // zero offset => toServerTime(ct) === ct
  const preTouchTime = serverNow - 100;
  const preBallZ = ballPosition(preLaunch, preTouchTime - T0).z;
  assert(preBallZ < -0.2, `pre-bounce touch instant is short of the net (z=${preBallZ.toFixed(2)})`);
  const preBall = ballPosition(preLaunch, preTouchTime - T0);

  const players = new PlayerHistory();
  for (let tk = T0; tk <= serverNow; tk += TICK_MS) players.record('tou', tk, { x: preBall.x, y: 0, z: preBall.z });

  const verdict = adjudicateTouch({
    sessionId: 'tou', playerId: 'tou', clientTime: preTouchTime, serverNow, mode: 'dig',
    clockSync: clock, ballBuffer: buffer, playerHistory: players,
    ballPosAt: (t) => ballPosition(rebound, t - contactTime),
  });
  assert(verdict.accepted, 'lagged pre-contact touch is accepted (history preserved across the rebound)');
  assert(!!verdict.ballPos && verdict.ballPos.z < -0.2, `adjudicated against the PRE-bounce ball (z=${verdict.ballPos?.z.toFixed(2)}), not the rebound`);
  assert(!!verdict.ballPos && Math.abs(verdict.ballPos.z - preBallZ) < 0.05, 'rewound ball position matches the pre-bounce trajectory');

  // Contrast: had the buffer been CLEARED on the rebound (the bug), the same
  // clientTime clamps to windowStart (the contact) and returns the rebound ball
  // hugging the net — the wrong adjudication finding #1 fixes.
  const cleared = new BallRingBuffer();
  cleared.record(contactTime, rebound.origin, rebound.velocity);
  cleared.record(serverNow, ballPosition(rebound, serverNow - contactTime), ballVelocity(rebound, serverNow - contactTime));
  const clampedZ = cleared.query(preTouchTime)!.pos.z; // clamps up to contactTime
  assert(clampedZ > -0.1, `cleared-buffer regression would rewind to the rebound at the net (z=${clampedZ.toFixed(3)})`);
}

function testYawMovement(): void {
  console.log('\n[move] yaw-relative movement (§5.2)');
  const HALF_PI = Math.PI / 2;
  for (const side of ['A', 'B'] as Side[]) {
    const frame: InputFrame = { seq: 1, clientTime: 0, move: { x: 0, y: 1 }, jumpHeld: false, touchMode: 'dig', isCharging: false, dtMs: 100, yaw: HALF_PI };
    const out = applyInput({ pos: { x: 0, y: 0, z: side === 'A' ? -4 : 4 }, stamina: 100, side }, frame);
    assert(out.pos.x > 0.01 && approx(out.pos.z, side === 'A' ? -4 : 4, 1e-9), `side ${side}: yaw=π/2 + move.y=+1 moves +X only (x=${out.pos.x.toFixed(3)})`);
  }
}

function testServeGroundedClamp(): void {
  console.log('\n[move] serve grounded clamp blocks entering court; airborne crosses (§2)');
  const frames = (): InputFrame => ({ seq: 1, clientTime: 0, move: { x: 0, y: 1 }, jumpHeld: false, touchMode: 'dig', isCharging: false, dtMs: 50, yaw: null });
  // Side A grounded server pushes toward the net for many frames — must stay |z| >= COURT_HALF_LENGTH.
  let posG = { x: 0, y: 0, z: -(COURT_HALF_LENGTH + 0.8) };
  for (let i = 0; i < 60; i++) posG = applyInput({ pos: posG, stamina: 100, side: 'A', serveClampAbsZ: COURT_HALF_LENGTH }, frames()).pos;
  assert(posG.z <= -COURT_HALF_LENGTH + 1e-9, `grounded server clamped at the baseline (z=${posG.z.toFixed(2)} <= -${COURT_HALF_LENGTH})`);

  // Same push WITHOUT the clamp (airborne) — must cross the baseline into the court.
  let posA = { x: 0, y: 1, z: -(COURT_HALF_LENGTH + 0.8) };
  for (let i = 0; i < 60; i++) posA = applyInput({ pos: posA, stamina: 100, side: 'A' }, frames()).pos;
  assert(posA.z > -COURT_HALF_LENGTH, `airborne server crosses the baseline into the court (z=${posA.z.toFixed(2)} > -${COURT_HALF_LENGTH})`);
  assert(posG.z >= -BACK_BOUND_Z, 'clamp still permits backing up to BACK_BOUND_Z');
}

function testOverchargeQualityPenalty(): void {
  console.log('\n[serve] overcharge quality penalty (§5) — same serve, charge 1.0 vs 1.3');
  const ps = 1000;
  const ct = ps + 400; // angle 0, straight forward — charge doesn't affect aim
  const at = (charge: number): BallLaunch =>
    simWithZeroOffset().serve(player('A', 0, -COURT_HALF_LENGTH - 0.8, 0), intent(charge, ct), ps).launch;

  const normal = at(1.0);
  const overcharged = at(OVERCHARGE_MAX);
  assert(approx(normal.quality, SERVE_QUALITY_GROUND), `charge=1.0: quality unpenalized (${normal.quality})`);
  assert(
    approx(overcharged.quality, SERVE_QUALITY_GROUND * overchargeQualityMult(OVERCHARGE_MAX), 1e-6),
    `charge=${OVERCHARGE_MAX}: quality = base × overchargeQualityMult(${OVERCHARGE_MAX}) (${overcharged.quality})`,
  );
  assert(
    approx(overcharged.quality / normal.quality, 0.5, 1e-6),
    `charge 1.0 vs ${OVERCHARGE_MAX}: quality ratio = 0.5 (got ${(overcharged.quality / normal.quality).toFixed(4)})`,
  );
}

function testWireChargeClamp(): void {
  console.log('\n[net] inbound TouchIntent.charge clamps to [0, OVERCHARGE_MAX] (§5)');
  const raw = { playerId: 'p1', clientTime: 0, mode: 'spike', charge: 2.0, dirInput: { x: 0, y: 0 } };
  const parsed = parseTouch(raw);
  assert(parsed !== null, 'well-formed touch with charge=2.0 parses');
  assert(approx(parsed?.charge ?? -1, OVERCHARGE_MAX), `charge=2.0 clamps to OVERCHARGE_MAX=${OVERCHARGE_MAX} (got ${parsed?.charge})`);

  const negative = parseTouch({ ...raw, charge: -5 });
  assert(approx(negative?.charge ?? -1, 0), `charge=-5 clamps to 0 (got ${negative?.charge})`);

  const withinRedZone = parseTouch({ ...raw, charge: 1.15 });
  assert(approx(withinRedZone?.charge ?? -1, 1.15), `charge=1.15 (red zone) passes through unclamped (got ${withinRedZone?.charge})`);
}

testGroundVsJump();
testAngleDeterminism();
testWeakServeFaults();
testNetFaceRebound();
testTapeLetServe();
testNetReboundPreservesPreBounceHistory();
testYawMovement();
testServeGroundedClamp();
testOverchargeQualityPenalty();
testWireChargeClamp();
console.log(`\n[serve] ${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
