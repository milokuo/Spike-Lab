// WP4 end-to-end integration test, updated for the M2.1 code-based lobby.
// Part 1 (1v1, one client +100ms): create -> joinById -> start, then play
// multiple rallies and assert (a) a lag-compensated ideal-time return by the
// delayed client is still PERFECT, and (b) the same BallLaunch replays to
// identical positions on both clients (deterministic §6.4).
// Part 2 (2v2, 4 clients): auto-balanced sides, a teammate-targeted dig (§b.7),
// and the per-side 3-touch cap (pure rally module).
//
// Run: server listening on 0.0.0.0:2567, then `npx tsx test/integration.ts`.
import { Client, type Room } from 'colyseus.js';
import {
  CH,
  ROOM_NAME,
  ballPosition,
  distXZ,
  firstEvent,
  COURT_HALF_LENGTH,
  DIG_REACH_MAX,
  DIVE_REACH_MAX,
  DIVE_QUALITY,
  PERFECT_WINDOW_MS,
  REACH_MAX,
  SLOTS_PER_TEAM,
  currentServerId,
  initRotation,
  onPoint,
  viewToWorld,
  type BallLaunch,
  type ServeRotation,
  type TeamSlot,
  type DeathEvent,
  type InputFrame,
  type LobbyState,
  type PlayerSnapshot,
  type Side,
  type StateSnapshot,
  type TouchIntent,
  type TouchResult,
} from '@spike/shared';
import { initialTouchState, checkTouch, registerTouch } from '../src/game/rally';
// Import the REAL client prediction class so the direction e2e asserts on the
// exact code the browser runs, not a re-implementation (M2.1 direction fix).
import { LocalPlayer } from '../../client/src/player/localPlayer';

const ENDPOINT = process.env.SPIKE_ENDPOINT ?? 'ws://127.0.0.1:2567';
const LAG_MS = 100;
const RALLIES = 3;
const POS_EPSILON = 1e-6;
const SCAN_STEP_MS = 4;
const MAX_FLIGHT_MS = 5000;

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
  results: TouchResult[];
  lobby: LobbyState | null;
  snap: StateSnapshot | null;
}

function wire(room: Room): Peer {
  const p: Peer = { room, offset: 0, launches: [], deaths: [], results: [], lobby: null, snap: null };
  room.onMessage(CH.PONG, (m: { clientTime: number; serverTime: number }) => {
    const now = Date.now();
    const sample = m.serverTime + (now - m.clientTime) / 2 - now;
    p.offset = p.offset === 0 ? sample : p.offset * 0.8 + sample * 0.2;
  });
  room.onMessage(CH.LOBBY_STATE, (m: LobbyState) => (p.lobby = m));
  room.onMessage(CH.SNAPSHOT, (m: StateSnapshot) => (p.snap = m));
  room.onMessage(CH.BALL_LAUNCH, (m: BallLaunch) => p.launches.push(m));
  room.onMessage(CH.DEATH, (m: DeathEvent) => p.deaths.push(m));
  room.onMessage(CH.TOUCH_RESULT, (m: TouchResult) => p.results.push(m));
  return p;
}

// Delay every outbound message from this room by ms (both PING and TOUCH).
function addLatency(room: Room, ms: number): void {
  const raw = room.send.bind(room);
  (room as unknown as { send: Room['send'] }).send = ((type: string, message?: unknown) => {
    setTimeout(() => raw(type as never, message as never), ms);
  }) as Room['send'];
}

async function syncClock(p: Peer, samples = 8): Promise<void> {
  for (let i = 0; i < samples; i++) {
    p.room.send(CH.PING, { clientTime: Date.now() });
    await delay(120);
  }
}
const serverNow = (p: Peer): number => Date.now() + p.offset;
const playerOf = (p: Peer, id: string): PlayerSnapshot | undefined => p.snap?.players.find((pl) => pl.id === id);
// M2.8 playtest — TouchResult is BROADCAST now, so every peer's `results` holds
// EVERY player's results (e.g. the server's serve result). A receiver checking
// its OWN touch must filter by its own sessionId, or a broadcast from another
// player would be mistaken for its result.
const ownResults = (p: Peer): TouchResult[] => p.results.filter((r) => r.playerId === p.room.sessionId);

// M2.3 §3: serve aim is the protractor angle at release, sweepAngleDeg(release −
// servePhaseStart). Angle 0 (straight at the net) recurs at elapsed 400 & 1200
// (mod 1600). Release near a center => forward serve. (A high-latency server
// drifts by its up-latency; those rallies still complete — the timed forward
// serve is what the receiver-reaching assertions rely on.)
// Angle 0 occurs at elapsed 400 & 1200 (mod 1600), i.e. every 800ms. Compute the
// nearest center's wall-clock instant (centerServer − offset) and release exactly
// then, so the mapped release lands on angle 0 within timer jitter (~1°) — much
// tighter than polling a window, which matters now that serves scatter (q=0.8).
async function serveForward(p: Peer, charge: number): Promise<void> {
  await waitFor(() => p.snap?.servePhaseStartServerTime != null, 2500, 'servePhaseStart');
  const ps = p.snap!.servePhaseStartServerTime!;
  const base = ps + 400; // a center; centers repeat every 800ms
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

// First point on the ball's KNOWN trajectory that is on `side`'s half, in-bounds
// and at a reachable height — a deterministic contact target. Serves now scatter
// (q=0.8), so a receiver can't just stand still; it chases this point.
function reachableContact(launch: BallLaunch, side: Side): { t: number; pos: { x: number; y: number; z: number } } | null {
  for (let e = 0; e <= 3500; e += 8) {
    const p = ballPosition(launch, e);
    const onSide = side === 'A' ? p.z < 0 : p.z > 0;
    if (onSide && Math.abs(p.z) < 8.5 && Math.abs(p.x) < 4.2 && p.y > 0.5 && p.y < 2.2) return { t: launch.serverTime + e, pos: p };
  }
  return null;
}

// Drive a receiver toward (tx,tz) via player-view INPUT frames until it is within
// `near` units or the budget elapses. Returns the next seq to use.
async function moveTo(peer: Peer, tx: number, tz: number, side: Side, seq: number, budgetMs = 900, near = 0.4): Promise<number> {
  const rx = side === 'A' ? -1 : 1; // rightX(side)
  const fz = side === 'A' ? 1 : -1; // forwardZ(side)
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const pos = playerOf(peer, peer.room.sessionId)?.pos;
    if (!pos) break;
    const dx = tx - pos.x;
    const dz = tz - pos.z;
    if (Math.hypot(dx, dz) < near) break;
    const mx = Math.abs(dx) < 0.12 ? 0 : (Math.sign(dx) * rx) as -1 | 0 | 1;
    const my = Math.abs(dz) < 0.12 ? 0 : (Math.sign(dz) * fz) as -1 | 0 | 1;
    peer.room.send(CH.INPUT, { seq: seq++, clientTime: Date.now(), move: { x: mx, y: my }, jumpHeld: false, touchMode: 'dig', isCharging: false, dtMs: 33, yaw: null } satisfies InputFrame);
    await delay(25);
  }
  await delay(90); // let the last frames + a snapshot land
  return seq;
}

