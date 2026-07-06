import {
  DIVE_LOCK_S,
  JUMP_STAMINA_BASE,
  MOVE_SPEED,
  STAMINA_MAX,
  isLanded,
  moveToWorld,
  startJump,
  stepJump,
  type InputFrame,
  type JumpState,
  type PlayerSnapshot,
  type Side,
  type Vec3,
} from '@spike/shared';
import type { InputSample } from '../input/keyboard';
import {
  INPUT_SEND_INTERVAL_MS,
  JUMP_GROUND_EPSILON,
  JUMP_PREDICTION_GRACE_MS,
  RECONCILE_ERROR_DECAY_RATE,
  RECONCILE_SNAP_THRESHOLD,
} from '../config';

// Below this the residual visual offset is imperceptible — zero it so the mesh
// settles exactly on the predicted position (no endless sub-pixel drift).
const ERROR_OFFSET_EPSILON = 1e-4;

const GROUNDED_STATE: JumpState = { y: 0, vy: 0, airborneS: 0 };

// Own player: predicts horizontal movement + vertical jump arc, buffering
// inputs for reconciliation against the authoritative StateSnapshot (plan §5,
// M2.1 §c / M2.2 §1.4). Jump uses the SAME shared kinematics fns as the server
// (kinematics/jump.ts: startJump/stepJump/isLanded) so both trajectories agree
// bit-for-bit given identical inputs — no client-only integrator, no rubber-band.
export class LocalPlayer {
  // Pure predicted horizontal position — advanced ONLY by integrateHorizontal.
  // reconcile never teleports this; it re-derives it from server pos + replay.
  private groundPos: { x: number; z: number };
  // Visual smoothing: (rendered - predicted) offset that decays to zero. Keeps
  // the mesh continuous across a reconcile snap instead of shaking to the new
  // authoritative base each snapshot. Added onto groundPos by `position`.
  private errorOffset = { x: 0, z: 0 };
  // Between-tick motion lead (M2.5 stair-step fix). groundPos only advances at
  // the 30Hz input-send cadence, but `position` is read every 60fps render
  // frame — so without this the mesh freezes between sends and jumps a whole
  // step at 30Hz (a measured ~15cm/30Hz stair-step, invisible in world space
  // but a glaring shudder against the smoothly-lerped follow camera). We store
  // the world-space velocity of the last applied input and how long ago it was
  // applied; `position` leads groundPos by velocity×elapsed (capped at one send
  // step) so the mesh glides smoothly at 60fps. This is a purely VISUAL lead —
  // exactly like errorOffset it is NOT part of groundPos, so reconcile's replay
  // math is untouched and the lead cancels across a reconcile (added identically
  // before and after), never re-injecting error. Mirrors tickJump's per-frame
  // vertical integration for the horizontal axis.
  private moveVelWorld = { x: 0, z: 0 };
  private stepElapsedMs = 0;
  private lastStepDtMs = INPUT_SEND_INTERVAL_MS;
  private jump: JumpState = GROUNDED_STATE;
  private airborne = false;
  // §1 — while set (> now), a grounded snapshot is server-lag, not a landing:
  // don't let reconcile clobber a just-started local jump back to the ground.
  private jumpPredictedUntilMs = 0;
  private diveLockUntilMs = 0; // §3.2 — freeze WASD application during a dive
  private pendingInputs: InputFrame[] = [];
  private nextSeq = 0;
  // Last stamina reported by the server (kept fresh via reconcile's snapshot).
  // Defaults to full so the very first Space press — before any snapshot has
  // arrived — isn't spuriously blocked.
  private lastStamina = STAMINA_MAX;

  constructor(
    startPos: Vec3,
    private readonly side: Side,
  ) {
    this.groundPos = { x: startPos.x, z: startPos.z };
    if (startPos.y > JUMP_GROUND_EPSILON) {
      this.jump = { y: startPos.y, vy: 0, airborneS: 0 };
      this.airborne = true;
    }
  }

  // Sole render source: predicted horizontal + between-tick motion lead +
  // smoothing offset + jump arc. The lead is capped at one send step so a
  // stalled input stream can never run the mesh away from authority.
  get position(): Vec3 {
    const leadS = Math.min(this.stepElapsedMs, this.lastStepDtMs) / 1000;
    return {
      x: this.groundPos.x + this.errorOffset.x + this.moveVelWorld.x * leadS,
      y: this.jump.y,
      z: this.groundPos.z + this.errorOffset.z + this.moveVelWorld.z * leadS,
    };
  }

