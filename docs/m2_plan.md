# SPIKE LAB — M2 Vertical Slice Plan

> Goal: two players on the same home LAN (Windows 11 host) play authoritative 1v1
> volleyball to 15 points, with client prediction, lag-compensated touch
> adjudication, and deterministic pure-function ballistics.
> Scope = minimal M0/M1 core + M2 networking. Out of scope: skill blocks §8,
> tension §7.3, hex §11, 4v4, meme replay, Rapier, matchmaking.

---

## 0. Locked Decisions & Versions

| Decision | Choice | Justification |
|---|---|---|
| Package manager | **npm workspaces** | pnpm confirmed NOT installed on host; npm 10.9 ships with Node 22. Zero extra setup. |
| Node | **>= 18** (dev host runs 22.17.0) | Colyseus 0.17 + Vite require Node 18+. CI/README asserts `node >= 18`. |
| Language/build | **TypeScript 5.x + Vite** | Isomorphic quality fn + ballistics shared across packages (spec §13.1). |
| Networking | **Colyseus 0.16.x** (`colyseus`, `@colyseus/schema` 2.x pairing) | Spec §13 prefers Colyseus. 0.16 is the last widely-documented stable line; 0.17.10 exists but pairs with schema 4.0 (newer decorators, less battle-tested). For a 2-player room the risk of a churning API outweighs the newness. **If `npm i` resolves 0.16 cleanly, keep it; if blocked, fall back to 0.17.10 + @colyseus/schema 4 — WP2 owner decides at install time and reports.** |
| State sync strategy | **Schema for low-frequency authoritative state only** (players, score, phase, serving). **Ball is NOT in schema** — broadcast as `BallLaunch` messages; both ends replay the pure-function trajectory (§6.4). | Keeps schema tiny, avoids 30Hz ball patches, matches spec's "no per-frame ball sync" rule. |
| Physics | **Hand-rolled**: closed-form parabola + AABB/plane checks for net & ground. No Rapier. | Per task scope; minimal deps. |
| Three.js | **three ^0.180** (latest 0.185.1 acceptable) | Standard low-poly renderer. |
| Vite | **vite ^6** (7/8 available; pin 6 for stability) | Node 22 compatible; broad plugin stability. |
| Rally target | **15, win by 2, cap 21** (§9) | |

**Colyseus schema overhead call (3 lines):** State is 2 players + 4 scalars, patched at
30Hz — trivially inside schema's delta-encoding sweet spot. The ball (the only
high-frequency object) is deliberately kept OUT of schema and sent as launch packets,
so schema never becomes a bottleneck. Colyseus stays; no hand-rolled `ws` sync needed.

---

## 1. File Tree (each file < 400 lines, small focused modules)