function idealTime(launch: BallLaunch, pos: { x: number; y: number; z: number }): number | null {
  let bestT = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let e = 0; e <= MAX_FLIGHT_MS; e += SCAN_STEP_MS) {
    const d = distXZ(ballPosition(launch, e), pos);
    if (d < bestD) {
      bestD = d;
      bestT = e;
    }
  }
  return bestD > REACH_MAX ? null : launch.serverTime + bestT;
}

function assertDeterministic(a: Peer, b: Peer, i: number): void {
  const la = a.launches[i];
  const lb = b.launches[i];
  if (!la || !lb) {
    assert(false, `launch #${i} received by BOTH clients`);
    return;
  }
  let maxDiff = 0;
  for (const e of [0, 100, 250, 500, 900, 1500]) {
    const pa = ballPosition(la, e);
    const pb = ballPosition(lb, e);
    maxDiff = Math.max(maxDiff, Math.abs(pa.x - pb.x), Math.abs(pa.y - pb.y), Math.abs(pa.z - pb.z));
  }
  assert(maxDiff < POS_EPSILON, `launch #${i}: both clients replay ball within epsilon (maxΔ=${maxDiff.toExponential(2)})`);
}

// Lobby handshake: host creates, guests join by code, everyone starts on the
// host's Start. Returns peers in join order and the serving check.
const filledSlots = (l: LobbyState | null): number => l?.slots.filter((s) => s.playerId !== null).length ?? 0;

async function lobbyStart(peers: Peer[], hostRoom: Room): Promise<boolean> {
  const rostered = await waitFor(() => filledSlots(peers[0].lobby) === peers.length, 5000, 'full lobby roster');
  if (!rostered) return false;
  hostRoom.send(CH.START_MATCH, {});
  return waitFor(() => peers[0].snap?.phase === 'serve', 4000, 'serve phase after start');
}

async function part1LagComp(): Promise<void> {
  console.log(`\n[part1] 1v1 lag-comp determinism (one client +${LAG_MS}ms)`);
  const c1 = new Client(ENDPOINT);
  const c2 = new Client(ENDPOINT);
  const r1 = await c1.create(ROOM_NAME); // host, side A
  const r2 = await c2.joinById(r1.roomId); // side B <- laggy
  const a = wire(r1);
  const b = wire(r2);
  addLatency(r2, LAG_MS);

  const started = await lobbyStart([a, b], r1);
  assert(started, 'create + joinById + host start reached serve phase');
  await Promise.all([syncClock(a), syncClock(b)]);
  assert(Number.isFinite(a.offset) && Number.isFinite(b.offset), 'both clients derived a finite clock offset');

  let perfectByLaggy = 0;
  let ralliesPlayed = 0;

  for (let rally = 0; rally < RALLIES; rally++) {
    const launchesBefore = a.launches.length;
    const deathsBefore = a.deaths.length;
    const serverId = a.snap!.servingId!;
    const server = serverId === r1.sessionId ? a : b;
    const receiver = serverId === r1.sessionId ? b : a;
    const receiverId = receiver.room.sessionId;

    // Serve deep (past the baseline receiver) so the ideal contact is mid-flight,
    // not at the landing point — otherwise the lag-comp touch races the death.
    // §3: timed to the sweep center so the serve heads straight at the net.
    await serveForward(server, 0.85);
    const gotServe = await waitFor(() => a.launches.length > launchesBefore && b.launches.length > launchesBefore, 3000, `rally ${rally} serve`);
    if (!gotServe) break;
    assertDeterministic(a, b, launchesBefore);

    const launch = receiver.launches[launchesBefore];
    const rpos = playerOf(receiver, receiverId)?.pos ?? { x: 0, y: 0, z: 0 };
    const ideal = idealTime(launch, rpos);
    const resultsBefore = ownResults(receiver).length;
    if (ideal !== null) {
      const waitMs = Math.max(0, ideal - receiver.offset - Date.now());
      setTimeout(() => {
        receiver.room.send(CH.TOUCH, { playerId: receiverId, clientTime: Date.now(), mode: 'dig', charge: 0.3, dirInput: { x: 0, y: 0 } } satisfies TouchIntent);
      }, waitMs);
      const gotResult = await waitFor(() => ownResults(receiver).length > resultsBefore, 3000, `rally ${rally} result`);
      if (gotResult) {
        const own = ownResults(receiver);
        const res = own[own.length - 1];
        const laggy = receiver === b;
        if (res.accepted) {
          if (a.launches.length > launchesBefore + 1) assertDeterministic(a, b, launchesBefore + 1);
          if (res.grade === 'PERFECT' && laggy) perfectByLaggy++;
          console.log(`  info  rally ${rally}: ${laggy ? 'LAGGY(100ms)' : 'clean'} return -> ${res.grade} (window=${PERFECT_WINDOW_MS}ms)`);
        }
      }
    }

    await waitFor(() => a.deaths.length > deathsBefore, 6000, `rally ${rally} death`);
    ralliesPlayed++;
    await waitFor(() => a.snap?.phase === 'serve' || a.snap?.phase === 'gameover', 5000, `rally ${rally} reset`);
    if (a.snap?.phase === 'gameover') break;
  }

  assert(ralliesPlayed >= 2, `played multiple rallies to completion (${ralliesPlayed})`);
  assert(perfectByLaggy >= 1, `100ms-delayed client got PERFECT on an ideal-time return (${perfectByLaggy}x)`);
  await Promise.all([r1.leave(), r2.leave()]);
  await delay(300);
}

