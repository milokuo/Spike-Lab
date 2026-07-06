// Numeric jitter reproduction + regression harness (SPIKE LAB M2.5).
//
// Boots the REAL MatchRoom server in-process, connects a REAL colyseus.js
// client, drives it with constant directional input at the client's actual
// 30Hz send cadence, and simultaneously runs the REAL LocalPlayer prediction
// loop in the exact per-frame order main.ts/gameSession use:
//   tickJump -> pumpInput(sample->applyInput(predict)->sendInput) ->
//   decayError -> read .position
// Snapshots arrive over the wire and drive LocalPlayer.reconcile (delayed by
// half the simulated RTT). The rendered .position series is sampled at 60fps
// during steady movement and analysed for frame-to-frame backtracking and
// perpendicular oscillation.
//
// Run: `npx tsx test/jitter.ts` (from packages/server). Optional env:
//   JITTER_ASSERT=1  -> exit non-zero if smoothness thresholds are violated.
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client, type Room } from 'colyseus.js';
import {
  CH,
  ROOM_NAME,
  MOVE_SPEED,
  viewToWorld,
  type Axis,
  type InputFrame,
  type PlayerSnapshot,
  type Side,
  type StateSnapshot,
} from '@spike/shared';
import { MatchRoom } from '../src/rooms/MatchRoom';
import { LocalPlayer } from '../../client/src/player/localPlayer';
import type { InputSample } from '../../client/src/input/keyboard';
import { INPUT_SEND_INTERVAL_MS } from '../../client/src/config';

const PORT = 2599;
const FRAME_MS = 1000 / 60; // 60fps render loop
const WARMUP_MS = 1000; // idle: let clock/reconcile settle at spawn
const MEASURE_MS = 1200; // steady constant movement window
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Sample {
  t: number;
  x: number;
  z: number;
}

// One measurement run at a given simulated round-trip latency (ms).
async function run(latencyMs: number): Promise<Sample[]> {
  const half = latencyMs / 2;

  // ---- real server, in-process -------------------------------------------
  const server = new Server({ transport: new WebSocketTransport() });
  server.define(ROOM_NAME, MatchRoom);
  await server.listen(PORT, '127.0.0.1');

  const client = new Client(`ws://127.0.0.1:${PORT}`);
  const room: Room = await client.joinOrCreate(ROOM_NAME);

  let local: LocalPlayer | undefined;
  let side: Side = 'A';
  let ownId = room.sessionId;

  const ownOf = (snap: StateSnapshot): PlayerSnapshot | undefined =>
    snap.players.find((p) => p.id === ownId);

  // Inbound snapshots reconcile after half the RTT (server->client leg).
  room.onMessage(CH.SNAPSHOT, (snap: StateSnapshot) => {
    setTimeout(() => {
      const own = ownOf(snap);
      if (!own) return;
      if (!local) {
        side = own.side;
        local = new LocalPlayer(own.pos, own.side);
      } else {
        local.reconcile(own);
      }
    }, half);
  });

  // Wait for the first snapshot -> LocalPlayer constructed.
  const t0 = Date.now();
  while (!local && Date.now() - t0 < 4000) await delay(10);
  if (!local) throw new Error('no snapshot / LocalPlayer never constructed');

  // ---- the real per-frame client loop ------------------------------------
  // Fixed-cadence 60fps simulation: dt fed to the prediction loop is a constant
  // 1/60s (a real render loop's target), while wall-clock setTimeout pacing lets
  // the server's real 30Hz snapshots + latency timers flow in at the right rate.
  // (Windows setTimeout granularity is too coarse to trust measured dt for a
  // clean per-frame signal, so we drive dt from a virtual clock.)
  const samples: Sample[] = [];
  let accumulatorMs = 0;
  let virtualElapsed = 0;

  const sendInput = (frame: InputFrame): void => {
    setTimeout(() => {
      try {
        room.send(CH.INPUT, frame);
      } catch {
        /* room closing */
      }
    }, half);
  };

  return await new Promise<Sample[]>((resolve) => {
    const tick = (): void => {
      const frameStart = performance.now();
      const dtMs = FRAME_MS;
      virtualElapsed += dtMs;
      const elapsed = virtualElapsed;

      // Constant input: idle during warmup, then steady backpedal (move.y=-1),
      // which has ~9.5u of court room on either side so no clamp contaminates
      // the window. jumpHeld/touchMode held constant.
      const moving = elapsed >= WARMUP_MS;
      const sample: InputSample = {
        move: { x: 0 as Axis, y: (moving ? -1 : 0) as Axis },
        jumpHeld: false,
        touchMode: 'dig',
      };

      // 1) vertical (no-op here) — mirrors main.ts order exactly.
      local!.tickJump(dtMs, false);

      // 2) pumpInput — accumulate real dt, emit at the 30Hz send cadence.
      accumulatorMs += dtMs;
      while (accumulatorMs >= INPUT_SEND_INTERVAL_MS) {
        accumulatorMs -= INPUT_SEND_INTERVAL_MS;
        const frame = local!.applyInput(sample, INPUT_SEND_INTERVAL_MS, null);
        sendInput(frame);
      }

      // 3) updateVisuals — decay smoothing offset, THEN read the render pos.
      local!.decayError(dtMs);
      const pos = local!.position;
      if (moving && elapsed <= WARMUP_MS + MEASURE_MS) {
        samples.push({ t: elapsed, x: pos.x, z: pos.z });
      }

      if (elapsed >= WARMUP_MS + MEASURE_MS) {
        room.leave();
        server.gracefullyShutdown(false).finally(() => resolve(samples));
        return;
      }
      setTimeout(tick, Math.max(0, FRAME_MS - (performance.now() - frameStart)));
    };
    tick();
  }).then((s) => {
    void side;
    void ownId;
    return s;
  });
}

