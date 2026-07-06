import * as THREE from 'three';
import { type TouchMode, type Vec3 } from '@spike/shared';
import {
  ARM_COLOR,
  ARM_LENGTH,
  ARM_RADIUS,
  CAPSULE_CYLINDER_HEIGHT,
  CAPSULE_RADIUS,
  DAZED_FACE_MS,
  DIVE_BODY_TILT_RAD,
  FACING_LERP_RATE,
  HAPPY_FACE_MS,
  HEAD_CENTER_Y,
  HEAD_COLOR,
  HEAD_RADIUS,
  LOCAL_EMISSIVE_MULT,
  MODE_TINT,
  NAMETAG_ASPECT,
  NAMETAG_BASE_W,
  NAMETAG_MAX_SCALE,
  NAMETAG_MIN_SCALE,
  NAMETAG_REF_DISTANCE,
  NAMETAG_SCALE_QUANTUM,
  NAMETAG_Y,
  SHOULDER_X,
  SHOULDER_Y,
  TOUCH_POSE_MS,
} from './characterConstants';
import { faceTextures, type FaceExpression } from './faceTextures';
import { buildNametag, type Nametag } from './nametag';
import { ArmPoseMachine, type PoseInput, type PoseKind } from './armPose';
import { FpvViewmodel } from './fpvViewmodel';

const UP_AXIS = new THREE.Vector3(0, 1, 0);

// Per-frame drivers from GameSession (all optional/derivable so LOCAL and
// REMOTE share the same call site — see gameSession).
export interface CharacterFrame {
  readonly dtMs: number;
  readonly feet: Vec3; // group world position (x, jump-height y, z)
  readonly facing: number; // radians (yaw convention); snapped for local, lerped for remote
  readonly snapFacing: boolean; // true = local (instant), false = remote (shortest-arc slerp)
  readonly speed01: number; // 0..1 horizontal speed (walk-swing scale)
  readonly airborne: boolean; // jump overlay + (remote) dive-less
  readonly charging: boolean; // LOCAL only — remotes can't see charge (see report)
  readonly serving: boolean; // this player holds the ball during serve phase
  readonly ballWorld: Vec3 | null; // ball render position, for touch/serve aim
  readonly cameraPos: THREE.Vector3; // for constant-size nametag scaling
}

// M2.5 §2/§3 — one player's full visual: tinted capsule body + cartoon head +
// two procedurally-posed arms + billboard nametag, wrapped in a Group whose
// rotation.y is the player's facing. Reused for local and remote players.
export class PlayerCharacter {
  readonly group: THREE.Group;
  private readonly body: THREE.Mesh;
  private readonly head: THREE.Mesh;
  private readonly headMaterial: THREE.MeshStandardMaterial;
  private readonly leftPivot: THREE.Object3D;
  private readonly rightPivot: THREE.Object3D;
  private readonly armMeshes: THREE.Mesh[];
  private readonly nametag: Nametag;
  private readonly pose: ArmPoseMachine;
  private readonly faces: Record<FaceExpression, THREE.CanvasTexture>;
  private viewmodel: FpvViewmodel | undefined; // §6 FPV self-arms (local only)

  private currentMode: TouchMode = 'dig';
  private currentFacing: number;
  private diveUntilMs = 0;
  private diveTotalMs = 800;
  private touchUntilMs = 0;
  private touchMode: TouchMode = 'dig';
  private expression: FaceExpression = 'normal';
  private expressionUntilMs = 0;
  private clockS = 0;
  private hiddenSelf = false;
  private nametagFactor = 0; // last applied (quantized) nametag scale step

  constructor(
    name: string,
    private readonly isLocal: boolean,
    initialFacing: number,
  ) {
    this.group = new THREE.Group();
    this.group.rotation.order = 'YXZ'; // yaw first, then dive pitch
    this.currentFacing = initialFacing;
    this.group.rotation.y = initialFacing;

    // Body capsule — geometry translated up so the group origin is the feet
    // (GameSession sets group.position.y = jump height directly).
    const bodyGeo = new THREE.CapsuleGeometry(CAPSULE_RADIUS, CAPSULE_CYLINDER_HEIGHT, 4, 8);
    bodyGeo.translate(0, CAPSULE_RADIUS + CAPSULE_CYLINDER_HEIGHT / 2, 0);
    this.body = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({ color: MODE_TINT.dig }));

    // Head + cartoon face.
    this.faces = faceTextures();
    this.headMaterial = new THREE.MeshStandardMaterial({ color: HEAD_COLOR, map: this.faces.normal });
    this.head = new THREE.Mesh(new THREE.SphereGeometry(HEAD_RADIUS, 16, 12), this.headMaterial);
    this.head.position.set(0, HEAD_CENTER_Y, 0);
    // The sphere's texture center (u=0.5) faces +X; rotate -90° about Y so the
    // drawn face instead points forward (+Z = the character's facing).
    this.head.rotation.y = -Math.PI / 2;

    // Two arms, each a capsule hanging from a shoulder pivot.
    this.leftPivot = this.buildArm(-1);
    this.rightPivot = this.buildArm(1);
    this.armMeshes = [this.leftPivot.children[0] as THREE.Mesh, this.rightPivot.children[0] as THREE.Mesh];