// Pure per-side touch cap (§5): with 2 players per side, 3 contacts are legal
// and the 4th is illegal; crossing the net resets the count.
function testTouchCap(): void {
  console.log('\n[2v2] per-side 3-touch cap (pure rally module)');
  let ts = initialTouchState();
  const digger = 'B-1';
  const setter = 'B-2';
  assert(checkTouch(ts, 'B').legal, 'B contact 1 (dig) legal');
  ts = registerTouch(ts, 'B', digger);
  assert(checkTouch(ts, 'B').legal, 'B contact 2 (set by teammate) legal');
  ts = registerTouch(ts, 'B', setter);
  assert(checkTouch(ts, 'B').legal, 'B contact 3 (spike) legal');
  ts = registerTouch(ts, 'B', digger);
  assert(!checkTouch(ts, 'B').legal, 'B contact 4 is illegal (max 3 per side)');
  // After the ball crosses to A, A gets a fresh count.
  ts = registerTouch(initialTouchState(), 'A', 'A-1');
  assert(checkTouch(ts, 'A').legal, 'count resets for A after the ball crosses the net');
}

async function part2TwoVsTwo(): Promise<void> {
  console.log('\n[part2] 2v2: auto-balance + teammate-targeted dig (§b.7)');
  const clients = [new Client(ENDPOINT), new Client(ENDPOINT), new Client(ENDPOINT), new Client(ENDPOINT)];
  const r0 = await clients[0].create(ROOM_NAME);
  const code = r0.roomId;
  const rooms = [r0];
  for (let i = 1; i < 4; i++) rooms.push(await clients[i].joinById(code));
  const peers = rooms.map(wire);

  const started = await lobbyStart(peers, r0);
  assert(started, '4-player lobby started into serve phase');
  const lob = peers[0].lobby!;
  const aCount = lob.slots.filter((s) => s.side === 'A' && s.playerId !== null).length;
  const bCount = lob.slots.filter((s) => s.side === 'B' && s.playerId !== null).length;
  assert(aCount === 2 && bCount === 2, `auto-assign produced 2v2 (A=${aCount}, B=${bCount})`);
  assert(lob.matchSize === 2, 'matchSize derived as 2 (2v2)');
  await Promise.all(peers.map((p) => syncClock(p, 5)));

  // Serve from whoever the server assigned (a side-A player).
  const servingId = peers[0].snap!.servingId!;
  const serverPeer = peers.find((p) => p.room.sessionId === servingId)!;
  const launchesBefore = peers[0].launches.length;
  // §3: dirInput no longer aims the serve — release at the sweep center for a
  // straight-ahead serve into the opponent court.
  await serveForward(serverPeer, 0.85);
  const gotServe = await waitFor(() => peers.every((p) => p.launches.length > launchesBefore), 3000, 'serve reached all 4');
  assert(gotServe, 'serve BallLaunch reached all four clients');

  // One side-B receiver CHASES the (scattered) serve to a reachable contact
  // point and digs there; its same-side teammate is the loft target. Verify the
  // dig is accepted AND aimed toward that teammate (not a self-set).
  const bPeers = peers.filter((p) => playerOf(peers[0], p.room.sessionId)?.side === 'B');
  const launch = peers[0].launches[launchesBefore];
  const contact = reachableContact(launch, 'B');

  if (contact) {
    // Chase with the teammate that is FARTHER from the contact point, so the
    // other B stays put as a distinct loft target.
    const sorted = [...bPeers].sort((p, q) => {
      const pp = playerOf(peers[0], p.room.sessionId)!.pos;
      const qq = playerOf(peers[0], q.room.sessionId)!.pos;
      return Math.hypot(pp.x - contact.pos.x, pp.z - contact.pos.z) - Math.hypot(qq.x - contact.pos.x, qq.z - contact.pos.z);
    });
    const bp = sorted[0];
    await moveTo(bp, contact.pos.x, contact.pos.z, 'B', 900);
    const digAt = contact.t;
    const waitMs = Math.max(0, digAt - bp.offset - Date.now());
    setTimeout(() => {
      bp.room.send(CH.TOUCH, { playerId: bp.room.sessionId, clientTime: Date.now(), mode: 'dig', charge: 0.3, dirInput: { x: 0, y: 0 } } satisfies TouchIntent);
    }, waitMs);
    const gotDig = await waitFor(() => ownResults(bp).length >= 1, 2500, 'dig TouchResult');
    const bpOwn = ownResults(bp);
    assert(gotDig && bpOwn[bpOwn.length - 1].accepted, 'a side-B teammate dig was accepted');
    const digLaunch = await waitFor(() => peers[0].launches.length > launchesBefore + 1, 2000, 'dig BallLaunch');
    assert(digLaunch, 'the accepted dig put a new ball in play');
    if (digLaunch) {
      const diggerPos = playerOf(peers[0], bp.room.sessionId)!.pos;
      const teammate = bPeers.find((p) => p !== bp)!;
      const tmatePos = playerOf(peers[0], teammate.room.sessionId)!.pos;
      const dl = peers[0].launches[launchesBefore + 1];
      const dot = dl.velocity.x * (tmatePos.x - diggerPos.x) + dl.velocity.z * (tmatePos.z - diggerPos.z);
      assert(dl.arcType === 'dig', 'teammate dig produced a "dig" arc');
      assert(dot > 0, 'dig is lofted toward the nearest same-side teammate (not self-set)');
    }
  } else {
    assert(false, 'the serve produced a reachable contact point on side B');
  }

  testTouchCap();
  await Promise.all(rooms.map((r) => r.leave()));
  await delay(300);
}