  // Called once per render frame (real dt), BEFORE reading `position`. Advances
  // the between-tick motion lead (so the mesh glides at 60fps rather than
  // stair-stepping at the 30Hz send cadence) and exponentially decays the visual
  // reconcile offset toward zero so the mesh converges on the authoritative
  // prediction without a teleport. Both are per-frame VISUAL smoothing, decoupled
  // from the 30Hz input-send / snapshot cadences.
  decayError(dtMs: number): void {
    this.stepElapsedMs += dtMs;
    const k = Math.exp((-RECONCILE_ERROR_DECAY_RATE * dtMs) / 1000);
    const x = this.errorOffset.x * k;
    const z = this.errorOffset.z * k;
    this.errorOffset =
      Math.abs(x) < ERROR_OFFSET_EPSILON && Math.abs(z) < ERROR_OFFSET_EPSILON
        ? { x: 0, z: 0 }
        : { x, z };
  }

  // Space keydown → start the jump immediately (§1.4), zero added latency.
  // Grounded gate, plus a client-side mirror of the server's stamina gate
  // (JUMP_STAMINA_BASE, MatchRoom.ts): predicting a jump the server is certain
  // to reject on insufficient stamina produces a rise-then-snap-down glitch for
  // the full JUMP_PREDICTION_GRACE_MS window. Skipping the prediction here is
  // just an optimistic client-side mirror — the server remains authoritative
  // (stamina can still drop between our last snapshot and its next tick), and
  // reconcile still snaps us down in that edge case.
  startJumpPrediction(): void {
    if (this.airborne) return;
    if (this.lastStamina < JUMP_STAMINA_BASE) return;
    this.jump = startJump();
    this.airborne = true;
    // §1 — protect this prediction from being reset by snapshots that predate
    // the server processing the jump (see reconcile).
    this.jumpPredictedUntilMs = performance.now() + JUMP_PREDICTION_GRACE_MS;
  }

  // Advances the vertical arc every render frame (60fps), decoupled from the
  // 30Hz input-send cadence, so the parabola reads smoothly. `held` is this
  // frame's Space state, feeding stepJump's hold-to-boost window (§1.1).
  tickJump(dtMs: number, held: boolean): void {
    if (!this.airborne) return;
    const next = stepJump(this.jump, dtMs / 1000, held);
    if (isLanded(next)) {
      this.jump = GROUNDED_STATE;
      this.airborne = false;
      this.jumpPredictedUntilMs = 0;
    } else {
      this.jump = next;
    }
  }

  // Called by GameSession when a dive TouchResult arrives (§3.2): the server
  // locks movement for DIVE_LOCK_S, so we stop applying local WASD to avoid
  // fighting the authoritative lunge (reconcile still snaps us to server pos).
  beginDiveLock(): void {
    this.diveLockUntilMs = performance.now() + DIVE_LOCK_S * 1000;
  }

  // Builds an InputFrame from this frame's input sample, applies horizontal
  // prediction locally, and buffers it for later reconciliation. jumpHeld and
  // touchMode are streamed every frame (§1.4/§2.2). Returns the frame to send.
  applyInput(input: InputSample, dtMs: number, yaw: number | null): InputFrame {
    const diveLocked = performance.now() < this.diveLockUntilMs;
    const move = diveLocked ? { x: 0 as const, y: 0 as const } : input.move;
    const frame: InputFrame = {
      seq: this.nextSeq++,
      clientTime: performance.now(),
      move,
      jumpHeld: input.jumpHeld,
      touchMode: input.touchMode,
      isCharging: input.isCharging, // M2.8 §1 — streamed every frame; server writes authoritative state
      dtMs,
      // §5.2 — null in third person (mirrored-per-side path), heading in FPV.
      yaw,
    };
    this.pendingInputs.push(frame);
    this.integrateHorizontal(frame);
    // Arm the between-tick lead from THIS live step: its world velocity is what
    // the next step will also integrate, so leading by it keeps the mesh exactly
    // continuous when that step lands. Only the live applyInput path touches this
    // — reconcile's replay calls integrateHorizontal directly and must NOT reset
    // the lead phase (that would shudder at the snapshot cadence).
    this.moveVelWorld = this.worldVelocity(frame);
    this.lastStepDtMs = frame.dtMs;
    this.stepElapsedMs = 0;
    return frame;
  }