// ---- jitter analysis ------------------------------------------------------
interface Metrics {
  frames: number;
  durationS: number;
  fwdMeanCm: number;
  fwdMinCm: number;
  fwdMaxCm: number;
  backtrackFrames: number;
  maxBacktrackCm: number;
  stutterZeroFrames: number; // frames with < 25% of expected fwd progress
  fwdReversalHz: number; // sign-change freq of (fwd-mean) => stutter frequency
  perpMaxCm: number; // max lateral deviation from the straight track
  perpOscHz: number; // perpendicular direction-reversal frequency
}

function analyse(samples: Sample[], side: Side): Metrics {
  // World-space unit move dir for move.y=-1 (backpedal), per side.
  const mdRaw = viewToWorld({ x: 0, y: -1 }, side);
  const mLen = Math.hypot(mdRaw.x, mdRaw.z) || 1;
  const md = { x: mdRaw.x / mLen, z: mdRaw.z / mLen };
  const pd = { x: md.z, z: -md.x }; // perpendicular unit

  const x0 = samples[0].x;
  const z0 = samples[0].z;
  const durationS = (samples[samples.length - 1].t - samples[0].t) / 1000;
  const expectedFwdPerFrameCm = (MOVE_SPEED * (durationS / (samples.length - 1))) * 100;

  const fwdDeltas: number[] = [];
  const perpVals: number[] = [];
  let backtrackFrames = 0;
  let maxBacktrackCm = 0;
  let stutterZeroFrames = 0;
  let perpMaxCm = 0;

  for (let i = 1; i < samples.length; i++) {
    const dx = samples[i].x - samples[i - 1].x;
    const dz = samples[i].z - samples[i - 1].z;
    const fwdCm = (dx * md.x + dz * md.z) * 100;
    fwdDeltas.push(fwdCm);
    if (fwdCm < 0) {
      backtrackFrames++;
      maxBacktrackCm = Math.max(maxBacktrackCm, -fwdCm);
    }
    if (fwdCm < 0.25 * expectedFwdPerFrameCm) stutterZeroFrames++;

    // lateral deviation from the ideal straight track through the start point.
    const px = samples[i].x - x0;
    const pz = samples[i].z - z0;
    const perpCm = (px * pd.x + pz * pd.z) * 100;
    perpVals.push(perpCm);
    perpMaxCm = Math.max(perpMaxCm, Math.abs(perpCm));
  }

  const fwdMean = fwdDeltas.reduce((a, b) => a + b, 0) / fwdDeltas.length;
  const fwdMin = Math.min(...fwdDeltas);
  const fwdMax = Math.max(...fwdDeltas);

  // reversal frequency of (fwd - mean): a clean stair-step alternates sign
  // every frame (~30Hz at 60fps). Smooth motion barely crosses.
  const fwdReversalHz = signChangeHz(fwdDeltas.map((v) => v - fwdMean), durationS);
  // perpendicular reversal frequency: derivative sign changes of the lateral
  // track (oscillation vs monotonic drift).
  const perpDeltas: number[] = [];
  for (let i = 1; i < perpVals.length; i++) perpDeltas.push(perpVals[i] - perpVals[i - 1]);
  const perpOscHz = signChangeHz(perpDeltas, durationS);

  return {
    frames: samples.length,
    durationS,
    fwdMeanCm: fwdMean,
    fwdMinCm: fwdMin,
    fwdMaxCm: fwdMax,
    backtrackFrames,
    maxBacktrackCm,
    stutterZeroFrames,
    fwdReversalHz,
    perpMaxCm,
    perpOscHz,
  };
}