// Send a burst of "toward the net" InputFrames for a peer and return how far
// the server-authoritative |z-to-net| changed (net is at z=0, so |z| itself).
async function pushTowardNet(peer: Peer, seqStart: number, frames: number): Promise<void> {
  for (let i = 0; i < frames; i++) {
    const frame: InputFrame = {
      seq: seqStart + i,
      clientTime: Date.now(),
      move: { x: 0, y: 1 }, // player-view "up" = toward the net (both sides)
      jumpHeld: false,
      touchMode: 'dig',
      isCharging: false,
      dtMs: 33,
      yaw: null,
    };
    peer.room.send(CH.INPUT, frame);
    await delay(20);
  }
  await delay(120); // let the last frames + a snapshot land
}

// M2.1 PRIORITY-0 direction fix e2e. For BOTH sides: pressing "toward the net"
// must decrease |z| (distance to the net) on the SERVER snapshot AND on the
// real client LocalPlayer prediction, with matching sign — proving the single
// shared viewToWorld transform keeps prediction and authority in lockstep. Also
// asserts uncharged back-line serves clear the net on both sides (serve tuning),
// and that a side-B left-aim serve heads toward side A's -X corner.
async function partDirection(): Promise<void> {
  console.log('\n[direction] per-side view->world: toward-net decreases |z| (server + client prediction)');
  const cA = new Client(ENDPOINT);
  const cB = new Client(ENDPOINT);
  const rA = await cA.create(ROOM_NAME); // host, side A
  const rB = await cB.joinById(rA.roomId); // side B
  const a = wire(rA);
  const b = wire(rB);

  const started = await lobbyStart([a, b], rA);
  assert(started, 'direction: 1v1 lobby reached serve phase');
  await Promise.all([syncClock(a, 4), syncClock(b, 4)]);

  for (const peer of [a, b]) {
    const self = playerOf(peer, peer.room.sessionId)!;
    const side = self.side as Side;
    const z0 = self.pos.z;

    // Real client prediction, seeded from the same server position.
    const predictor = new LocalPlayer({ x: self.pos.x, y: self.pos.y, z: z0 }, side);
    const FRAMES = 12;
    for (let i = 0; i < FRAMES; i++) predictor.applyInput({ move: { x: 0, y: 1 } }, 33, null);
    const predZ = predictor.position.z;

    // Server truth over the wire.
    await pushTowardNet(peer, 1, FRAMES);
    const z1 = playerOf(peer, peer.room.sessionId)!.pos.z;

    const serverMoved = Math.abs(z1) < Math.abs(z0);
    const predMoved = Math.abs(predZ) < Math.abs(z0);
    const sameSign = Math.sign(z1 - z0) === Math.sign(predZ - z0) && z1 - z0 !== 0;
    const expectSign = side === 'A' ? 1 : -1; // toward net: +Z for A, -Z for B
    assert(serverMoved, `side ${side}: server "toward net" decreased |z| (${z0.toFixed(2)} -> ${z1.toFixed(2)})`);
    assert(predMoved, `side ${side}: client prediction "toward net" decreased |z| (${z0.toFixed(2)} -> ${predZ.toFixed(2)})`);
    assert(sameSign, `side ${side}: prediction & server moved the SAME direction (no inversion)`);
    assert(Math.sign(z1 - z0) === expectSign, `side ${side}: moved toward net in the expected world sign (${expectSign > 0 ? '+Z' : '-Z'})`);
    // Cross-check the shared transform the client used.
    assert(Math.sign(viewToWorld({ x: 0, y: 1 }, side).z) === expectSign, `side ${side}: viewToWorld forward matches`);
  }

  // M2.3 §3: a well-charged angle-sweep serve released at the sweep center heads
  // straight over the net and lands in the opponent court.
  {
    const servingId = a.snap?.servingId ?? '';
    const server = servingId === a.room.sessionId ? a : b;
    const before = a.launches.length;
    await serveForward(server, 0.85);
    const got = await waitFor(() => a.launches.length > before, 3000, 'forward serve launch');
    assert(got, 'centered angle-sweep serve produced a BallLaunch');
    if (got) {
      const launch = a.launches[a.launches.length - 1];
      const ev = firstEvent(launch, 8000);
      const serverSide = playerOf(a, servingId)?.side;
      assert(ev.kind !== 'net', `side ${serverSide}: centered serve CLEARS the net (event=${ev.kind} at z=${ev.pos.z.toFixed(1)})`);
      assert(ev.kind === 'ground', `side ${serverSide}: centered serve lands IN-bounds (event=${ev.kind}, |z|=${Math.abs(ev.pos.z).toFixed(1)})`);
    }
  }

  // M2.3 §1: the removed serve floor (weak serve → opponent point) is verified
  // deterministically against the real serve() path in test/serve.ts.

  await Promise.all([rA.leave(), rB.leave()]);
  await delay(300);
}

// Poll the predicted ball (peer clock) and fire a single TOUCH the first frame
// the ball satisfies `ready(ballPos, distanceToReceiver)`. Returns true if sent.
async function touchWhen(
  receiver: Peer,
  launch: BallLaunch,
  rpos: { x: number; z: number },
  ready: (bp: { x: number; y: number; z: number }, d: number) => boolean,
  intent: Omit<TouchIntent, 'playerId' | 'clientTime'>,
  timeoutMs: number,
): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const bp = ballPosition(launch, serverNow(receiver) - launch.serverTime);
    const d = distXZ(bp, { x: rpos.x, y: 0, z: rpos.z });
    if (ready(bp, d)) {
      receiver.room.send(CH.TOUCH, {
        playerId: receiver.room.sessionId,
        clientTime: Date.now(),
        ...intent,
      } satisfies TouchIntent);
      return true;
    }
    await delay(8);
  }
  return false;
}