  // World-space velocity (units/s) of a frame's normalized 8-direction intent.
  // Same per-side/per-view transform the server uses (§5.2 moveToWorld): yaw
  // === null keeps the M2.1 mirrored-per-side path byte-for-byte; a finite yaw
  // switches to FPV heading-relative movement. Prediction + authority agree
  // axis-for-axis because both derive movement from this one shared fn.
  private worldVelocity(frame: InputFrame): { x: number; z: number } {
    const dirLen = Math.hypot(frame.move.x, frame.move.y);
    if (dirLen === 0) return { x: 0, z: 0 };
    const norm = 1 / dirLen;
    const world = moveToWorld(frame.move, this.side, frame.yaw);
    return { x: world.x * norm * MOVE_SPEED, z: world.z * norm * MOVE_SPEED };
  }

  private integrateHorizontal(frame: InputFrame): void {
    const dt = frame.dtMs / 1000;
    const vel = this.worldVelocity(frame);
    this.groundPos = {
      x: this.groundPos.x + vel.x * dt,
      z: this.groundPos.z + vel.z * dt,
    };
  }

  // Reconciliation: re-derive the authoritative horizontal position (server pos
  // + replayed unacked inputs, M2.1) but DON'T teleport the mesh onto it — that
  // 30Hz yank is the jitter. Snapshot the currently-rendered position first,
  // rebuild the predicted base, then store the difference as a visual offset
  // that decayError() smooths away. A large difference is a real server
  // teleport (dive lunge / serve reposition), so snap instead of smoothing.
  //
  // Vertical jump state is NOT snapped every snapshot — that would fight the
  // smooth 60fps arc integrated with the identical shared fn, so small transient
  // mid-air disagreement is expected and self-corrects. We only hard-sync
  // vertical on a confirmed landing (snapshot pos.y ~= 0), unambiguous & drift-free.
  reconcile(snapshot: PlayerSnapshot): void {
    this.lastStamina = snapshot.stamina;
    // Rendered horizontal position before we rebuild the predicted base.
    const renderedX = this.groundPos.x + this.errorOffset.x;
    const renderedZ = this.groundPos.z + this.errorOffset.z;
    if (snapshot.pos.y > JUMP_GROUND_EPSILON) {
      // Server confirms we're airborne — the predicted jump is validated, so
      // stop treating grounded snapshots as server-lag from here on.
      this.jumpPredictedUntilMs = 0;
    } else if (performance.now() >= this.jumpPredictedUntilMs) {
      // Genuinely grounded: either we've landed, or the grace window elapsed
      // without the server ever jumping (e.g. it rejected the jump). Hard-sync
      // down — unambiguous, prevents drift.
      this.jump = GROUNDED_STATE;
      this.airborne = false;
    }
    // else: a jump was just predicted locally and this snapshot predates the
    // server processing it (still shows y ≈ 0). Keep the prediction so the
    // capsule visibly rises instead of being clobbered to the ground (§1).

    // Rebuild the predicted base from authority: server pos + unacked replay.
    this.groundPos = { x: snapshot.pos.x, z: snapshot.pos.z };
    this.pendingInputs = this.pendingInputs.filter((input) => input.seq > snapshot.lastProcessedSeq);
    for (const input of this.pendingInputs) this.integrateHorizontal(input);

    // Keep the mesh where it was rendering, then let decayError() slide it onto
    // the new base — unless the correction is teleport-scale, in which case snap.
    const offX = renderedX - this.groundPos.x;
    const offZ = renderedZ - this.groundPos.z;
    if (Math.hypot(offX, offZ) > RECONCILE_SNAP_THRESHOLD) {
      // Teleport-scale correction (dive lunge / serve reposition): snap the mesh
      // exactly onto authority — zero both the smoothing offset AND the motion
      // lead so the reposition reads crisp (no residual glide off the snap point).
      this.errorOffset = { x: 0, z: 0 };
      this.moveVelWorld = { x: 0, z: 0 };
      this.stepElapsedMs = 0;
    } else {
      // Per-snapshot drift: keep the mesh where it rendered and let decayError()
      // slide it onto the new base. The motion lead is deliberately untouched —
      // it is a visual term outside groundPos that cancels across this rebuild
      // (renderedX excludes it), so continuity holds without re-injecting error.
      this.errorOffset = { x: offX, z: offZ };
    }
  }
}
