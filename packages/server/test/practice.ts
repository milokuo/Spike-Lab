// M2.9 §2 — practice sandbox verification (tsx, non-vitest; jitter.ts pattern).
//
// Boots the REAL MatchRoom in-process on port 2601 and drives it with a REAL
// colyseus.js client. Three assertions (spec §2):
//   1. create(ROOM_NAME, {mode:'practice'}) auto-enters serve phase with
//      servingId === self within 1000ms — NO START_MATCH is ever sent.
//   2. A serve that lands broadcasts a DEATH with the score frozen at 0:0, and
//      after RESET_DELAY the room returns to serve (infinite re-serve loop).
//   3. A versus room (no options) is unaffected: it stays in lobby and the
//      canStart gate is unchanged (a single player => canStart === false).
//
// Run: `npx tsx test/practice.ts` (from packages/server) or `npm run practice`.
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client, type Room } from 'colyseus.js';
import {
  CH,
  ROOM_NAME,
  ROOM_MODE_PRACTICE,
  type DeathEvent,
  type LobbyState,
  type StateSnapshot,
  type TouchIntent,
  type TouchResult,
} from '@spike/shared';
import { MatchRoom } from '../src/rooms/MatchRoom';
import { RESET_DELAY_MS } from '../src/config';

const PORT = 2601;
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  PASS  ${msg}`);
  else {
    console.error(`  FAIL  ${msg}`);
    failures++;
  }
}

// Assertions 1 + 2: practice auto-start, scoring freeze, and the re-serve loop.
async function testPractice(client: Client): Promise<void> {
  const room: Room = await client.create(ROOM_NAME, { mode: ROOM_MODE_PRACTICE });

  let firstServe: StateSnapshot | null = null;
  let death: DeathEvent | null = null;
  let reServed = false;
  const touchResults: TouchResult[] = [];
  room.onMessage(CH.SNAPSHOT, (snap: StateSnapshot) => {
    if (!firstServe && snap.phase === 'serve' && snap.servingId === room.sessionId) firstServe = snap;
    // A serve snapshot seen AFTER the death => the sandbox re-armed itself.
    if (death && snap.phase === 'serve') reServed = true;
  });
  room.onMessage(CH.DEATH, (d: DeathEvent) => {
    if (!death) death = d;
  });
  room.onMessage(CH.TOUCH_RESULT, (r: TouchResult) => touchResults.push(r));

  // (1) auto-enter serve within 1000ms, without any START_MATCH.
  const t0 = Date.now();
  while (!firstServe && Date.now() - t0 < 1000) await delay(20);
  assert(
    firstServe !== null,
    '(1) practice auto-enters serve (servingId=self) within 1000ms — no START_MATCH',
  );
  if (!firstServe) {
    await room.leave();
    return;
  }

  // (2) serve; the ball lands -> DEATH with score frozen 0:0; then re-serve.
  const intent: TouchIntent = {
    playerId: room.sessionId,
    clientTime: Date.now(),
    mode: 'spike', // serve ignores mode/dirInput (angle-sweep); charge drives distance
    charge: 0.8,
    dirInput: { x: 0, y: 0 },
  };
  room.send(CH.TOUCH, intent);

  // Wait for the serve's own TOUCH_RESULT so the next index unambiguously
  // belongs to the juggle touch below (ordered delivery on one connection).
  const tServeResult = Date.now();
  while (touchResults.length < 1 && Date.now() - tServeResult < 1000) await delay(20);

  // (2c) §2 touch-relaxation gap: serve() itself registers the lone player as
  // the rally's last toucher (registerTouch in MatchSim.serve), so the very
  // NEXT touch by the same player is exactly the same-player/same-side shape
  // that classifyTouch flags illegal_double for in a versus room. Practice
  // must bypass that gate (self-juggle) — fire a second TOUCH immediately and
  // assert its outcome is never illegal_double/illegal_count, regardless of
  // whether the ball happened to be in reach (accepted is not required here).
  const resultsBeforeJuggle = touchResults.length;
  room.send(CH.TOUCH, { ...intent, clientTime: Date.now() } satisfies TouchIntent);
  const tJuggle = Date.now();
  while (touchResults.length <= resultsBeforeJuggle && Date.now() - tJuggle < 1000) await delay(20);
  const juggle = touchResults[resultsBeforeJuggle] ?? null;
  assert(
    juggle !== null && juggle.outcome !== 'illegal_double' && juggle.outcome !== 'illegal_count',
    '(2c) practice self-juggle: consecutive same-player touch is not rejected as illegal_double/illegal_count',
  );

  const tDeath = Date.now();
  while (!death && Date.now() - tDeath < 5000) await delay(20);
  const d: DeathEvent | null = death;
  assert(
    d !== null && d.score.A === 0 && d.score.B === 0,
    '(2a) serve lands -> DEATH broadcast with score frozen at 0:0',
  );

  const tRe = Date.now();
  while (!reServed && Date.now() - tRe < RESET_DELAY_MS + 3000) await delay(20);
  assert(reServed, '(2b) after RESET_DELAY the sandbox returns to serve (infinite loop)');

  await room.leave();
  await delay(100);
}

// Assertion 3: a versus room (no create options) is completely unaffected.
async function testVersusUnchanged(client: Client): Promise<void> {
  const room: Room = await client.create(ROOM_NAME); // no options => versus

  let lobby: LobbyState | null = null;
  let sawServe = false;
  room.onMessage(CH.LOBBY_STATE, (l: LobbyState) => {
    lobby = l;
  });
  room.onMessage(CH.SNAPSHOT, (snap: StateSnapshot) => {
    if (snap.phase === 'serve') sawServe = true;
  });

  // Wait well past PRACTICE_AUTOSTART_MS (300): a practice room would have served
  // by now. A versus room must still be sitting in the lobby.
  await delay(1000);
  const l: LobbyState | null = lobby;
  assert(l !== null && !sawServe, '(3a) versus room (no options) stays in lobby — never auto-serves');
  assert(l !== null && l.canStart === false, '(3b) versus canStart gate unchanged (1 player => false)');

  await room.leave();
  await delay(100);
}

async function main(): Promise<void> {
  const server = new Server({ transport: new WebSocketTransport() });
  server.define(ROOM_NAME, MatchRoom);
  await server.listen(PORT, '127.0.0.1');
  const client = new Client(`ws://127.0.0.1:${PORT}`);

  try {
    await testPractice(client);
    await testVersusUnchanged(client);
  } finally {
    await server.gracefullyShutdown(false);
  }

  if (failures === 0) console.log('\n  PASS  practice sandbox (3 assertions)');
  else console.error(`\n  ${failures} assertion(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('[practice] fatal', err);
  process.exit(1);
});