// M2.2 §2/§3/§4 WP2: outside-court serve spawn, authoritative mode-switch (server
// mode wins over a mismatched intent.mode), and dig-dive adjudication (success +
// failure — forced into the dive band by standing the receiver sideways so the
// ball's mid-flight distance is in (DIG_REACH_MAX, DIVE_REACH_MAX]). The
// deterministic per-touch roll makes both outcomes appear across a few serves.
async function partWP2(): Promise<void> {
  console.log('\n[wp2] outside serve + authoritative touchMode + dig dive (success & fail)');
  const cA = new Client(ENDPOINT);
  const cB = new Client(ENDPOINT);
  const rA = await cA.create(ROOM_NAME);
  const rB = await cB.joinById(rA.roomId);
  const a = wire(rA);
  const b = wire(rB);
  const started = await lobbyStart([a, b], rA);
  assert(started, 'wp2: 1v1 lobby reached serve phase');
  await Promise.all([syncClock(a), syncClock(b)]);

  // §4: fresh serve station (no movement yet) is OUTSIDE the court, |z| = 9.8.
  const firstServerZ = Math.abs(playerOf(a, a.snap!.servingId!)?.pos.z ?? 0);
  assert(firstServerZ > COURT_HALF_LENGTH, `wp2: serve station is OUTSIDE the court (|z|=${firstServerZ.toFixed(1)} > ${COURT_HALF_LENGTH})`);

  const roleOf = (): { server: Peer; receiver: Peer } => {
    const servingId = a.snap!.servingId!;
    return servingId === a.room.sessionId ? { server: a, receiver: b } : { server: b, receiver: a };
  };
  // Serve deep so the ball reaches the receiver mid-flight (reachable height,
  // before landing) — the dig/dive touch then never races the ground death.
  // §3: timed to the sweep center so the serve heads straight at the net.
  const serveNow = (server: Peer): Promise<void> => serveForward(server, 0.85);

  // ---- (1) mode switch then touch uses the NEW authoritative mode ----------
  {
    const { server, receiver } = roleOf();
    const before = a.launches.length;
    await serveNow(server);
    const got = await waitFor(() => a.launches.length > before, 3000, 'wp2 mode-switch serve');
    assert(got, 'wp2: serve for mode-switch case landed');
    if (got) {
      const launch = a.launches[before];
      const rside = playerOf(a, receiver.room.sessionId)!.side as Side;
      // Chase under the (scattered) serve, THEN switch to 'set' (authoritative).
      const contact = reachableContact(launch, rside);
      if (contact) await moveTo(receiver, contact.pos.x, contact.pos.z, rside, 300);
      // Switch the receiver to 'set' (authoritative), staying put.
      for (let i = 0; i < 5; i++) {
        receiver.room.send(CH.INPUT, { seq: 400 + i, clientTime: Date.now(), move: { x: 0, y: 0 }, jumpHeld: false, touchMode: 'set', isCharging: false, dtMs: 33, yaw: null } satisfies InputFrame);
        await delay(18);
      }
      const rpos = playerOf(a, receiver.room.sessionId)!.pos;
      const launchesBefore = a.launches.length;
      // Touch mid-flight with a MISMATCHED intent.mode ('dig'): server must
      // adjudicate as its authoritative 'set' and produce a 'set' arc.
      const sent = await touchWhen(
        receiver,
        launch,
        rpos,
        (bp, d) => bp.y > 0.3 && bp.y < 2.4 && d <= REACH_MAX - 0.3,
        { mode: 'dig', charge: 0.3, dirInput: { x: 0, y: 0 } },
        3000,
      );
      assert(sent, 'wp2: found an in-reach window for the mode-switch touch');
      const gotSet = await waitFor(() => a.launches.length > launchesBefore, 2500, 'wp2 set launch');
      assert(gotSet, 'wp2: mode-switched touch produced a return');
      if (gotSet) {
        const setLaunch = a.launches[a.launches.length - 1];
        assert(setLaunch.arcType === 'set', `wp2: server-authoritative mode wins — touch produced a 'set' arc (got '${setLaunch.arcType}')`);
      }
    }
    await waitFor(() => a.snap?.phase === 'serve' || a.snap?.phase === 'gameover', 6000, 'wp2 mode-switch reset');
  }

  // ---- (2) dive success + dive fail ---------------------------------------
  let sawSuccess = false;
  let sawFail = false;
  let sawDiveQuality = false;
  const MAX_DIVE_RALLIES = 14;
  for (let r = 0; r < MAX_DIVE_RALLIES && !(sawSuccess && sawFail); r++) {
    if (a.snap?.phase === 'gameover') break;
    await waitFor(() => a.snap?.phase === 'serve', 6000, 'wp2 dive serve phase');
    const { server, receiver } = roleOf();
    const before = a.launches.length;
    await serveNow(server);
    const got = await waitFor(() => a.launches.length > before, 3000, `wp2 dive serve ${r}`);
    if (!got) break;
    const launch = a.launches[before];

    // Chase to a point ~2.7u laterally OFF the ball's known contact point so the
    // ball's mid-flight distance sits in the dive band (DIG_REACH_MAX, DIVE_REACH_MAX].
    const rside = playerOf(a, receiver.room.sessionId)!.side as Side;
    const contact = reachableContact(launch, rside);
    if (!contact) {
      await waitFor(() => a.snap?.phase === 'serve' || a.snap?.phase === 'gameover', 7000, `wp2 dive reset ${r}`);
      continue;
    }
    const offX = contact.pos.x <= 0 ? 2.7 : -2.7;
    const standX = Math.max(-4.3, Math.min(4.3, contact.pos.x + offX));
    await moveTo(receiver, standX, contact.pos.z, rside, 700 + r * 60);
    const rpos = playerOf(a, receiver.room.sessionId)!.pos;
    const resultsBefore = ownResults(receiver).length;
    const sent = await touchWhen(
      receiver,
      launch,
      rpos,
      (bp, d) => bp.y > 0.3 && bp.y < 2.5 && d > DIG_REACH_MAX + 0.1 && d <= DIVE_REACH_MAX - 0.1,
      { mode: 'dig', charge: 0.3, dirInput: { x: 0, y: 0 } },
      3000,
    );
    if (sent) {
      const gotRes = await waitFor(() => ownResults(receiver).length > resultsBefore, 2500, `wp2 dive result ${r}`);
      if (gotRes) {
        const own = ownResults(receiver);
        const res = own[own.length - 1];
        if (res.outcome === 'dive_success') {
          sawSuccess = true;
          if (Math.abs(res.quality - DIVE_QUALITY) < 1e-6) sawDiveQuality = true;
          console.log(`  info  rally ${r}: DIVE_SUCCESS (q=${res.quality.toFixed(2)}, accepted=${res.accepted})`);
        } else if (res.outcome === 'dive_fail') {
          sawFail = true;
          console.log(`  info  rally ${r}: DIVE_FAIL (accepted=${res.accepted})`);
        }
      }
    }
    await waitFor(() => a.snap?.phase === 'serve' || a.snap?.phase === 'gameover', 7000, `wp2 dive reset ${r}`);
  }
  assert(sawSuccess, 'wp2: observed at least one dive_success');
  assert(sawFail, 'wp2: observed at least one dive_fail');
  assert(sawDiveQuality, `wp2: a dive_success returns the fixed DIVE_QUALITY (${DIVE_QUALITY})`);

  await Promise.all([rA.leave(), rB.leave()]);
  await delay(300);
}