    // Nametag floats above the head; on the Y axis so facing yaw never shifts it.
    this.nametag = buildNametag(name);
    this.nametag.sprite.position.set(0, NAMETAG_Y, 0);

    this.group.add(this.body, this.head, this.leftPivot, this.rightPivot, this.nametag.sprite);
    this.pose = new ArmPoseMachine(this.leftPivot, this.rightPivot);
    this.setMode('dig');
  }

  private buildArm(sideSign: number): THREE.Object3D {
    const pivot = new THREE.Object3D();
    pivot.position.set(sideSign * SHOULDER_X, SHOULDER_Y, 0);
    const geo = new THREE.CapsuleGeometry(ARM_RADIUS, ARM_LENGTH - 2 * ARM_RADIUS, 3, 6);
    geo.translate(0, -ARM_LENGTH / 2, 0); // hang below the pivot
    const arm = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: ARM_COLOR }));
    pivot.add(arm);
    return pivot;
  }

  // M2.2 §2.3 — retint by mode (local body also glows so you spot yourself).
  setMode(mode: TouchMode): void {
    this.currentMode = mode;
    const tint = MODE_TINT[mode];
    const material = this.body.material as THREE.MeshStandardMaterial;
    material.color.setHex(tint);
    if (this.isLocal) {
      material.emissive.setHex(tint);
      material.emissiveIntensity = LOCAL_EMISSIVE_MULT;
    }
  }

  // §2 — 1s happy face after own PERFECT, 1s dazed after own WHIFF/dive_fail.
  showHappy(): void {
    this.setExpression('happy', HAPPY_FACE_MS);
  }
  showDazed(): void {
    this.setExpression('dazed', DAZED_FACE_MS);
  }

  private setExpression(expr: FaceExpression, durationMs: number): void {
    this.expression = expr;
    this.expressionUntilMs = performance.now() + durationMs;
    this.headMaterial.map = this.faces[expr];
    this.headMaterial.needsUpdate = true;
  }

  // §3 touch-burst: reach toward the ball for TOUCH_POSE_MS. mode selects the
  // scoop/push/chop variant; the aim is resolved to the ball's live position.
  triggerTouch(mode: TouchMode): void {
    this.touchMode = mode;
    this.touchUntilMs = performance.now() + TOUCH_POSE_MS;
  }

  // §3 dive: arms thrown forward + body lunge for `durationMs` (DIVE_LOCK_S).
  triggerDive(durationMs: number): void {
    this.diveTotalMs = durationMs;
    this.diveUntilMs = performance.now() + durationMs;
  }

  // M2.7 §6 — attach the FPV viewmodel (own simplified arms) to the render
  // camera so it moves with the view. Local player only; call once after
  // construction. Hidden until setFirstPersonSelf(true) toggles into FPV.
  attachFpvViewmodel(camera: THREE.Camera): void {
    if (!this.isLocal || this.viewmodel) return;
    this.viewmodel = new FpvViewmodel();
    camera.add(this.viewmodel.group);
    this.viewmodel.setVisible(false);
  }

  // FPV self-presentation (§2 / M2.7 §6): hide own head/body/arms/nametag (so
  // nothing fills the first-person view) and instead show the camera-mounted
  // viewmodel arms, driven by the same pose machine.
  setFirstPersonSelf(hidden: boolean): void {
    if (this.hiddenSelf === hidden) return;
    this.hiddenSelf = hidden;
    this.group.visible = !hidden;
    this.viewmodel?.setVisible(hidden);
  }

  update(frame: CharacterFrame): void {
    this.group.position.set(frame.feet.x, frame.feet.y, frame.feet.z);
    this.clockS += frame.dtMs / 1000;
    this.updateFacing(frame);
    this.updateExpression();

    const now = performance.now();
    const diving = now < this.diveUntilMs;
    const touching = now < this.touchUntilMs;
    const kind = this.resolveKind(diving, touching, frame);
    const localAim = this.resolveAim(kind, frame);
    // §6 — 0→1 progress through the release action window (touch kind).
    const touchProgress01 = touching
      ? Math.min(1, Math.max(0, (TOUCH_POSE_MS - (this.touchUntilMs - now)) / TOUCH_POSE_MS))
      : 0;

    const input: PoseInput = {
      kind,
      mode: touching ? this.touchMode : this.currentMode,
      speed01: Math.min(1, Math.max(0, frame.speed01)),
      airborne: frame.airborne,
      clockS: this.clockS,
      touchProgress01,
      localAim,
    };
    this.pose.update(input, frame.dtMs);
    this.updateViewmodel(input, frame.dtMs);
    this.applyDiveTilt(diving);
    this.updateNametagScale(frame.cameraPos);
  }

  // §6 — drive the FPV viewmodel with the SAME character-local pose input as the
  // third-person rig. The viewmodel host group is yawed 180° (FPV_VM_GROUP_YAW)
  // so the pose machine's character-local +Z ("forward toward the ball") points
  // into the camera view (−Z); that single yaw is the ONLY mirror needed. An
  // earlier extra X-negation here was a DOUBLE mirror — with the corrected
  // camera/HUD basis it swung the arms to the OPPOSITE screen side from the ball
  // (aim left → arms swing right). Removed; regression-guarded by the "FPV
  // viewmodel arm swing" cases in test/cameraBasis.test.ts.
  private updateViewmodel(input: PoseInput, dtMs: number): void {
    if (!this.viewmodel) return;
    this.viewmodel.update(input, dtMs);
  }

  // Priority (§3): dive > touch(0.4s) > serveHold > charging > idle/move.
  private resolveKind(diving: boolean, touching: boolean, frame: CharacterFrame): PoseKind {
    if (diving) return 'dive';
    if (touching) return 'touch';
    if (frame.serving) return 'serveHold';
    if (frame.charging) return 'charging';
    return 'idle';
  }

  // Resolve the world aim (ball for touch/serve, facing-forward for dive) into
  // character-local space for the pose machine.
  private resolveAim(kind: PoseKind, frame: CharacterFrame): THREE.Vector3 | null {
    if (kind === 'dive') {
      // Thrown forward (local +Z) and slightly down along the lunge.
      return new THREE.Vector3(0, -0.2, 1);
    }
    if (kind !== 'touch') return null;
    // M2.8 §3 — AIR SWING: a release with no ball in contact range still plays
    // the action, aimed along the player's FACING (character-local +Z) instead
    // of at a ball. With a ball present the swing tracks it (below).
    if (!frame.ballWorld) return new THREE.Vector3(0, 0, 1);
    const world = new THREE.Vector3(
      frame.ballWorld.x - frame.feet.x,
      frame.ballWorld.y - (frame.feet.y + SHOULDER_Y),
      frame.ballWorld.z - frame.feet.z,
    );
    if (world.lengthSq() < 1e-6) return null;
    // World -> character-local: undo the facing yaw.
    return world.applyAxisAngle(UP_AXIS, -this.currentFacing);
  }

  private updateFacing(frame: CharacterFrame): void {
    if (frame.snapFacing) {
      this.currentFacing = frame.facing;
    } else {
      // Shortest-arc approach — wrap the delta to (-π, π] so we never spin the
      // long way round (no 2π flips on a facing that crosses ±π).
      let delta = frame.facing - this.currentFacing;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      const alpha = Math.min(1, (FACING_LERP_RATE * frame.dtMs) / 1000);
      this.currentFacing += delta * alpha;
    }
    this.group.rotation.y = this.currentFacing;
  }

  private updateExpression(): void {
    if (this.expression === 'normal') return;
    if (performance.now() >= this.expressionUntilMs) {
      this.expression = 'normal';
      this.headMaterial.map = this.faces.normal;
      this.headMaterial.needsUpdate = true;
    }
  }

  // Eased body lunge (§3): full pitch at the start of the dive, recovering to
  // upright as the window expires. Positive rotation.x pitches the head forward.
  private applyDiveTilt(diving: boolean): void {
    if (!diving) {
      if (this.group.rotation.x !== 0) this.group.rotation.x = 0;
      return;
    }
    const remaining = this.diveUntilMs - performance.now();
    const t = Math.min(1, Math.max(0, remaining / this.diveTotalMs)); // 1 -> 0
    this.group.rotation.x = DIVE_BODY_TILT_RAD * t;
  }

  // Keep the nametag a ~constant apparent size: scale by camera distance so it
  // reads at range without ballooning up close (spec §2 legibility choice).
  private updateNametagScale(cameraPos: THREE.Vector3): void {
    const dx = this.group.position.x - cameraPos.x;
    const dy = this.group.position.y + NAMETAG_Y - cameraPos.y;
    const dz = this.group.position.z - cameraPos.z;
    const distance = Math.hypot(dx, dy, dz);
    const raw = Math.min(
      NAMETAG_MAX_SCALE,
      Math.max(NAMETAG_MIN_SCALE, distance / NAMETAG_REF_DISTANCE),
    );
    // Quantize to a step so sub-pixel distance wobble doesn't re-scale (shimmer)
    // every frame; only touch the sprite when the step actually changes.
    const factor = Math.round(raw / NAMETAG_SCALE_QUANTUM) * NAMETAG_SCALE_QUANTUM;
    if (factor === this.nametagFactor) return;
    this.nametagFactor = factor;
    this.nametag.sprite.scale.set(NAMETAG_BASE_W * factor, NAMETAG_BASE_W * NAMETAG_ASPECT * factor, 1);
  }

  // §4 teardown — dispose all GPU resources this character owns (faces are
  // shared module singletons and intentionally NOT disposed here).
  dispose(): void {
    this.body.geometry.dispose();
    (this.body.material as THREE.Material).dispose();
    this.head.geometry.dispose();
    this.headMaterial.dispose();
    for (const arm of this.armMeshes) {
      arm.geometry.dispose();
      (arm.material as THREE.Material).dispose();
    }
    this.viewmodel?.dispose();
    this.nametag.dispose();
  }
}