```
VolleyBallGame/
├── package.json                      # root: npm workspaces + top-level scripts (dev/build/test)
├── tsconfig.base.json                # shared compiler options, path aliases to @spike/shared
├── .gitignore                        # node_modules, dist, .vite
├── docs/
│   └── m2_plan.md                    # this file
│
├── packages/shared/                  # isomorphic types + pure logic (NO runtime deps)
│   ├── package.json                  # name @spike/shared, exports src/index.ts
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts                  # barrel: re-exports all public types + fns
│   │   ├── constants.ts              # §16 numeric table (GRAVITY, PERFECT_WINDOW_MS, base_scatter, etc.)
│   │   ├── channels.ts               # string-literal message channel names (single source of truth)
│   │   ├── math/vec3.ts              # Vec3 type + pure add/scale/sub/dist/len helpers (immutable)
│   │   ├── types/messages.ts         # wire contracts: TouchIntent, BallLaunch, Ping/Pong, InputFrame, StateSnapshot, DeathEvent, TouchResult
│   │   ├── types/state.ts            # PlayerState, MatchPhase, Side, ScoreState (plain interfaces mirrored by schema)
│   │   ├── types/blocks.ts           # BlockDef/PendingBlock/SkillSlotConfig (types only; optional in BallLaunch — logic out of scope)
│   │   ├── quality/fDistance.ts      # f_distance(d) piecewise §6.2 (pure)
│   │   ├── quality/fTiming.ts        # f_timing(Δt) piecewise §6.2 (pure)
│   │   ├── quality/charge.ts         # charge→distance multiplier §6.2 (pure)
│   │   ├── quality/quality.ts        # computeQuality(d, Δt) = clamp01(f_distance × f_timing) §6.1
│   │   ├── intent/direction.ts       # §5.1: (mode, dirInput, charge) → intended launch direction+arc
│   │   ├── ballistics/trajectory.ts  # ballPosition/ballVelocity(launch, elapsedMs) closed-form; sampleUntilEvent()
│   │   └── ballistics/launch.ts      # buildBallLaunch(resolvedTouch) → BallLaunch (velocity from intent×quality×charge)
│   └── test/
│       ├── quality.test.ts           # f_distance, f_timing, charge, composed quality (WP1 unit tests)
│       ├── ballistics.test.ts        # determinism: same launch+t on two evals → identical Vec3; ground/net event timing
│       └── direction.test.ts         # §5.1 direction intent table cases
│
├── packages/server/                  # Colyseus authoritative server
│   ├── package.json                  # name @spike/server, deps: colyseus, @colyseus/schema, @spike/shared
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                  # bootstrap: listen on HOST 0.0.0.0 : PORT 2567, register MatchRoom
│       ├── config.ts                 # PORT/HOST, RING_BUFFER_TICKS, TICK_HZ=30, room name
│       ├── rooms/MatchRoom.ts        # lifecycle, 30Hz setSimulationInterval, message handlers, 2-seat assignment
│       ├── rooms/schema/MatchState.ts# @spike schema root: MapSchema<PlayerState>, ScoreState, phase, servingId
│       ├── rooms/schema/PlayerState.ts# schema: id, side, x/y/z, stamina, lastProcessedInputSeq
│       ├── sim/clockSync.ts          # per-client clock offset from ping/pong; clientTime→serverTime
│       ├── sim/ballRingBuffer.ts     # ring buffer: ball {pos,vel} per server tick, query(serverTime)→interpolated pos
│       ├── sim/ballServer.ts         # authoritative ball: holds active BallLaunch, advances, detects death events
│       ├── sim/lagComp.ts            # adjudicateTouch(intent, offset): rewind ball+player, compute d,Δt,quality
│       ├── game/rally.ts             # touch-count rules §5, serve, death→who-scores, reset positions
│       └── game/scoring.ts           # rally-point to 15, win-by-2, cap 21 §9 (pure)
│
└── packages/client/                  # Vite + Three.js
    ├── package.json                  # name @spike/client, deps: three, colyseus.js, @spike/shared; dev: vite
    ├── tsconfig.json
    ├── vite.config.ts                # server.host '0.0.0.0', port 5173, strictPort
    ├── index.html                    # canvas mount + HUD root
    └── src/
        ├── main.ts                   # bootstrap: connect → build scene → start loop
        ├── config.ts                 # derive ws URL from location.hostname; render constants
        ├── net/connection.ts         # Colyseus Client, joinOrCreate(ROOM_NAME), room ref
        ├── net/clockSync.ts          # client half of ping/pong; maintains estimated serverTimeNow()
        ├── net/messages.ts           # typed send()/on() wrappers over channels.ts
        ├── scene/renderer.ts         # WebGLRenderer, 45° follow camera, rAF loop (60fps interp)
        ├── scene/court.ts            # low-poly court (18×9), net (plane), ground, boundary lines
        ├── scene/ball.ts             # ball mesh; position from replayTrajectory(activeLaunch, serverTimeNow)
        ├── scene/player.ts           # capsule mesh factory (local + remote)
        ├── input/keyboard.ts         # WASD/arrows, space jump, J/K/L, dirInput sampling, charge timer
        ├── player/localPlayer.ts     # prediction: apply input immediately + buffer; reconcile on snapshot
        ├── player/remotePlayer.ts    # interpolate remote player between snapshots (render-delay buffer)
        └── hud/hud.ts                # score, PERFECT/GOOD/OK popups, stamina bar
```

---

## 2. Cross-Package Contracts (parallel-implementation source of truth)

All of the following live in `packages/shared/src`. **Server and client agents implement
ONLY against these; they never need to read each other's code.** Adapted from spec §14.

### 2.1 `math/vec3.ts`

