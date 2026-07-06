import * as THREE from 'three';
import type { TouchMode } from '@spike/shared';
import {
  ACTION_SWINGS,
  CHARGE_POSES,
  type ChargePose,
  DOMINANT_ARM,
  JUMP_ARM_RAISE_RAD,
  MODE_IDLE_LEAN_RAD,
  POSE_SLERP_RATE,
  SERVE_HOLD_DOMINANT,
  SERVE_HOLD_OFF,
  SPIKE_TOUCH_BALANCE,
  SWING_AMP_RAD,
  SWING_FREQ,
  SWING_IDLE_FACTOR,
  type ArmEuler,
} from './characterConstants';

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Smoothstep so the release swing eases in/out rather than moving linearly.
function smoothstep(t: number): number {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}

// §3 — the procedural, boneless arm pose machine. Every frame it picks ONE
// base pose per priority (dive > touch > serveHold > charging > idle/move),
// optionally overlays the jump raise, and slerps each shoulder pivot's
// quaternion toward that target (~POSE_SLERP_RATE/s) so transitions are smooth.
// Drives LOCAL and REMOTE identically — the caller just feeds a PoseInput.
export type PoseKind = 'idle' | 'charging' | 'touch' | 'dive' | 'serveHold';

export interface PoseInput {
  readonly kind: PoseKind;
  readonly mode: TouchMode;
  readonly speed01: number; // 0..1 horizontal speed factor (walk-swing scale)
  readonly airborne: boolean; // jump overlay
  readonly clockS: number; // seconds — walk-swing sine phase
  // M2.7 §6 — 0→1 progress through the RELEASE action window (touch kind). 0 at
  // the instant of release, 1 at TOUCH_POSE_MS. Drives the swing arc.
  readonly touchProgress01: number;
  // Unit direction in CHARACTER-LOCAL space to reach along (touch/dive). The
  // caller resolves world aim (ball position, dive heading) into local space.
  readonly localAim: THREE.Vector3 | null;
}

// At rest each arm points straight down from its shoulder pivot.
const REST_DIR = new THREE.Vector3(0, -1, 0);

interface ArmTargets {
  readonly left: THREE.Quaternion;
  readonly right: THREE.Quaternion;
}

// Mode-specific idle lean so a remote whose charge we can't see still telegraphs
// its mode a little through resting posture (integration nicety §5).
const MODE_LEAN: Record<TouchMode, number> = {
  dig: MODE_IDLE_LEAN_RAD, // hands drift forward-down
  set: -MODE_IDLE_LEAN_RAD, // hands drift up
  spike: MODE_IDLE_LEAN_RAD * 0.5,
};

export class ArmPoseMachine {
  private readonly curLeft = new THREE.Quaternion();
  private readonly curRight = new THREE.Quaternion();
  private readonly scratchEuler = new THREE.Euler(0, 0, 0, 'XYZ');
  private readonly tmpQuat = new THREE.Quaternion();

  // chargePoses defaults to the shared third-person CHARGE_POSES; the FPV
  // viewmodel passes FPV-tuned poses so the ready hands stay framed (§3/§6).
  constructor(
    private readonly leftPivot: THREE.Object3D,
    private readonly rightPivot: THREE.Object3D,
    private readonly chargePoses: Record<TouchMode, ChargePose> = CHARGE_POSES,
  ) {
    this.curLeft.copy(leftPivot.quaternion);
    this.curRight.copy(rightPivot.quaternion);
  }

  update(input: PoseInput, dtMs: number): void {
    const targets = this.computeTargets(input);
    const alpha = Math.min(1, (POSE_SLERP_RATE * dtMs) / 1000);
    this.curLeft.slerp(targets.left, alpha);
    this.curRight.slerp(targets.right, alpha);
    this.leftPivot.quaternion.copy(this.curLeft);
    this.rightPivot.quaternion.copy(this.curRight);
  }