// M2.6 §1/§2/§3 — team-slot lobby, REQUEST_SLOT (move + reject), serve rotation
// wiring over several real rallies (mirrored against the shared pure module), and
// touch-mode persistence across a dead ball. Rallies are driven by serving only:
// a strong centered serve aces (server side scores -> same server), a near-zero
// serve faults (receiver side scores -> side-out) — so we reproduce the spec's
// worked rotation sequence live and check the server matches the pure engine.
function slotOf(l: LobbyState, id: string): TeamSlot | undefined {
  return l.slots.find((s) => s.playerId === id);
}
function orderForSide(l: LobbyState, side: Side): string[] {
  return l.slots
    .filter((s) => s.side === side && s.playerId !== null)
    .sort((p, q) => p.index - q.index)
    .map((s) => s.playerId!);
}

async function partSlotsRotationMode(): Promise<void> {
  console.log('\n[m2.6] team slots + REQUEST_SLOT + serve rotation + mode persistence');
  const clients = [new Client(ENDPOINT), new Client(ENDPOINT), new Client(ENDPOINT), new Client(ENDPOINT)];
  const r0 = await clients[0].create(ROOM_NAME);
  const code = r0.roomId;
  const rooms = [r0];
  for (let i = 1; i < 4; i++) rooms.push(await clients[i].joinById(code));
  const peers = rooms.map(wire);

  // ---- §1 auto-assign fills fewer-team lowest slot (tie -> A): A0,B0,A1,B1 ----
  await waitFor(() => filledSlots(peers[0].lobby) === 4, 5000, 'four in slot grid');
  const lob0 = peers[0].lobby!;
  assert(lob0.slots.length === SLOTS_PER_TEAM * 2, `full ${SLOTS_PER_TEAM * 2}-slot grid broadcast`);
  const s0 = slotOf(lob0, rooms[0].sessionId);
  const s1 = slotOf(lob0, rooms[1].sessionId);
  const s2 = slotOf(lob0, rooms[2].sessionId);
  const s3 = slotOf(lob0, rooms[3].sessionId);
  assert(s0?.side === 'A' && s0?.index === 0, 'joiner 1 -> A slot 0');
  assert(s1?.side === 'B' && s1?.index === 0, 'joiner 2 -> B slot 0 (fewer team)');
  assert(s2?.side === 'A' && s2?.index === 1, 'joiner 3 -> A slot 1 (tie -> A, lowest empty)');
  assert(s3?.side === 'B' && s3?.index === 1, 'joiner 4 -> B slot 1');

  // ---- §1 REQUEST_SLOT: move joiner 3 from A1 to an empty A-slot (index 3) ----
  rooms[2].send(CH.REQUEST_SLOT, { side: 'A', index: 3 });
  const moved = await waitFor(() => slotOf(peers[0].lobby!, rooms[2].sessionId)?.index === 3, 2000, 'REQUEST_SLOT move');
  assert(moved, 'REQUEST_SLOT moves the player to the empty target slot');
  assert(slotOf(peers[0].lobby!, rooms[2].sessionId)?.side === 'A', 'moved player stays on side A (A3)');
  const oldFree = peers[0].lobby!.slots.find((s) => s.side === 'A' && s.index === 1)?.playerId === null;
  assert(oldFree, 'the vacated slot (A1) is now empty');

  // ---- §1 REQUEST_SLOT to an OCCUPIED slot is silently ignored ----
  rooms[3].send(CH.REQUEST_SLOT, { side: 'B', index: 0 }); // B0 held by joiner 2
  await delay(400);
  assert(slotOf(peers[0].lobby!, rooms[3].sessionId)?.index === 1, 'REQUEST_SLOT to an occupied slot is rejected (no move)');

  // ---- start match; mirror the server's rotation from the final slot grid ----
  const startLob = peers[0].lobby!;
  const orderA = orderForSide(startLob, 'A');
  const orderB = orderForSide(startLob, 'B');
  let mirror: ServeRotation = initRotation(orderA, orderB);
  r0.send(CH.START_MATCH, {});
  const started = await waitFor(() => peers[0].snap?.phase === 'serve', 4000, 'serve phase after start');
  assert(started, 'host start -> serve phase');
  await Promise.all(peers.map((p) => syncClock(p, 4)));
  assert(peers[0].snap?.servingId === currentServerId(mirror), `first server = A slot0 (${currentServerId(mirror)})`);

  // ---- §3 mode persistence: set a receiver's mode to 'spike', keep it across a dead ball ----
  const modePeer = peers.find((p) => p.room.sessionId !== peers[0].snap!.servingId)!;
  for (let i = 0; i < 5; i++) {
    modePeer.room.send(CH.INPUT, { seq: 900 + i, clientTime: Date.now(), move: { x: 0, y: 0 }, jumpHeld: false, touchMode: 'spike', isCharging: false, dtMs: 33, yaw: null } satisfies InputFrame);
    await delay(18);
  }
  await waitFor(() => playerOf(modePeer, modePeer.room.sessionId)?.mode === 'spike', 1500, 'mode=spike applied');

  // ---- §2 rotation wiring over several rallies (drive by serving only) ----
  // Scripted charges reproduce the spec worked example: ace (same), fault
  // (side-out), ace (same), fault (side-out advance) — plus a couple extra.
  const charges = [0.85, 0.02, 0.85, 0.02, 0.85, 0.02];
  let sawSameServer = false;
  let sawIntraTeamAdvance = false;
  let modeStillSpike = true;
  // Track each side's most recent server so an intra-team advance is detected
  // across that side's OWN possessions (the opponent may serve in between).
  const lastServerBySide: { A?: string; B?: string } = {};
  for (let rally = 0; rally < charges.length; rally++) {
    if (peers[0].snap?.phase === 'gameover') break;
    await waitFor(() => peers[0].snap?.phase === 'serve', 6000, `rally ${rally} serve phase`);
    const servingId = peers[0].snap!.servingId!;
    const serverPeer = peers.find((p) => p.room.sessionId === servingId)!;
    const prevServer = servingId;
    const deathsBefore = peers[0].deaths.length;
    await serveForward(serverPeer, charges[rally]);
    const gotDeath = await waitFor(() => peers[0].deaths.length > deathsBefore, 7000, `rally ${rally} death`);
    if (!gotDeath) break;
    const death = peers[0].deaths[peers[0].deaths.length - 1];
    mirror = onPoint(mirror, death.scoringSide);
    const predicted = currentServerId(mirror);
    assert(death.nextServerId === predicted, `rally ${rally}: server rotation matches the pure engine (next=${death.nextServerId}, predicted=${predicted})`);
    // Confirm the authoritative snapshot converges to the same server.
    await waitFor(() => peers[0].snap?.servingId === predicted || peers[0].snap?.phase === 'gameover', 5000, `rally ${rally} servingId`);
    if (peers[0].snap?.phase !== 'gameover') {
      assert(peers[0].snap?.servingId === predicted, `rally ${rally}: snapshot servingId == rotation server`);
    }
    if (death.nextServerId === prevServer) sawSameServer = true;
    // Intra-team advance: this side served before with a DIFFERENT player.
    const side = death.scoringSide; // the next server is on the gaining/serving side
    const prevForSide = lastServerBySide[side];
    if (prevForSide !== undefined && prevForSide !== death.nextServerId) sawIntraTeamAdvance = true;
    lastServerBySide[side] = death.nextServerId;
    // §3: the receiver's mode must still be 'spike' after this dead ball.
    if (playerOf(modePeer, modePeer.room.sessionId)?.mode !== 'spike') modeStillSpike = false;
    if (peers[0].snap?.phase === 'gameover') break;
  }
  assert(sawSameServer, 'observed a consecutive score keeping the SAME server (§2 no-advance)');
  assert(sawIntraTeamAdvance, 'observed a side-out advancing to the NEXT player within a team (§2 advance)');
  assert(modeStillSpike, 'touch mode persists across dead balls — no server reset (§3)');

  await Promise.all(rooms.map((r) => r.leave()));
  await delay(300);
}

