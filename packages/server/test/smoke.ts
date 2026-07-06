// Scripted-client smoke test (M2.1 + M2.2 WP2 acceptance). Exercises the real
// server over the wire: code-based lobby (create -> joinById -> set names ->
// host start), the M2.2 variable jump (tap vs full-hold apex, press-to-jump),
// an outside-court min-charge serve, a lag-compensated return dig, and rally
// scoring. Also unit-checks the pure scoring rule (§9).
//
// Run: server listening on 0.0.0.0:2567, then `npx tsx test/smoke.ts`.
import { Client, type Room } from 'colyseus.js';
import {
  CH,
  ROOM_NAME,
  ballPosition,
  distXZ,
  REACH_MAX,
  type BallLaunch,
  type DeathEvent,
  type InputFrame,
  type LobbyState,
  type PlayerSnapshot,
  type Side,
  type StateSnapshot,
  type TouchIntent,
  type TouchResult,
} from '@spike/shared';
import { applyPoint, winnerOf, isGameOver } from '../src/game/scoring';

const ENDPOINT = process.env.SPIKE_ENDPOINT ?? 'ws://127.0.0.1:2567';

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  PASS  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Peer {
  room: Room;
  offset: number;
  launches: BallLaunch[];
  deaths: DeathEvent[];
  touchResults: TouchResult[];
  lobby: LobbyState | null;
  snap: StateSnapshot | null;
}

function wire(room: Room): Peer {
  const p: Peer = { room, offset: 0, launches: [], deaths: [], touchResults: [], lobby: null, snap: null };
  room.onMessage(CH.PONG, (m: { clientTime: number; serverTime: number }) => {
    const now = Date.now();
    const sample = m.serverTime + (now - m.clientTime) / 2 - now;
    p.offset = p.offset === 0 ? sample : p.offset * 0.7 + sample * 0.3;
  });
  room.onMessage(CH.LOBBY_STATE, (m: LobbyState) => (p.lobby = m));
  room.onMessage(CH.SNAPSHOT, (m: StateSnapshot) => (p.snap = m));
  room.onMessage(CH.BALL_LAUNCH, (m: BallLaunch) => p.launches.push(m));
  room.onMessage(CH.DEATH, (m: DeathEvent) => p.deaths.push(m));
  room.onMessage(CH.TOUCH_RESULT, (m: TouchResult) => p.touchResults.push(m));
  return p;
}

async function syncClock(p: Peer): Promise<void> {
  for (let i = 0; i < 5; i++) {
    p.room.send(CH.PING, { clientTime: Date.now() });
    await delay(40);
  }
}
const serverNow = (p: Peer): number => Date.now() + p.offset;
const playerOf = (p: Peer, id: string): PlayerSnapshot | undefined => p.snap?.players.find((pl) => pl.id === id);

// M2.3 §3: the serve aim is the protractor angle at release, sweepAngleDeg(release
// − servePhaseStart). Angle 0 (straight at the net) recurs every 800ms at elapsed
// 400 & 1200 (mod 1600). To land a forward serve, wait until the sweep is near a
// center, then release. On localhost the mapped release ≈ serverNow at send, so
// the aim is ~straight ahead (< a few degrees off).
// Angle 0 occurs at elapsed 400 & 1200 (mod 1600), i.e. every 800ms. Release at
// the nearest center's wall-clock instant so the mapped release lands on angle 0
// within timer jitter (~1°) — the serve heads straight at the net.
async function serveForward(p: Peer, charge: number): Promise<void> {
  await waitFor(() => p.snap?.servePhaseStartServerTime != null, 2500, 'servePhaseStart');
  const ps = p.snap!.servePhaseStartServerTime!;
  const base = ps + 400;
  const k = Math.ceil((serverNow(p) + 40 - base) / 800); // next FUTURE center
  const centerServer = base + 800 * k;
  const waitMs = Math.max(0, centerServer - p.offset - Date.now());
  await delay(waitMs);
  p.room.send(CH.TOUCH, { playerId: p.room.sessionId, clientTime: Date.now(), mode: 'spike', charge, dirInput: { x: 0, y: 0 } } satisfies TouchIntent);
}