function signChangeHz(series: number[], durationS: number): number {
  let changes = 0;
  let prevSign = 0;
  for (const v of series) {
    const s = Math.sign(v);
    if (s !== 0 && prevSign !== 0 && s !== prevSign) changes++;
    if (s !== 0) prevSign = s;
  }
  // each full oscillation = 2 sign changes.
  return durationS > 0 ? changes / 2 / durationS : 0;
}

function report(label: string, m: Metrics): void {
  console.log(`\n[${label}]  ${m.frames} frames / ${m.durationS.toFixed(2)}s`);
  console.log(
    `  fwd/frame  mean=${m.fwdMeanCm.toFixed(2)}cm  min=${m.fwdMinCm.toFixed(2)}cm  max=${m.fwdMaxCm.toFixed(2)}cm`,
  );
  console.log(
    `  backtrack  frames=${m.backtrackFrames}  maxDepth=${m.maxBacktrackCm.toFixed(3)}cm`,
  );
  console.log(
    `  stutter    near-zero frames=${m.stutterZeroFrames}/${m.frames}  fwd-reversal=${m.fwdReversalHz.toFixed(1)}Hz`,
  );
  console.log(
    `  perp       maxDeviation=${m.perpMaxCm.toFixed(3)}cm  osc=${m.perpOscHz.toFixed(1)}Hz`,
  );
}

async function main(): Promise<void> {
  const assertMode = process.env.JITTER_ASSERT === '1';
  const side: Side = 'A'; // first joiner is auto-seated A (balancedSide 0,0)
  const results: { label: string; m: Metrics }[] = [];

  for (const lat of [0, 100]) {
    const samples = await run(lat);
    const m = analyse(samples, side);
    const label = `${lat}ms RTT`;
    report(label, m);
    results.push({ label, m });
    await delay(200);
  }

  if (assertMode) {
    let failures = 0;
    for (const { label, m } of results) {
      // Smoothness contract (steady move): no meaningful backtracking and no
      // perpendicular oscillation, at 0 and 100ms RTT.
      if (m.maxBacktrackCm > 0.5) {
        console.error(`  FAIL [${label}] backtrack ${m.maxBacktrackCm.toFixed(3)}cm > 0.5cm`);
        failures++;
      }
      if (m.perpMaxCm > 0.5) {
        console.error(`  FAIL [${label}] perp deviation ${m.perpMaxCm.toFixed(3)}cm > 0.5cm`);
        failures++;
      }
      // Stutter: at least half the frames must show real forward progress
      // (a 30Hz stair-step leaves ~half the frames frozen).
      if (m.stutterZeroFrames > m.frames * 0.5) {
        console.error(
          `  FAIL [${label}] ${m.stutterZeroFrames}/${m.frames} near-zero (stair-step stutter)`,
        );
        failures++;
      }
    }
    if (failures === 0) console.log('\n  PASS  steady-move smoothness (0ms & 100ms RTT)');
    else {
      console.error(`\n  ${failures} smoothness assertion(s) failed`);
      process.exit(1);
    }
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('[jitter] fatal', err);
  process.exit(1);
});