```typescript
export interface Vec3 { x: number; y: number; z: number; }

export const vec3   = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
export const add    = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub    = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale  = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const len    = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const dist   = (a: Vec3, b: Vec3): number => len(sub(a, b));
export const distXZ = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z); // horizontal §6.2
```
> Convention: **Y is up**, court lies on the X–Z plane. Ground = `y = 0`. Net is the plane `z = 0`, height `NET_HEIGHT`.

### 2.2 `channels.ts` — message channel names (both ends import these)

```typescript
export const ROOM_NAME = 'match';

export const CH = {
  // client → server
  PING:   'ping',
  INPUT:  'input',   // movement input frame (prediction/reconciliation)
  TOUCH:  'touch',   // touch intent (J/K/L)
  // server → client
  PONG:       'pong',
  SNAPSHOT:   'snapshot',    // authoritative player states (schema also patches; snapshot carries ack seq)
  BALL_LAUNCH:'ballLaunch',  // new pure-function ball trajectory
  TOUCH_RESULT:'touchResult',// feedback to the toucher (PERFECT/GOOD/OK + quality)
  DEATH:      'death',       // rally ended (point scored)
} as const;
```

### 2.3 `types/messages.ts` — wire contracts

```typescript
import { Vec3 } from '../math/vec3';
import { BlockDef, PendingBlock } from './blocks';

export type Mode    = 'dig' | 'set' | 'spike';
export type ArcType = 'dig' | 'set' | 'spike' | 'serve';
export type Axis    = -1 | 0 | 1;

/* ---- clock sync ---- */
export interface Ping { clientTime: number; }                          // client→server
export interface Pong { clientTime: number; serverTime: number; }      // server→client (echoes clientTime)

/* ---- movement (prediction / reconciliation) ---- */
export interface InputFrame {                 // client→server, CH.INPUT
  seq: number;                                // monotonically increasing per client
  clientTime: number;
  move: { x: Axis; y: Axis };                 // 8-dir intent (y here = forward/back on court's Z)
  jump: boolean;
  dtMs: number;                               // frame delta this input covers
}

export interface PlayerSnapshot {             // element of StateSnapshot
  id: string;
  side: Side;
  pos: Vec3;
  stamina: number;                            // 0..100 §7
  lastProcessedSeq: number;                   // for reconciliation of THIS player
}

export interface StateSnapshot {              // server→client, CH.SNAPSHOT, 30Hz
  serverTime: number;
  players: PlayerSnapshot[];
  score: ScoreState;
  phase: MatchPhase;
  servingId: string | null;
}

/* ---- touch (J/K/L) ---- */
export interface TouchIntent {                // client→server, CH.TOUCH  (spec §14)
  playerId: string;
  clientTime: number;                         // used for lag compensation §12
  mode: Mode;
  charge: number;                             // 0..1, distance only §6.2
  dirInput: { x: Axis; y: Axis };             // arrow/WASD state at touch instant §5.1
  // skillSlot omitted in M2 (blocks out of scope)
}

export interface TouchResult {                // server→toucher, CH.TOUCH_RESULT
  accepted: boolean;                          // false = ball unreachable (d > 1.8) or illegal touch
  quality: number;                            // 0..1
  grade: 'PERFECT' | 'GOOD' | 'OK' | 'WHIFF'; // derived from Δt band §6.2 (HUD feedback)
  serverTime: number;
}

/* ---- ball (pure-function packet) §6.4 / §14 ---- */
export interface BallLaunch {                 // server→all, CH.BALL_LAUNCH
  origin: Vec3;
  velocity: Vec3;
  arcType: ArcType;
  quality: number;
  gravity: number;                            // units/s^2 (from constants; carried for determinism)
  serverTime: number;                         // t0 of this trajectory (authoritative clock)
  rngSeed: number;
  appliedBlocks?: BlockDef[];                 // always empty/absent in M2
  pendingBlocks?: PendingBlock[];             // always empty/absent in M2
}

/* ---- rally end ---- */
export interface DeathEvent {                 // server→all, CH.DEATH
  reason: 'ground' | 'out' | 'net' | 'touchViolation';
  landing: Vec3;
  scoringSide: Side;
  score: ScoreState;
  nextServerId: string;
  serverTime: number;
}
```

### 2.4 `types/state.ts`