async function waitFor(pred: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await delay(15);
  }
  console.error(`  (timeout waiting for ${label})`);
  return false;
}

// M2.5 §1 WP1 acceptance — server-computed facing priority: explicit yaw >
// movement direction > previous facing (persisted, does not reset to the
// spawn/net-facing initial value while idle). Convention: forward(yaw) =
// (sin(yaw), cos(yaw)) in the XZ plane (viewSpace.ts) — yaw=π/2 faces +X.
async function testFacing(peer: Peer, id: string, side: Side): Promise<void> {
  console.log('\n[facing] yaw priority + movement direction + idle persistence (§1)');
  let seq = 800;

  // (a) yaw=π/2 (held, no movement) -> snapshot facing=π/2.
  for (let i = 0; i < 8; i++) {
    peer.room.send(CH.INPUT, {
      seq: seq++,
      clientTime: Date.now(),
      move: { x: 0, y: 0 },
      jumpHeld: false,
      touchMode: 'dig',
      isCharging: false,
      dtMs: 33,
      yaw: Math.PI / 2,
    } satisfies InputFrame);
    await delay(20);
  }
  await delay(80);
  const facingYaw = playerOf(peer, id)?.facing ?? Number.NaN;
  assert(Math.abs(facingYaw - Math.PI / 2) < 1e-3, `yaw=π/2 -> snapshot facing=π/2 (got ${facingYaw.toFixed(3)})`);

  // (b) yaw=null + sustained move toward world +X -> facing settles at π/2
  // (forward(π/2) = (sin, cos) = (1, 0) = +X). rightX(A)=-1 so view x=-1 is
  // world +X for side A; rightX(B)=+1 so view x=+1 is world +X for side B.
  const moveX = (side === 'A' ? -1 : 1) as -1 | 0 | 1;
  for (let i = 0; i < 12; i++) {
    peer.room.send(CH.INPUT, {
      seq: seq++,
      clientTime: Date.now(),
      move: { x: moveX, y: 0 },
      jumpHeld: false,
      touchMode: 'dig',
      isCharging: false,
      dtMs: 33,
      yaw: null,
    } satisfies InputFrame);
    await delay(20);
  }
  await delay(80);
  const facingMove = playerOf(peer, id)?.facing ?? Number.NaN;
  assert(Math.abs(facingMove - Math.PI / 2) < 0.05, `sustained move toward world +X -> facing ~ π/2 (got ${facingMove.toFixed(3)})`);

  // (c) idle (no yaw, no movement) -> keeps the previous facing, does not
  // reset to the initial net-facing spawn value.
  for (let i = 0; i < 6; i++) {
    peer.room.send(CH.INPUT, {
      seq: seq++,
      clientTime: Date.now(),
      move: { x: 0, y: 0 },
      jumpHeld: false,
      touchMode: 'dig',
      isCharging: false,
      dtMs: 33,
      yaw: null,
    } satisfies InputFrame);
    await delay(20);
  }
  await delay(80);
  const facingIdle = playerOf(peer, id)?.facing ?? Number.NaN;
  assert(Math.abs(facingIdle - facingMove) < 1e-3, `idle player keeps previous facing (${facingIdle.toFixed(3)} ~ ${facingMove.toFixed(3)})`);
}

// M2.8 §1 — isCharging is streamed every InputFrame and written into the
// authoritative PlayerState every frame; ANY client's snapshot must reflect
// the reporter's charge-hold state (true while held, false once released).
async function testCharging(reporter: Peer, observer: Peer, reporterId: string): Promise<void> {
  console.log('\n[charge] isCharging streamed every frame -> authoritative on ALL snapshots (§1)');
  let seq = 5000;
  const frame = (isCharging: boolean): InputFrame => ({
    seq: seq++,
    clientTime: Date.now(),
    move: { x: 0, y: 0 },
    jumpHeld: false,
    touchMode: 'dig',
    isCharging,
    dtMs: 33,
    yaw: null,
  });

  for (let i = 0; i < 8; i++) {
    reporter.room.send(CH.INPUT, frame(true));
    await delay(20);
  }
  const chargingSeen = await waitFor(() => playerOf(observer, reporterId)?.isCharging === true, 1500, 'isCharging=true on remote snapshot');
  assert(chargingSeen, 'isCharging=true frames -> the OTHER client\'s snapshot shows that player isCharging=true');

  for (let i = 0; i < 8; i++) {
    reporter.room.send(CH.INPUT, frame(false));
    await delay(20);
  }
  const releasedSeen = await waitFor(() => playerOf(observer, reporterId)?.isCharging === false, 1500, 'isCharging=false on remote snapshot');
  assert(releasedSeen, 'isCharging=false frames -> the OTHER client\'s snapshot shows that player isCharging=false');
}