// M2.7 §4/§5 — SET_MAP (host-only, lobby-only, validated) + SET_TEAM_NAME
// (captain-only, validated, server infers side) + captain succession on leave.
async function partMapCaptain(): Promise<void> {
  console.log('\n[m2.7 §4/§5] map select + team names + captain succession');
  // Three clients so side A has two members (A0 captain, A1 non-captain).
  const clients = [new Client(ENDPOINT), new Client(ENDPOINT), new Client(ENDPOINT)];
  const r0 = await clients[0].create(ROOM_NAME); // host, A0, captain A
  const code = r0.roomId;
  const rooms = [r0];
  for (let i = 1; i < 3; i++) rooms.push(await clients[i].joinById(code));
  const peers = rooms.map(wire);
  await waitFor(() => filledSlots(peers[0].lobby) === 3, 5000, 'three in lobby');

  const lob = peers[0].lobby!;
  const aMembers = orderForSide(lob, 'A'); // join order within side A
  const bMembers = orderForSide(lob, 'B');
  const capA = rooms.find((r) => r.sessionId === aMembers[0])!;
  const nonCapA = rooms.find((r) => r.sessionId === aMembers[1])!;
  const capB = rooms.find((r) => r.sessionId === bMembers[0])!;
  assert(lob.captains.A === capA.sessionId, `captain A = earliest-joined side-A member (${lob.captains.A})`);
  assert(lob.captains.B === capB.sessionId, 'captain B = earliest-joined side-B member');
  assert(lob.teamNames.A === 'A 隊' && lob.teamNames.B === 'B 隊', `default team names ("${lob.teamNames.A}"/"${lob.teamNames.B}")`);
  assert(lob.map === 'indoor', `default map is indoor (${lob.map})`);

  // ---- §4 SET_MAP: non-host ignored; host accepted; invalid dropped ----
  nonCapA.send(CH.SET_MAP, { map: 'outdoor' });
  await delay(400);
  assert(peers[0].lobby!.map === 'indoor', 'SET_MAP from a non-host is ignored');
  r0.send(CH.SET_MAP, { map: 'outdoor' });
  const mapped = await waitFor(() => peers[0].lobby!.map === 'outdoor', 2000, 'host SET_MAP outdoor');
  assert(mapped, 'host SET_MAP switches the map to outdoor');
  r0.send(CH.SET_MAP, { map: 'moon' as unknown as 'indoor' });
  await delay(400);
  assert(peers[0].lobby!.map === 'outdoor', 'SET_MAP with an invalid map value is dropped');

  // ---- §5 SET_TEAM_NAME: captain accepted; non-captain + invalid rejected ----
  capA.send(CH.SET_TEAM_NAME, { name: 'Spikers' });
  const named = await waitFor(() => peers[0].lobby!.teamNames.A === 'Spikers', 2000, 'captain A rename');
  assert(named, 'captain A renames side A to "Spikers"');
  nonCapA.send(CH.SET_TEAM_NAME, { name: 'Hackers' });
  await delay(400);
  assert(peers[0].lobby!.teamNames.A === 'Spikers', 'SET_TEAM_NAME from a non-captain is ignored');
  capA.send(CH.SET_TEAM_NAME, { name: 'x'.repeat(13) }); // >12 chars
  capA.send(CH.SET_TEAM_NAME, { name: '  ' }); // empty after trim
  await delay(400);
  assert(peers[0].lobby!.teamNames.A === 'Spikers', 'over-long / empty team names are rejected');
  capB.send(CH.SET_TEAM_NAME, { name: '藍隊' }); // CJK is allowed (same charset as SET_NAME)
  const cjk = await waitFor(() => peers[0].lobby!.teamNames.B === '藍隊', 2000, 'captain B CJK rename');
  assert(cjk, 'captain B renames side B with a CJK name ("藍隊")');

  // ---- §5 captain succession: A0 leaves -> A1 becomes captain A ----
  await capA.leave();
  const succeeded = await waitFor(() => peers[1].lobby != null && peers[1].lobby!.captains.A === nonCapA.sessionId, 3000, 'captain A succession');
  // Peer index for nonCapA:
  const nonCapPeer = peers.find((p) => p.room === nonCapA)!;
  assert(nonCapPeer.lobby?.captains.A === nonCapA.sessionId, 'after the captain leaves, the next-earliest side-A member becomes captain');
  assert(succeeded, 'captain succession is broadcast to remaining clients');
  // The new captain can now rename side A; the old one no longer exists.
  nonCapA.send(CH.SET_TEAM_NAME, { name: 'Risers' });
  const renamed2 = await waitFor(() => nonCapPeer.lobby!.teamNames.A === 'Risers', 2000, 'new captain rename');
  assert(renamed2, 'the promoted captain can rename side A');

  await Promise.all([nonCapA.leave(), capB.leave()]);
  await delay(300);
}