```typescript
export type Side = 'A' | 'B';                 // A = z<0 half, B = z>0 half
export type MatchPhase = 'waiting' | 'serve' | 'rally' | 'deadball' | 'gameover';

export interface ScoreState { A: number; B: number; }

export interface PlayerState {                // plain mirror of schema (server owns schema class)
  id: string;
  side: Side;
  pos: import('../math/vec3').Vec3;
  stamina: number;
  lastProcessedSeq: number;
}
```

### 2.5 `quality/*` — signatures (spec §6)

```typescript
export function fDistance(d: number): number;          // d = horizontal dist §6.2; returns 0..1, -1 sentinel if d>1.8? -> use 0
export function fTiming(deltaMs: number): number;       // Δt band §6.2 → {1.0,0.8,0.5,0.2}
export function chargeDistanceMult(c: number): number;  // 1 + 0.6*c §6.2
export function computeQuality(d: number, deltaMs: number): number; // clamp01(fDistance*fTiming) §6.1
export function gradeOf(deltaMs: number): 'PERFECT'|'GOOD'|'OK'|'WHIFF'; // §6.2 bands
export const REACH_MAX = 1.8;                           // beyond → no touch
```

### 2.6 `intent/direction.ts` — §5.1 resolution

```typescript
import { Vec3 } from '../math/vec3';
import { Mode, Axis } from '../types/messages';

export interface IntentInput {
  mode: Mode;
  dirInput: { x: Axis; y: Axis };
  charge: number;
  toucherPos: Vec3;
  toucherSide: 'A' | 'B';
  // dig target resolution needs teammates; in 1v1 there is no teammate,
  // so dig defaults to "push up toward own side" (documented fallback below).
}

export interface IntentResult {
  direction: Vec3;   // unit-ish desired horizontal+vertical launch direction
  arcType: 'dig' | 'set' | 'spike';
  baseSpeed: number; // pre-charge, pre-quality speed (from constants per arc)
}

export function resolveIntent(input: IntentInput): IntentResult;
```
> **1v1 dig fallback (documented, not in §5.1 which assumes teammates):** with no
> teammate in K-state, `dig` lofts the ball upward-and-inward on the toucher's own
> half (a self-set), letting a single player chain dig→set→spike. This is the minimal
> legal behavior for a 2-player slice and is the ONLY intentional deviation from §5.1.

### 2.7 `ballistics/*` — deterministic trajectory (§4 of this plan expands)

```typescript
import { Vec3 } from '../math/vec3';
import { BallLaunch } from '../types/messages';

export function ballPosition(launch: BallLaunch, elapsedMs: number): Vec3;   // closed-form parabola
export function ballVelocity(launch: BallLaunch, elapsedMs: number): Vec3;

export interface TrajectoryEvent {
  kind: 'ground' | 'net' | 'out' | 'none';
  atMs: number;         // elapsed ms from launch.serverTime
  pos: Vec3;
}
// Deterministic scan (fixed step) both ends run identically; server uses it for authority,
// client uses it only to know when to stop rendering the arc.
export function firstEvent(launch: BallLaunch, maxMs: number): TrajectoryEvent;

export function buildBallLaunch(args: {
  origin: Vec3; direction: Vec3; baseSpeed: number;
  arcType: BallLaunch['arcType']; quality: number; charge: number;
  serverTime: number; rngSeed: number;
}): BallLaunch;
```

### 2.8 `constants.ts` (§16 — single source, imported everywhere)

```typescript
export const TICK_HZ = 30;
export const TICK_MS = 1000 / TICK_HZ;

export const MOVE_SPEED = 4.5;         // units/s (§16)
export const SPRINT_SPEED = 6.5;
export const JUMP_HEIGHT = 1.4;
export const JUMP_HANG_S = 0.7;

export const PERFECT_WINDOW_MS = 60;   // §6.2 bands
export const GOOD_WINDOW_MS = 150;
export const OK_WINDOW_MS = 300;

export const CHARGE_RATE = 0.8;        // per second
export const CHARGE_MOVE_MULT = 0.45;
export const SPIKE_BASE_SPEED = 14;    // units/s
export const BASE_SCATTER = 3.0;

export const STAMINA_MAX = 100;
export const STAMINA_DEADBALL_RECOVER = 25;

export const GRAVITY = 9.8;            // units/s^2, ball falls in -Y  (tunable, §4)
export const NET_HEIGHT = 2.43;        // §3
export const COURT_LEN = 18;           // Z span (-9..+9)
export const COURT_WIDTH = 9;          // X span (-4.5..+4.5)
export const BALL_RADIUS = 0.15;

export const RALLY_TARGET = 15;        // §9
export const WIN_BY = 2;
export const RALLY_CAP = 21;

export const REACH_MAX = 1.8;          // §6.2
export const SWEET_SPOT = 0.5;

export const RING_BUFFER_TICKS = 45;   // ~1.5s of ball history for lag comp (§3 of plan)
```