function testScoringModule(): void {
  console.log('\n[scoring] pure rally-point rule (§9)');
  let score = { A: 0, B: 0 };
  for (let i = 0; i < 15; i++) score = applyPoint(score, 'A');
  assert(isGameOver(score) && winnerOf(score) === 'A', '15-0 ends the game, A wins');
  let deuce = { A: 14, B: 14 };
  deuce = applyPoint(deuce, 'A');
  assert(!isGameOver(deuce), '15-14 is not over (win-by-2)');
  deuce = applyPoint(deuce, 'A');
  assert(isGameOver(deuce) && winnerOf(deuce) === 'A', '16-14 ends the game (win-by-2)');
  let cap = { A: 20, B: 20 };
  cap = applyPoint(cap, 'B');
  assert(isGameOver(cap) && winnerOf(cap) === 'B', '20-21 ends at the cap even at 1-point lead');
}

async function main(): Promise<void> {
  console.log(`[smoke] code-based lobby: create + joinById against ${ENDPOINT}`);
  const c1 = new Client(ENDPOINT);
  const c2 = new Client(ENDPOINT);

  // Host CREATES; the shareable code is room.roomId. Guest joins BY that code.
  const r1 = await c1.create(ROOM_NAME);
  const code = r1.roomId;
  const r2 = await c2.joinById(code);
  const a = wire(r1);
  const b = wire(r2);

  console.log('\n[lobby] team-slot grid (§1), auto-assign, host, canStart');
  const filled = (l: LobbyState | null): number => l?.slots.filter((s) => s.playerId !== null).length ?? 0;
  const rostered = await waitFor(() => filled(a.lobby) === 2, 4000, 'both in lobby roster');
  assert(rostered, 'both clients appear in the lobby slot grid');
  assert((a.lobby?.slots.length ?? 0) === 12, 'LOBBY_STATE carries the full 12-slot grid (SLOTS_PER_TEAM×2)');
  r1.send(CH.SET_NAME, { name: 'Ace' });
  r2.send(CH.SET_NAME, { name: 'Bo' });
  const named = await waitFor(
    () => a.lobby?.slots.some((s) => s.name === 'Ace') === true && a.lobby?.slots.some((s) => s.name === 'Bo') === true,
    2000,
    'names applied',
  );
  assert(named, 'SET_NAME updates the roster for both players');
  const lob = a.lobby!;
  const sideOf = (id: string): string => lob.slots.find((s) => s.playerId === id)?.side ?? '?';
  assert(sideOf(r1.sessionId) === 'A' && sideOf(r2.sessionId) === 'B', 'auto-assign seats opposite sides (A vs B)');
  assert(lob.hostId === r1.sessionId, 'first joiner is the host');
  assert(lob.canStart === true && lob.matchSize === 1, 'canStart with 2 players, matchSize=1 (1v1)');

  console.log('\n[start] host starts -> serve phase');
  r1.send(CH.START_MATCH, {});
  const started = await waitFor(() => a.snap?.phase === 'serve' && a.snap?.servingId === r1.sessionId, 3000, 'serve phase');
  assert(started, 'START_MATCH moves lobby -> serve, side A serving');
  const serverSpawn = playerOf(a, r1.sessionId);
  assert((serverSpawn?.pos.z ?? 0) < -6, 'serving player is positioned near the back line');

  console.log('\n[clock] ping/pong EMA offset');
  await Promise.all([syncClock(a), syncClock(b)]);
  assert(Number.isFinite(a.offset) && Number.isFinite(b.offset), 'both clients derived a finite clock offset');

  await testFacing(a, r1.sessionId, 'A');

  await testCharging(a, b, r1.sessionId);

  // Variable-jump apex runs in the STABLE serve phase (no rally, no reset timer),
  // so a two-jump measurement is never interrupted by a serve reposition.
  // Jumper is r2 (peer b); observer is peer a.
  await testJumpApex(b, a, r2.sessionId);

  console.log('\n[serve] charge scales serve speed on its own baseline (fixes G1)');
  // M2.3 §3: angle-sweep serve — release when the protractor is centered so the
  // ball heads straight at the net (aim is time-based now, not dirInput).
  await serveForward(a, 0.85);
  const serveSeen = await waitFor(() => a.launches.length >= 1 && b.launches.length >= 1, 3000, 'serve BallLaunch');
  assert(serveSeen, 'serve BallLaunch reached BOTH clients');
  const serve = a.launches[0];
  if (serve) {
    assert(serve.arcType === 'serve', 'serve launch has arcType "serve"');
    const speed = Math.hypot(serve.velocity.x, serve.velocity.y, serve.velocity.z);
    // M3.0a: SERVE_BASE_SPEED=9 (drag-compensated), uncharged. A charged serve
    // must exceed that (G1: serve is no longer hardcoded charge 0 / coupled to the
    // spike baseline). The 8.01 lower bound stays a valid "clearly charged" gate.
    assert(speed > 8.01, `charged serve (${speed.toFixed(1)} u/s) is faster than the uncharged baseline`);
  }

  // M2.8 playtest — TouchResult is BROADCAST (was toucher-only) and carries the
  // toucher's playerId, so remote clients can render that player's face/dive
  // reaction. The SECOND client must receive the FIRST client's serve TouchResult.
  const bSawServerResult = await waitFor(
    () => b.touchResults.some((t) => t.playerId === r1.sessionId),
    2000,
    "second client sees first client's TouchResult",
  );
  assert(bSawServerResult, "TouchResult is broadcast to the room and carries the toucher's playerId");

  console.log('\n[return] side B lag-compensated dig');
  const launch = b.launches[0];
  if (launch) {
    // The serve scatters (q=0.8), so B chases under the ball's KNOWN path to a
    // reachable contact point and then digs at that instant (lag-comp rewinds
    // both ball and B to the mapped release, so a timed touch is robust).
    let contact: { t: number; x: number; z: number } | null = null;
    for (let e = 0; e <= 3500; e += 8) {
      const p = ballPosition(launch, e);
      if (p.z > 0 && p.z < 8.5 && Math.abs(p.x) < 4.2 && p.y > 0.5 && p.y < 2.2) {
        contact = { t: launch.serverTime + e, x: p.x, z: p.z };
        break;
      }
    }
    let sent = false;
    if (contact) {
      let seq = 500;
      const sendAt = contact.t - b.offset; // wall-clock instant to release the dig
      while (Date.now() < sendAt - 120) {
        const bp = playerOf(b, r2.sessionId)?.pos;
        if (!bp) break;
        const dx = contact.x - bp.x;
        const dz = contact.z - bp.z;
        const mx = Math.abs(dx) < 0.12 ? 0 : Math.sign(dx); // side B: rightX=+1
        const my = Math.abs(dz) < 0.12 ? 0 : -Math.sign(dz); // side B: forwardZ=-1
        r2.send(CH.INPUT, { seq: seq++, clientTime: Date.now(), move: { x: mx as -1 | 0 | 1, y: my as -1 | 0 | 1 }, jumpHeld: false, touchMode: 'dig', isCharging: false, dtMs: 33, yaw: null } satisfies InputFrame);
        await delay(25);
      }
      await delay(Math.max(0, sendAt - Date.now()));
      r2.send(CH.TOUCH, { playerId: r2.sessionId, clientTime: Date.now(), mode: 'dig', charge: 0.3, dirInput: { x: 0, y: 0 } } satisfies TouchIntent);
      sent = true;
    }
    // Filter to B's OWN result: TouchResult is broadcast now, so b.touchResults
    // already holds A's serve result — the dig is the one with playerId === r2.
    const gotResult = await waitFor(() => b.touchResults.some((t) => t.playerId === r2.sessionId), 2000, 'TouchResult for the dig');
    assert(sent, 'B found a reachable contact point on the pure trajectory');
    assert(gotResult, 'server replied with a well-formed TouchResult');
  }

  console.log('\n[score] rally resolves to a point');
  const gotDeath = await waitFor(() => a.deaths.length >= 1, 6000, 'DeathEvent');
  assert(gotDeath, 'DeathEvent broadcast reached both clients');
  const death = a.deaths[0];
  if (death) {
    assert(death.score.A + death.score.B === 1, 'exactly one rally point was awarded');
    assert(death.scoringSide === 'A' || death.scoringSide === 'B', 'DeathEvent names a valid scoring side');
    console.log(`  info  death cause="${death.cause}" score A:${death.score.A} B:${death.score.B}`);
  }

  testScoringModule();

  await Promise.all([r1.leave(), r2.leave()]);
  await delay(200);
  console.log(`\n[smoke] ${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

// M2.2 §1 variable jump (press-to-jump, hold-to-boost). A rising edge of
// jumpHeld launches instantly; holding through the boost window floats higher.
// Asserts the WP2 acceptance: a full hold reaches a strictly higher apex than a
// tap, both trace a single-peak parabola, and both land back on the ground.
async function measureApex(jumper: Peer, observer: Peer, id: string, hold: boolean, seqStart: number): Promise<number> {
  await waitFor(() => (playerOf(observer, id)?.pos.y ?? 1) < 0.05, 3000, 'jumper grounded');
  let seq = seqStart;
  const frame = (jumpHeld: boolean): InputFrame => ({
    seq: seq++,
    clientTime: Date.now(),
    move: { x: 0, y: 0 },
    jumpHeld,
    touchMode: 'dig',
    isCharging: false,
    dtMs: 16,
    yaw: null,
  });
  // Rising edge: press starts the jump. Then either hold through the boost
  // window (full) or release immediately (tap).
  jumper.room.send(CH.INPUT, frame(true));
  const holdMs = hold ? 400 : 0;
  const t0 = Date.now();
  while (Date.now() - t0 < holdMs) {
    jumper.room.send(CH.INPUT, frame(true));
    await delay(15);
  }
  for (let i = 0; i < 4; i++) {
    jumper.room.send(CH.INPUT, frame(false));
    await delay(8);
  }
  const ys: number[] = [];
  const t1 = Date.now();
  while (Date.now() - t1 < 1200) {
    const pl = playerOf(observer, id);
    if (pl) ys.push(pl.pos.y);
    await delay(20);
  }
  const maxY = Math.max(...ys);
  const peakIdx = ys.indexOf(maxY);
  assert(peakIdx > 0 && peakIdx < ys.length - 1, `${hold ? 'full-hold' : 'tap'} Y rises then falls (single-peak parabola)`);
  assert(ys[ys.length - 1]! < 0.15, `${hold ? 'full-hold' : 'tap'} jump returned to the ground (y ~ 0)`);
  return maxY;
}

async function testJumpApex(jumper: Peer, observer: Peer, jumperId: string): Promise<void> {
  console.log('\n[jump] variable jump: tap vs full-hold apex (§1)');
  const tap = await measureApex(jumper, observer, jumperId, false, 2000);
  const fullHold = await measureApex(jumper, observer, jumperId, true, 3000);
  console.log(`  info  tap apex=${tap.toFixed(2)}u, full-hold apex=${fullHold.toFixed(2)}u`);
  assert(tap > 0.25, `a tap produces a real (small) jump (${tap.toFixed(2)}u)`);
  assert(fullHold > tap + 0.15, `full hold reaches a strictly higher apex than a tap (${fullHold.toFixed(2)} > ${tap.toFixed(2)})`);
  assert(fullHold > 0.8, `full hold clears net-relevant height (${fullHold.toFixed(2)}u)`);
}

main().catch((err: unknown) => {
  console.error('[smoke] crashed', err);
  process.exit(1);
});