  private computeTargets(input: PoseInput): ArmTargets {
    switch (input.kind) {
      case 'dive':
        return this.aimBoth(input.localAim);
      case 'touch':
        return this.touchTargets(input);
      case 'serveHold':
        return this.dominantOff(SERVE_HOLD_DOMINANT, SERVE_HOLD_OFF);
      case 'charging':
        return this.overlayJump(this.chargingTargets(input.mode), input.airborne);
      case 'idle':
      default:
        return this.overlayJump(this.idleTargets(input), input.airborne);
    }
  }

  // ---- individual pose builders ------------------------------------------

  private idleTargets(input: PoseInput): ArmTargets {
    const scale = Math.max(SWING_IDLE_FACTOR, input.speed01);
    const swing = Math.sin(input.clockS * SWING_FREQ) * SWING_AMP_RAD * scale;
    const lean = MODE_LEAN[input.mode];
    // Antiphase: left and right swing in opposition (a natural walk).
    return {
      left: this.quatFromEuler({ x: swing + lean, y: 0, z: 0 }),
      right: this.quatFromEuler({ x: -swing + lean, y: 0, z: 0 }),
    };
  }

  private chargingTargets(mode: TouchMode): ArmTargets {
    const pose = this.chargePoses[mode];
    return {
      left: this.quatFromEuler(pose.left),
      right: this.quatFromEuler(pose.right),
    };
  }

  // M2.7 §6 — the RELEASE action: a swing THROUGH the ball. Base is the
  // aim-toward-ball quaternion; a progress-driven pitch delta (ACTION_SWINGS)
  // is premultiplied in the shoulder-pivot frame so the arm sweeps low→up (dig),
  // up-and-out (set) or over-the-top (spike dominant) across the window.
  private touchTargets(input: PoseInput): ArmTargets {
    const aim = this.aimQuat(input.localAim).clone();
    const swing = ACTION_SWINGS[input.mode];
    const pitch = swing.startPitch + (swing.endPitch - swing.startPitch) * smoothstep(input.touchProgress01);
    const action = this.scratchQuatX(pitch).multiply(aim);
    if (input.mode === 'spike') {
      // Dominant arm whips along the swing; off arm balances forward.
      const balance = this.quatFromEuler(SPIKE_TOUCH_BALANCE);
      return DOMINANT_ARM === 'right'
        ? { left: balance, right: action.clone() }
        : { left: action.clone(), right: balance };
    }
    // dig scoop / set push — both arms swing along the aim.
    return { left: action.clone(), right: action.clone() };
  }

  // ---- helpers ------------------------------------------------------------

  private aimBoth(localAim: THREE.Vector3 | null): ArmTargets {
    const q = this.aimQuat(localAim);
    return { left: q.clone(), right: q.clone() };
  }

  private aimQuat(localAim: THREE.Vector3 | null): THREE.Quaternion {
    if (!localAim || localAim.lengthSq() < 1e-6) return this.tmpQuat.identity();
    return this.tmpQuat.setFromUnitVectors(REST_DIR, localAim.clone().normalize());
  }

  private dominantOff(dominant: ArmEuler, off: ArmEuler): ArmTargets {
    const dq = this.quatFromEuler(dominant);
    const oq = this.quatFromEuler(off);
    return DOMINANT_ARM === 'right' ? { left: oq, right: dq } : { left: dq, right: oq };
  }

  // Jump overlay (§3): raise both arms an extra ~25° forward/up. NEGATIVE pitch
  // = forward, so subtract the raise from each arm's current X target.
  private overlayJump(base: ArmTargets, airborne: boolean): ArmTargets {
    if (!airborne) return base;
    const raise = this.scratchQuatX(-JUMP_ARM_RAISE_RAD);
    return {
      left: raise.clone().multiply(base.left),
      right: raise.clone().multiply(base.right),
    };
  }

  private quatFromEuler(e: ArmEuler): THREE.Quaternion {
    this.scratchEuler.set(e.x, e.y, e.z, 'XYZ');
    return new THREE.Quaternion().setFromEuler(this.scratchEuler);
  }

  private scratchQuatX(rad: number): THREE.Quaternion {
    this.scratchEuler.set(rad, 0, 0, 'XYZ');
    return new THREE.Quaternion().setFromEuler(this.scratchEuler);
  }
}