### 2.9 Server-only schema (mirrors §2.4, NOT a cross-boundary contract but listed for clarity)

`MatchState` = `{ players: MapSchema<PlayerState>, score, phase, servingId }`. The client
reads authoritative state via `CH.SNAPSHOT` messages (typed) rather than schema listeners,
so the client agent needs no schema knowledge — schema is a server-internal detail plus
Colyseus's built-in patch stream the client may ignore in M2.

---

## 3. Lag Compensation Design (§12)

**Clock sync (per client):**
1. Client sends `Ping{clientTime}` every ~1s over `CH.PING`.
2. Server replies `Pong{clientTime, serverTime}` immediately (`CH.PONG`).
3. Client computes `rtt = now - clientTime`, `oneWay = rtt/2`, and
   `offset = serverTime + oneWay - now` (server minus client clock). Keep an EMA of `offset`
   and of `rtt` (drop outliers > 2× median). `serverTimeNow() = performance-now + offset`.
4. Server keeps a symmetric `clockSync` per session so it can map an incoming
   `intent.clientTime → serverTime` via the stored offset (server-authoritative copy of the
   same EMA, seeded from the ping stream).

**Ball history ring buffer (server):**
- `ballRingBuffer` stores `{ serverTime, pos, vel }` once per 30Hz tick, capacity
  `RING_BUFFER_TICKS` (~1.5s). `query(serverTime)` linearly interpolates between the two
  bracketing ticks (clamped to buffer ends).
- Player positions are also snapshotted per tick (small history in `PlayerState` or a
  parallel buffer) so the toucher's position can be rewound too.

**Touch adjudication (`sim/lagComp.ts`):**
1. Receive `TouchIntent{playerId, clientTime, mode, charge, dirInput}`.
2. `touchServerTime = clockSync.toServerTime(session, clientTime)`, clamped to
   `[now - RING_BUFFER_TICKS*TICK_MS, now]` (reject absurd timestamps → `accepted:false`).
3. `ballPast = ballRingBuffer.query(touchServerTime)`; `playerPast = playerBuffer.query(playerId, touchServerTime)`.
4. `d = distXZ(ballPast, playerPast)` (plus a Y reach gate). If `d > REACH_MAX` →
   `TouchResult{accepted:false}`, no launch.
5. Ideal-time `t*`: scan the ball's stored/near-future trajectory for the sample where
   ball–player distance is minimized within reach; `Δt = |touchServerTime − t*|`.
6. `quality = computeQuality(d, Δt)` (§6.1). Enforce touch-count/consecutive-touch legality
   (`game/rally.ts`); illegal → `DeathEvent{reason:'touchViolation'}`.
7. Build `BallLaunch` (origin = ballPast, direction from `resolveIntent`, speed scaled by
   `quality` and `chargeDistanceMult`), broadcast `CH.BALL_LAUNCH`; send `CH.TOUCH_RESULT`
   to the toucher with grade for HUD.