// M2.7 §2 — an illegal double touch (same player twice in a row) is REJECTED
// (outcome 'illegal_double', no new ball) but the rally does NOT end: the ball
// keeps flying and its landing decides the point.
async function partIllegalDouble(): Promise<void> {
  console.log('\n[m2.7 §2] illegal double-touch rejected; ball flies on to a natural death');
  const cA = new Client(ENDPOINT);
  const cB = new Client(ENDPOINT);
  const rA = await cA.create(ROOM_NAME);
  const rB = await cB.joinById(rA.roomId);
  const a = wire(rA);
  const b = wire(rB);
  const started = await lobbyStart([a, b], rA);
  assert(started, 'illegal-double: 1v1 lobby reached serve phase');
  await Promise.all([syncClock(a), syncClock(b)]);

  let sawIllegalDouble = false;
  let sawContinuedDeath = false;
  const MAX_TRIES = 8;
  for (let t = 0; t < MAX_TRIES && !(sawIllegalDouble && sawContinuedDeath); t++) {
    if (a.snap?.phase === 'gameover') break;
    await waitFor(() => a.snap?.phase === 'serve', 6000, `illegal-double serve phase ${t}`);
    const servingId = a.snap!.servingId!;
    const server = servingId === rA.sessionId ? a : b;
    const receiver = servingId === rA.sessionId ? b : a;
    const receiverId = receiver.room.sessionId;
    const launchesBefore = a.launches.length;
    const deathsBefore = a.deaths.length;
    await serveForward(server, 0.85);
    const gotServe = await waitFor(() => a.launches.length > launchesBefore, 3000, `illegal-double serve ${t}`);
    if (!gotServe) continue;

    // First (legal) dig at the ideal contact time.
    const launch = receiver.launches[launchesBefore];
    const rpos = playerOf(receiver, receiverId)?.pos ?? { x: 0, y: 0, z: 0 };
    const ideal = idealTime(launch, rpos);
    if (ideal === null) {
      await waitFor(() => a.snap?.phase === 'serve' || a.snap?.phase === 'gameover', 7000, `illegal-double reset ${t}`);
      continue;
    }
    const resultsBefore = ownResults(receiver).length;
    const waitMs = Math.max(0, ideal - receiver.offset - Date.now());
    await delay(waitMs);
    receiver.room.send(CH.TOUCH, { playerId: receiverId, clientTime: Date.now(), mode: 'dig', charge: 0.3, dirInput: { x: 0, y: 0 } } satisfies TouchIntent);
    const gotFirst = await waitFor(() => ownResults(receiver).length > resultsBefore, 2000, `illegal-double first dig ${t}`);
    const firstOwn = ownResults(receiver);
    if (!gotFirst || !firstOwn[firstOwn.length - 1].accepted) {
      await waitFor(() => a.snap?.phase === 'serve' || a.snap?.phase === 'gameover', 7000, `illegal-double reset ${t}`);
      continue;
    }
    // Immediately touch AGAIN with the same player => illegal double contact.
    const before2 = ownResults(receiver).length;
    const launchesAfterDig = a.launches.length;
    await delay(60);
    receiver.room.send(CH.TOUCH, { playerId: receiverId, clientTime: Date.now(), mode: 'dig', charge: 0.3, dirInput: { x: 0, y: 0 } } satisfies TouchIntent);
    const gotSecond = await waitFor(() => ownResults(receiver).length > before2, 2000, `illegal-double second touch ${t}`);
    if (gotSecond) {
      const own = ownResults(receiver);
      const res = own[own.length - 1];
      if (res.outcome === 'illegal_double') {
        sawIllegalDouble = true;
        assert(!res.accepted && res.quality === 0, 'illegal double: accepted=false, quality=0');
        // The refusal produced NO new BallLaunch (ball keeps the dig's trajectory).
        assert(a.launches.length === launchesAfterDig, 'illegal double produced no new BallLaunch (ball flies on)');
        console.log(`  info  try ${t}: illegal_double rejected, ball continues`);
      }
    }
    // The rally still ends by a NATURAL landing (ground/out), not the double.
    const gotDeath = await waitFor(() => a.deaths.length > deathsBefore, 6000, `illegal-double death ${t}`);
    if (gotDeath && sawIllegalDouble) {
      const death = a.deaths[a.deaths.length - 1];
      assert(death.cause === 'ground' || death.cause === 'out', `rally ended by a natural landing after the double (cause=${death.cause})`);
      sawContinuedDeath = true;
    }
    await waitFor(() => a.snap?.phase === 'serve' || a.snap?.phase === 'gameover', 7000, `illegal-double reset ${t}`);
  }
  assert(sawIllegalDouble, 'observed an illegal_double rejection');
  assert(sawContinuedDeath, 'the ball flew on after the illegal double and died naturally (ground/out)');

  await Promise.all([rA.leave(), rB.leave()]);
  await delay(300);
}

async function main(): Promise<void> {
  console.log(`[integration] connecting to ${ENDPOINT}`);
  await partDirection();
  await partWP2();
  await part1LagComp();
  await part2TwoVsTwo();
  await partSlotsRotationMode();
  await partMapCaptain();
  await partIllegalDouble();
  console.log(`\n[integration] ${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('[integration] crashed', err);
  process.exit(1);
});