**Fairness knob (§17 risk #1):** if 100ms feels unfair in WP4, widen `PERFECT_WINDOW_MS`
and/or add server "believe-the-client-within-tolerance" slack in step 5 — isolated to
constants + `lagComp.ts`, no structural change.

---

## 4. Deterministic Ballistics Design (§6.4)

**Rule:** once launched, the ball's position is a **pure function of `(BallLaunch, elapsedMs)`**,
evaluated identically on server and every client. No per-frame local physics, no drift.

**Closed-form parabola** (Y up, gravity in −Y):
```
t = elapsedMs / 1000
pos(t) = origin + velocity * t + (0, -0.5 * gravity * t², 0)
vel(t) = velocity + (0, -gravity * t, 0)
```
`gravity` is carried in the packet (from `constants.GRAVITY`) so a mid-session tuning change
can't desync clients already mid-rally. `origin`, `velocity`, `serverTime`, `rngSeed` fully
determine the arc. `arcType` only affects how `buildBallLaunch` chose the initial velocity
(dig = high/slow, set = high/hang, spike = flat/fast) — it is not re-interpreted at replay time.

**Event detection (ground / net / out-of-bounds):**
- `firstEvent(launch, maxMs)` steps elapsed in fixed increments (`EVENT_STEP_MS = 4`, i.e.
  250Hz) and reports the first crossing:
  - **ground:** `pos.y <= BALL_RADIUS` (after leaving origin) → landing point.
  - **net:** trajectory crosses plane `z = 0` while `pos.y < NET_HEIGHT` and `|pos.x| <= COURT_WIDTH/2`.
  - **out:** ground contact with `|pos.x| > COURT_WIDTH/2` or `|pos.z| > COURT_LEN/2`.
- Fixed step + shared constants ⇒ **bit-identical event time on both ends** (no float RNG in
  the scan). The **server** treats `firstEvent` as authoritative for scoring and emits
  `DeathEvent`; **clients** call the same fn only to know when to freeze the ball mesh — they
  never score locally.
- `rngSeed` reserved for future block scatter/phantom (§8) — in M2 scatter is applied at
  launch build time on the server only (deterministic result already baked into `velocity`),
  so clients need no RNG. This keeps M2 fully deterministic with an empty `appliedBlocks`.

**Determinism test (WP1):** evaluate `ballPosition(sameLaunch, t)` for a sweep of `t`, assert
identical Vec3 across two independent calls and across a JSON round-trip of the launch packet.

---

## 5. Work Packages (exactly 4, parallelizable after WP1 contracts land)

### WP1 — Scaffold + `shared` + unit tests  *(must land first; unblocks WP2/WP3)*
Tasks:
1. Root `package.json` npm workspaces (`packages/*`), `tsconfig.base.json`, `.gitignore`.
2. `packages/shared` full implementation of §2 contracts: vec3, constants, channels,
   all message/state/block types, quality fns, `resolveIntent`, ballistics (`ballPosition`,
   `ballVelocity`, `firstEvent`, `buildBallLaunch`).
3. Vitest unit tests: `quality.test.ts` (every §6.2 band boundary of f_distance/f_timing,
   composed quality, charge), `ballistics.test.ts` (determinism + ground/net event timing),
   `direction.test.ts` (§5.1 table + 1v1 dig fallback).
**Acceptance:** `npm run build` (shared) + `npm test` green; quality-fn coverage ≥ 80%;
all three test files present and passing; contracts in §2 are exported from `@spike/shared`
barrel and importable.

### WP2 — Server (Colyseus authoritative room)  *(depends on WP1 types)*
Tasks:
1. `index.ts` binds `0.0.0.0:2567`; register `MatchRoom` as `ROOM_NAME`.
2. Schema (`MatchState`/`PlayerState`), 2-seat assignment (side A/B), 30Hz
   `setSimulationInterval`.
3. Movement: consume `InputFrame`, integrate authoritatively, stamp `lastProcessedSeq`,
   broadcast `StateSnapshot` @30Hz.
4. `clockSync` (ping/pong), `ballRingBuffer`, player history buffer, `ballServer` (holds
   active launch, advances, calls `firstEvent`).
5. `lagComp.adjudicateTouch` → `BallLaunch` + `TouchResult`; `game/rally.ts` touch-count +
   serve logic; `game/scoring.ts` to 15 / win-by-2 / cap 21; emit `DeathEvent`; reset to
   serve phase; stamina +25 on deadball.
**Acceptance:** server boots on `0.0.0.0:2567`; a raw `colyseus.js` script joins, sends a
`TouchIntent`, and receives a well-formed `BallLaunch` + `TouchResult`; a scripted ground
`DeathEvent` increments the correct side and a game ends at 15 (win-by-2). No client rendering
needed to pass.

### WP3 — Client (Vite + Three.js)  *(depends on WP1 types; mock server via contracts)*
Tasks:
1. Vite scaffold: `vite.config.ts` `host:'0.0.0.0'`, port 5173, strictPort; `index.html`.
2. `config.ts` derives ws URL from `location.hostname` (`ws://${hostname}:2567`) — never
   hardcode localhost. `net/connection.ts` joins `ROOM_NAME`; `net/clockSync.ts` ping/pong.
3. Scene: `renderer` (45° follow cam, 60fps rAF), `court` (18×9 + net plane + lines), `ball`,
   `player` capsules.
4. Input: WASD/arrows + space + J/K/L, dirInput sampling, charge timer.
5. `localPlayer` prediction + reconciliation against `StateSnapshot.lastProcessedSeq`;
   `remotePlayer` interpolation with render delay.
6. `ball` replays `BallLaunch` via `ballPosition(serverTimeNow())`, freezes on `firstEvent`.
7. `hud`: score, PERFECT/GOOD/OK popups from `TouchResult`, stamina bar from snapshot.
**Acceptance:** `npm run dev` serves on `0.0.0.0:5173`; against a running WP2 server the local
capsule moves with prediction (no rubber-banding on clean LAN), the ball flies from launch
packets, HUD shows score + grade + stamina. Against a stubbed server emitting canned
`BallLaunch`/`Snapshot`, rendering works without the real server (parallel-dev proof).

### WP4 — Integration + LAN smoke test  *(depends on WP2 + WP3)*
Tasks:
1. Wire real client ↔ real server; resolve any contract mismatches (should be none if §2 held).
2. Two-machine LAN test on the Windows host: host runs server + Vite; friend opens
   `http://<host-LAN-IP>:5173`. Verify join into same room, opposite sides, a full rally to a
   point, and a game to 15.
3. Add `netsh` firewall rules for 2567 + 5173; document LAN setup (§7).
4. Introduce artificial 50–100ms latency (e.g. clumsy/`clumsy` on Windows or a throttle) and
   sanity-check PERFECT fairness (§17 risk #1); record any window-widening needed.
**Acceptance:** two separate machines on the LAN complete a full 1v1 game to 15; ball is
visually consistent on both screens (pure-function determinism holds); PERFECT/GOOD/OK grades
appear; under ~100ms induced latency the toucher still gets plausible grades. Documented
firewall + run steps reproduce the session from cold.

---

## 6. Dev / Run Commands (npm scripts)

**Root `package.json`:**
```json
{
  "private": true,
  "workspaces": ["packages/shared", "packages/server", "packages/client"],
  "scripts": {
    "build:shared": "npm run build -w @spike/shared",
    "test": "npm test -w @spike/shared",
    "dev:server": "npm run dev -w @spike/server",
    "dev:client": "npm run dev -w @spike/client",
    "dev": "npm run build:shared && concurrently -k \"npm:dev:server\" \"npm:dev:client\""
  }
}
```
- `packages/shared`: `"build": "tsc -p tsconfig.json"`, `"test": "vitest run --coverage"`.
- `packages/server`: `"dev": "tsx watch src/index.ts"` (dep: `tsx`).
- `packages/client`: `"dev": "vite --host 0.0.0.0 --port 5173"`, `"build": "vite build"`.

First-time: `npm install` at root (workspaces hoist), then `npm run build:shared`, then `npm run dev`.

---

## 7. LAN Setup (Windows 11 host)

1. **Find the host LAN IP:** `ipconfig` → IPv4 of the active adapter (e.g. `192.168.1.42`).
2. **Open the firewall** (elevated PowerShell, one-time):
   ```
   netsh advfirewall firewall add rule name="SpikeLab Vite 5173"  dir=in action=allow protocol=TCP localport=5173
   netsh advfirewall firewall add rule name="SpikeLab Colyseus 2567" dir=in action=allow protocol=TCP localport=2567
   ```
   Remove later with `netsh advfirewall firewall delete rule name="SpikeLab Vite 5173"` (and the 2567 rule).
3. **Start both processes on the host:** `npm run dev` (binds server `0.0.0.0:2567`, Vite `0.0.0.0:5173`).
4. **Friend joins:** open `http://<host-LAN-IP>:5173` in a browser on the same LAN. The client
   derives `ws://<host-LAN-IP>:2567` automatically from `location.hostname` — nothing hardcoded.
5. **Verify:** both browsers show 2 capsules on opposite sides; play a rally.

Troubleshooting: if the friend can load the page but the ball never launches, it's the 2567
rule (WebSocket) — confirm the Colyseus rule and that AV/third-party firewall isn't overriding
Windows Defender.
